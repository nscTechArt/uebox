// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { describeLaunchFailure, findFreePort, stderrTail } from '../../scripts/cdp-launch.mjs'

const servers = []
// 纯 JS 测试没有类型可标，和 scripts/ 下同理（见 eslint.config.mjs）
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function occupy(port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    servers.push(server)
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r()))))
})

describe('findFreePort', () => {
  it('returns the requested port when it is bindable', async () => {
    const port = await occupy(0)
    servers.pop().close()
    await new Promise((r) => setTimeout(r, 10))
    expect(await findFreePort(port)).toBe(port)
  })

  it('skips an occupied port and moves on to the next one', async () => {
    const taken = await occupy(0)
    const found = await findFreePort(taken, { attempts: 16 })
    expect(found).not.toBe(taken)
    expect(found).toBeGreaterThan(taken)
    expect(found).toBeLessThan(taken + 16)
  })

  it('falls back to an OS-assigned port when nothing in the range binds', async () => {
    const taken = await occupy(0)
    const found = await findFreePort(taken, { attempts: 1 })
    expect(found).not.toBe(taken)
    expect(found).toBeGreaterThan(0)
  })

  it('rejects a non-numeric port instead of scanning from NaN', async () => {
    await expect(findFreePort('abc')).rejects.toThrow('调试端口不合法')
  })
})

describe('stderrTail', () => {
  it('keeps only the last N non-empty lines across chunk boundaries and CRLF', () => {
    const tail = stderrTail(3)
    tail.push(Buffer.from('one\r\ntw'))
    tail.push('o\n\nthree\nfour\n')
    expect(tail.lines()).toEqual(['two', 'three', 'four'])
  })

  it('includes a trailing partial line', () => {
    const tail = stderrTail(5)
    tail.push('[ERROR:devtools_http_handler.cc] bind() failed: 0x271D')
    expect(tail.lines()).toEqual(['[ERROR:devtools_http_handler.cc] bind() failed: 0x271D'])
  })
})

describe('describeLaunchFailure', () => {
  it('says the process exited and quotes stderr', () => {
    const tail = stderrTail()
    tail.push('bind() returned an error: 0x271D\n')
    const text = describeLaunchFailure({ exit: { code: 1, signal: null }, tail })
    expect(text).toContain('已退出（code 1）')
    expect(text).toContain('| bind() returned an error: 0x271D')
  })

  it('says the process is alive when it has not exited and stderr is empty', () => {
    const text = describeLaunchFailure({ exit: null, tail: stderrTail() })
    expect(text).toContain('仍在运行')
    expect(text).toContain('没有输出任何 stderr')
  })
})
