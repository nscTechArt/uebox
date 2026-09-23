/** @vitest-environment node */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEVICE_FILE, readOrCreateDeviceId } from './deviceId'

const freshDir = (): string => mkdtempSync(join(tmpdir(), 'creator-plan-device-'))

describe('readOrCreateDeviceId', () => {
  it('第一次生成一个随机 UUID 存下；之后一直用它', async () => {
    const dir = freshDir()
    const first = await readOrCreateDeviceId(dir)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(await readOrCreateDeviceId(dir)).toBe(first)
    // 文件里只有这一项，没有机器名、用户名
    expect(JSON.parse(readFileSync(join(dir, DEVICE_FILE), 'utf-8'))).toEqual({ device_id: first })
  })

  it('两台设备（两个 userData）各是各的', async () => {
    expect(await readOrCreateDeviceId(freshDir())).not.toBe(await readOrCreateDeviceId(freshDir()))
  })

  it('读坏了、被改成不认识的形状：重新生成并覆盖', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, DEVICE_FILE), '{ not json')
    const repaired = await readOrCreateDeviceId(dir)
    expect(repaired).toMatch(/^[0-9a-f-]{36}$/)
    expect(await readOrCreateDeviceId(dir)).toBe(repaired)

    writeFileSync(join(dir, DEVICE_FILE), JSON.stringify({ device_id: 'DESKTOP-陈东' }))
    expect(await readOrCreateDeviceId(dir)).not.toBe('DESKTOP-陈东')
  })

  it('存不下（目录是个文件）也照样回一个，这次连接不受影响', async () => {
    const dir = freshDir()
    const blocked = join(dir, 'not-a-dir')
    writeFileSync(blocked, '')
    expect(await readOrCreateDeviceId(blocked)).toMatch(/^[0-9a-f-]{36}$/)
  })
})
