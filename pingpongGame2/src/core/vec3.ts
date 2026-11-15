import type { Vec3 } from './types.ts'

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z })

export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z })

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })

export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s })

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z

export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)

export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export const normalize = (a: Vec3): Vec3 => {
  const len = length(a)
  return len > 1e-8 ? { x: a.x / len, y: a.y / len, z: a.z / len } : { x: 0, y: 0, z: 0 }
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export const lerpV = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
})

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value

/** 确定性伪随机数（mulberry32），便于服务端与客户端复现同一局 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 在 [min, max) 区间内取随机数 */
export const rand = (rng: () => number, min: number, max: number): number => min + rng() * (max - min)
