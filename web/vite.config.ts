import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';
import { resolve, sep } from 'node:path';
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { hostname as machineName, networkInterfaces } from 'node:os';
import { styleText } from 'node:util';

/**
 * The dev server listens on every interface, not just loopback, and prints the links
 * that actually work from another machine — this is a game you want to open on the
 * laptop next to you, a TV or a tablet. `--host 127.0.0.1` on the command line still
 * wins (the screenshot harnesses pass it); in that case the LAN block is replaced by
 * an honest note instead of advertising URLs that nothing is listening on.
 */

const DEV_PORT = 5178;

type Style = Parameters<typeof styleText>[0];
const COLOR = !process.env.NO_COLOR && (process.stdout.isTTY === true || process.env.FORCE_COLOR === '1');

function paint(style: Style, text: string): string {
  if (!COLOR) return text;
  try {
    return styleText(style, text);
  } catch {
    return text;
  }
}

type LanAddress = { iface: string; address: string; family: 'IPv4' | 'IPv6' };

function lanAddresses(): LanAddress[] {
  const found: LanAddress[] = [];
  for (const [iface, details] of Object.entries(networkInterfaces())) {
    for (const detail of details ?? []) {
      if (detail.internal) continue;
      const family: LanAddress['family'] = detail.family === 'IPv6' ? 'IPv6' : 'IPv4';
      // Link-local IPv6 needs a scope id (fe80::1%eth0) before a browser can dial it.
      if (family === 'IPv6' && /^fe80:/i.test(detail.address)) continue;
      found.push({ iface, address: detail.address, family });
    }
  }
  // IPv4 first: that is what an ordinary cable/wifi device on the LAN will reach.
  return found.sort((a, b) => (a.family === b.family ? a.iface.localeCompare(b.iface) : a.family === 'IPv4' ? -1 : 1));
}

const isWildcard = (host: string | null): boolean => host === '0.0.0.0' || host === '::';

const urlFor = (host: string, port: number): string =>
  `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;

function printNetworkLinks(server: ViteDevServer | PreviewServer): void {
  const info = (msg: string): void => server.config.logger.info(msg);
  const bound = server.httpServer?.address() ?? null;
  const address = typeof bound === 'object' && bound !== null ? bound.address : null;
  const port = typeof bound === 'object' && bound !== null ? bound.port : DEV_PORT;

  if (!isWildcard(address)) {
    info(
      paint('dim', `  ➜  Network: loopback only (${address ?? 'unknown'}) — drop --host to serve the LAN`),
    );
    return;
  }

  const addresses = lanAddresses();
  if (addresses.length === 0) {
    info(paint('dim', '  ➜  Network: this machine has no non-loopback address, so no LAN link to print'));
    return;
  }

  info('');
  info(`  ${paint('green', '➜')}  ${paint('bold', 'On your network')} ${paint('dim', '(listening on every interface)')}`);
  for (const entry of addresses) {
    info(`     ${paint('cyan', urlFor(entry.address, port))}  ${paint('dim', `${entry.iface} · ${entry.family}`)}`);
  }
  const base = urlFor(addresses[0].address, port);
  info(`     ${paint('cyan', `${base}?auto=1`)}  ${paint('dim', 'skip the menu, straight into a game')}`);
  info(`     ${paint('cyan', `${base}?auto=1&two=1`)}  ${paint('dim', 'two-player split screen')}`);
  info(paint('dim', '     keyboard + mouse required — there are no touch controls yet'));
  info(paint('dim', `     nothing to install on the other device; if it cannot connect, allow TCP ${port} in the firewall`));
}

/** Print the LAN links right after Vite prints its own Local/Network lines. */
function lanAccess(): Plugin {
  const wrap = (server: ViteDevServer | PreviewServer): void => {
    const original = server.printUrls.bind(server);
    server.printUrls = (): void => {
      original();
      printNetworkLinks(server);
    };
  };
  return {
    name: 'rf:lan-access',
    configureServer(server) {
      wrap(server);
    },
    configurePreviewServer(server) {
      wrap(server);
    },
  };
}

/**
 * The original soundtrack lives in `./music` at the repo root — data, not code, so it sits
 * outside the web project. In dev this middleware serves it at `/music/`; on build it is
 * copied into `dist/music`. If the folder is missing everything degrades gracefully: the
 * audio layer falls back to its synthesised themes and these routes just 404.
 */
function musicAssets(): Plugin {
  const dir = resolve(import.meta.dirname, '../music');
  return {
    name: 'rf:music-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/music/')) return next();
        const rel = decodeURIComponent(url.slice('/music/'.length).split('?')[0]);
        const file = resolve(dir, rel);
        if (file !== dir && !file.startsWith(dir + sep)) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(file);
        } catch {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        if (!st.isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', String(st.size));
        res.setHeader('Cache-Control', 'public, max-age=3600');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (existsSync(dir)) cpSync(dir, resolve(import.meta.dirname, 'dist/music'), { recursive: true });
    },
  };
}

// Vite lets IP literals and `localhost` through unconditionally; a machine name such as
// `devbox` or `devbox.local` has to be listed explicitly or the request is rejected.
const HOST_ALIASES = (() => {
  const name = machineName();
  return name ? [...new Set([name, `${name}.local`])] : [];
})();

export default defineConfig({
  base: './',
  server: {
    host: true, // all interfaces, IPv4 + IPv6 (equivalent to `vite --host`)
    port: DEV_PORT,
    strictPort: true,
    allowedHosts: HOST_ALIASES,
  },
  preview: {
    host: true,
    allowedHosts: HOST_ALIASES,
  },
  plugins: [lanAccess(), musicAssets()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        editor: resolve(import.meta.dirname, 'editor.html'),
      },
    },
  },
  // wasm-bindgen output lives in src/sim/pkg and is imported with ?url / direct
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: { exclude: ['three'] },
});
