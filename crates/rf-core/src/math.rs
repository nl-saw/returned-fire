//! Minimal math helpers (no external deps so the crate stays tiny & fast to build).

use core::ops::{Add, AddAssign, Div, Mul, MulAssign, Neg, Sub, SubAssign};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

pub const fn v2(x: f32, y: f32) -> Vec2 {
    Vec2 { x, y }
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };

    pub fn len(self) -> f32 {
        (self.x * self.x + self.y * self.y).sqrt()
    }
    pub fn len_sq(self) -> f32 {
        self.x * self.x + self.y * self.y
    }
    pub fn dist(self, o: Vec2) -> f32 {
        (self - o).len()
    }
    pub fn dist_sq(self, o: Vec2) -> f32 {
        (self - o).len_sq()
    }
    pub fn norm(self) -> Vec2 {
        let l = self.len();
        if l > 1e-6 {
            Vec2 {
                x: self.x / l,
                y: self.y / l,
            }
        } else {
            Vec2::ZERO
        }
    }
    pub fn dot(self, o: Vec2) -> f32 {
        self.x * o.x + self.y * o.y
    }
    pub fn cross(self, o: Vec2) -> f32 {
        self.x * o.y - self.y * o.x
    }
    pub fn rot(self, a: f32) -> Vec2 {
        let (s, c) = a.sin_cos();
        Vec2 {
            x: self.x * c - self.y * s,
            y: self.x * s + self.y * c,
        }
    }
    pub fn perp(self) -> Vec2 {
        Vec2 {
            x: -self.y,
            y: self.x,
        }
    }
    pub fn lerp(self, o: Vec2, t: f32) -> Vec2 {
        self + (o - self) * t
    }
    pub fn scale(self, k: f32) -> Vec2 {
        Vec2 {
            x: self.x * k,
            y: self.y * k,
        }
    }
    pub fn clamp_len(self, max: f32) -> Vec2 {
        let l = self.len();
        if l > max && l > 1e-6 {
            self.scale(max / l)
        } else {
            self
        }
    }
    /// Angle of the vector measured from +X towards +Y (standard maths convention).
    pub fn angle(self) -> f32 {
        self.y.atan2(self.x)
    }

    /// Compass-style heading in the vehicle convention: yaw 0 faces +Z, and the forward
    /// vector is `(sin yaw, cos yaw)`. This is NOT `angle()` — mixing the two puts every
    /// aim and steering solution 90 degrees out.
    pub fn heading(self) -> f32 {
        self.x.atan2(self.y)
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    fn add(self, o: Vec2) -> Vec2 {
        v2(self.x + o.x, self.y + o.y)
    }
}
impl Sub for Vec2 {
    type Output = Vec2;
    fn sub(self, o: Vec2) -> Vec2 {
        v2(self.x - o.x, self.y - o.y)
    }
}
impl Mul<f32> for Vec2 {
    type Output = Vec2;
    fn mul(self, k: f32) -> Vec2 {
        v2(self.x * k, self.y * k)
    }
}
impl Div<f32> for Vec2 {
    type Output = Vec2;
    fn div(self, k: f32) -> Vec2 {
        v2(self.x / k, self.y / k)
    }
}
impl Neg for Vec2 {
    type Output = Vec2;
    fn neg(self) -> Vec2 {
        v2(-self.x, -self.y)
    }
}
impl AddAssign for Vec2 {
    fn add_assign(&mut self, o: Vec2) {
        self.x += o.x;
        self.y += o.y;
    }
}
impl SubAssign for Vec2 {
    fn sub_assign(&mut self, o: Vec2) {
        self.x -= o.x;
        self.y -= o.y;
    }
}
impl MulAssign<f32> for Vec2 {
    fn mul_assign(&mut self, k: f32) {
        self.x *= k;
        self.y *= k;
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

pub const fn v3(x: f32, y: f32, z: f32) -> Vec3 {
    Vec3 { x, y, z }
}

impl Vec3 {
    pub fn len(self) -> f32 {
        (self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }
    pub fn norm(self) -> Vec3 {
        let l = self.len();
        if l > 1e-6 {
            v3(self.x / l, self.y / l, self.z / l)
        } else {
            v3(0.0, 0.0, 0.0)
        }
    }
}

impl Add for Vec3 {
    type Output = Vec3;
    fn add(self, o: Vec3) -> Vec3 {
        v3(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}
impl Sub for Vec3 {
    type Output = Vec3;
    fn sub(self, o: Vec3) -> Vec3 {
        v3(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}
impl Mul<f32> for Vec3 {
    type Output = Vec3;
    fn mul(self, k: f32) -> Vec3 {
        v3(self.x * k, self.y * k, self.z * k)
    }
}
impl AddAssign for Vec3 {
    fn add_assign(&mut self, o: Vec3) {
        self.x += o.x;
        self.y += o.y;
        self.z += o.z;
    }
}

/// Wrap an angle into (-PI, PI].
#[inline]
pub fn wrap_angle(a: f32) -> f32 {
    let mut a = a;
    while a > core::f32::consts::PI {
        a -= core::f32::consts::TAU;
    }
    while a <= -core::f32::consts::PI {
        a += core::f32::consts::TAU;
    }
    a
}

/// Rotate `from` towards `to` by at most `max_step` radians.
#[inline]
pub fn approach_angle(from: f32, to: f32, max_step: f32) -> f32 {
    let d = wrap_angle(to - from);
    if d.abs() <= max_step {
        from + d
    } else {
        from + max_step * d.signum()
    }
}

#[inline]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[inline]
pub fn clamp(v: f32, lo: f32, hi: f32) -> f32 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else if v.is_finite() {
        v
    } else {
        // Comparisons against NaN are all false, so without this branch a non-finite value
        // would fall straight through every clamp in the codebase — including the AI's
        // `clamp(err * k, -1, 1)` steer, where it would latch into yaw and velocity forever.
        lo
    }
}

#[inline]
pub fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

#[inline]
pub fn remap(x: f32, a0: f32, a1: f32, b0: f32, b1: f32) -> f32 {
    b0 + (b1 - b0) * clamp((x - a0) / (a1 - a0), 0.0, 1.0)
}

/// Deterministic, fast 32-bit PRNG (xorshift128+ style seeded mixer).
#[derive(Clone, Debug)]
pub struct Rng {
    s: [u32; 4],
}

impl Rng {
    pub fn new(seed: u32) -> Rng {
        let mut s = [seed, 0x9E37_79B9, 0x85EB_CA6B, 0xC2B2_AE35];
        // splitmix-ish warmup
        for i in 0..4 {
            let mut z = s[i].wrapping_add(0x9E37_79B9);
            z = (z ^ (z >> 16)).wrapping_mul(0x85EB_CA6B);
            z = (z ^ (z >> 13)).wrapping_mul(0xC2B2_AE35);
            s[i] = z ^ (z >> 16);
        }
        Rng { s }
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let s = &mut self.s;
        let t = s[0] ^ (s[0] << 11);
        s[0] = s[1];
        s[1] = s[2];
        s[2] = s[3];
        s[3] = s[3] ^ (s[3] >> 19) ^ t ^ (t >> 8);
        s[3]
    }

    /// Uniform in [0,1)
    #[inline]
    pub fn f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 24) as f32
    }
    /// Uniform in [-1,1)
    #[inline]
    pub fn sym(&mut self) -> f32 {
        self.f32() * 2.0 - 1.0
    }
    /// Uniform in [lo,hi)
    #[inline]
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.f32()
    }
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        if n == 0 {
            0
        } else {
            self.next_u32() % n
        }
    }
    #[inline]
    pub fn chance(&mut self, p: f32) -> bool {
        self.f32() < p
    }
}

/// 2D value noise with smooth interpolation + fbm. Deterministic, seed driven.
pub struct Noise {
    perm: [u8; 512],
}

impl Noise {
    pub fn new(seed: u32) -> Noise {
        let mut rng = Rng::new(seed);
        let mut p: [u8; 256] = [0; 256];
        for (i, slot) in p.iter_mut().enumerate() {
            *slot = i as u8;
        }
        // Fisher-Yates
        for i in (1..256).rev() {
            let j = rng.below(i as u32 + 1) as usize;
            p.swap(i, j);
        }
        let mut perm = [0u8; 512];
        for i in 0..512 {
            perm[i] = p[i & 255];
        }
        Noise { perm }
    }

    #[inline]
    fn grad_hash(&self, x: i32, y: i32) -> f32 {
        let h = self.perm[((x & 255) as usize + self.perm[(y & 255) as usize] as usize) & 511];
        (h as f32 / 255.0) * 2.0 - 1.0
    }

    pub fn value(&self, x: f32, y: f32) -> f32 {
        let xi = x.floor();
        let yi = y.floor();
        let xf = x - xi;
        let yf = y - yi;
        let u = xf * xf * (3.0 - 2.0 * xf);
        let v = yf * yf * (3.0 - 2.0 * yf);
        let (xi, yi) = (xi as i32, yi as i32);
        let a = self.grad_hash(xi, yi);
        let b = self.grad_hash(xi + 1, yi);
        let c = self.grad_hash(xi, yi + 1);
        let d = self.grad_hash(xi + 1, yi + 1);
        lerp(lerp(a, b, u), lerp(c, d, u), v)
    }

    pub fn fbm(&self, x: f32, y: f32, octaves: u32, lacunarity: f32, gain: f32) -> f32 {
        let mut amp = 1.0;
        let mut freq = 1.0;
        let mut sum = 0.0;
        let mut norm = 0.0;
        for _ in 0..octaves {
            sum += amp * self.value(x * freq, y * freq);
            norm += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        if norm > 0.0 {
            sum / norm
        } else {
            0.0
        }
    }

    /// Ridged multifractal - good for rocky terrain / cliffs.
    pub fn ridged(&self, x: f32, y: f32, octaves: u32) -> f32 {
        let mut amp = 1.0;
        let mut freq = 1.0;
        let mut sum = 0.0;
        let mut norm = 0.0;
        for _ in 0..octaves {
            let n = 1.0 - self.value(x * freq, y * freq).abs();
            sum += amp * n * n;
            norm += amp;
            amp *= 0.5;
            freq *= 2.0;
        }
        if norm > 0.0 {
            sum / norm
        } else {
            0.0
        }
    }
}
