/**
 * 这台设备在 Creator Plan 眼里的标识：`userData/creator-plan-device.json`。
 *
 * 设备授权时带上（协议 11-connect 的 `device_id`）。同一台设备重新授权，服务端吊销这台的旧 Key、
 * 发一把新的 —— 重装应用、反复点「连接」都不会撞 Key 数上限。
 *
 * 就是一个随机 UUID，第一次连接时生成：不取硬件指纹，不含机器名、用户名这类个人信息。
 * 断开时不删（和 `creator-plan.json` 分开放就是为了这个），下次连接还是这台设备；
 * 重装应用只要 userData 还在就接着用。文件丢了、读坏了就重新生成一个 ——
 * 服务端当成一台新设备，代价是旧 Key 要用户自己去网页端吊销。
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export const DEVICE_FILE = 'creator-plan-device.json'

/** 只认自己生成的形状；手改成别的就当坏了 */
const DEVICE_ID = /^[A-Za-z0-9-]{16,64}$/

export async function readOrCreateDeviceId(userDataDir: string): Promise<string> {
  const path = join(userDataDir, DEVICE_FILE)
  try {
    const raw = JSON.parse(await fs.readFile(path, 'utf-8')) as { device_id?: unknown } | null
    if (typeof raw?.device_id === 'string' && DEVICE_ID.test(raw.device_id)) return raw.device_id
  } catch {
    // 没有或读坏了：下面重新生成
  }

  const deviceId = randomUUID()
  try {
    await fs.mkdir(userDataDir, { recursive: true })
    const temp = `${path}.tmp`
    await fs.writeFile(temp, `${JSON.stringify({ device_id: deviceId }, null, 2)}\n`, 'utf-8')
    await fs.rename(temp, path)
  } catch (error) {
    // 存不下也照常连接：这一次仍然带着它，只是下次会是另一个
    console.warn('[Creator Plan] 设备标识没存上：', error)
  }
  return deviceId
}
