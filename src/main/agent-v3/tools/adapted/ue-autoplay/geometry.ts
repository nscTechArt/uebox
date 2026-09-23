/**
 * 平面几何的几个小函数。UE 坐标：X 前、Y 右、Z 上；Yaw 0° 朝 +X，顺时针为正（俯视）。
 */

import type { Vec3 } from './types'

export function dist2d(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 从 a 看向 b 的 Yaw（度），与 UE 的 `FRotator::Yaw` 同一套约定 */
export function headingDeg(a: Vec3, b: Vec3): number {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
}

/** 归一到 (-180, 180] */
export function normalizeYaw(yaw: number): number {
  let value = yaw % 360
  if (value <= -180) value += 360
  if (value > 180) value -= 360
  return value
}

/** 两个朝向之间的最小夹角（带符号），b 相对 a */
export function yawDelta(a: number, b: number): number {
  return normalizeYaw(b - a)
}

/**
 * 把位置落进一个格子，用来记「去过哪」。
 *
 * 格子取 400 单位（约一个角色跑一秒）：再小的话原地抖动也算新地方，
 * 覆盖率虚高；再大的话一个房间就是一格，探索看不出区别。
 */
export const CELL_SIZE = 400

export function cellKey(p: Vec3): string {
  return `${Math.floor(p.x / CELL_SIZE)},${Math.floor(p.y / CELL_SIZE)}`
}

export function roundVec(p: Vec3): Vec3 {
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }
}

export function formatVec(p: Vec3): string {
  return `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`
}
