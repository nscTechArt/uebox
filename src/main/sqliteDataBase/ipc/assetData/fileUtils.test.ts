/**
 * 快速文件哈希必须是确定的。
 *
 * 大文件只取头/中/尾三段参与哈希，而三次读盘是并发发出的 ——
 * 原来是谁先读完谁先喂给哈希器，顺序由 OS 调度决定，于是同一个文件今天和明天
 * 算出来的「指纹」可能不一样。后果：导入查重漏判（磁盘上多出一份 2GB 拷贝）、
 * 网络库「内容相同自动跳过」误判（反复弹覆盖确认框）。
 */
import { createHash } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { calculateFastFileHash } from './fileUtils'

const SAMPLE_SIZE = 64 * 1024

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fast-hash-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 造一个大到会走「三段采样」分支的文件，三段内容各不相同 */
function writeLargeFile(name: string, marker: string): string {
  const path = join(dir, name)
  const size = SAMPLE_SIZE * 6
  const buffer = Buffer.alloc(size, 0x41)
  buffer.write(`HEAD-${marker}`, 0)
  buffer.write(`MIDDLE-${marker}`, Math.floor(size / 2))
  buffer.write(`TAIL-${marker}`, size - SAMPLE_SIZE)
  writeFileSync(path, buffer)
  return path
}

describe('calculateFastFileHash', () => {
  it('同一个文件反复算，结果必须一样', async () => {
    const path = writeLargeFile('big.bin', 'x')

    const hashes = await Promise.all(Array.from({ length: 12 }, () => calculateFastFileHash(path)))

    // 旧实现：三段谁先读完谁先喂哈希 —— 多跑几次就会出现不同的值
    expect(new Set(hashes).size).toBe(1)
  })

  it('并发算同一个文件也不会互相串（各自独立的 buffer 与 fd）', async () => {
    const path = writeLargeFile('big2.bin', 'y')

    const [a, b, c] = await Promise.all([
      calculateFastFileHash(path),
      calculateFastFileHash(path),
      calculateFastFileHash(path)
    ])

    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('内容不同的文件哈希必须不同', async () => {
    const one = writeLargeFile('one.bin', 'one')
    const two = writeLargeFile('two.bin', 'two')

    expect(await calculateFastFileHash(one)).not.toBe(await calculateFastFileHash(two))
  })

  it('三段的顺序是 头 → 中 → 尾，且文件大小参与哈希', async () => {
    const path = writeLargeFile('order.bin', 'z')
    const size = SAMPLE_SIZE * 6
    const buffer = Buffer.alloc(size, 0x41)
    buffer.write('HEAD-z', 0)
    buffer.write('MIDDLE-z', Math.floor(size / 2))
    buffer.write('TAIL-z', size - SAMPLE_SIZE)

    const expected = createHash('md5')
    expected.update(Buffer.from(String(size)))
    expected.update(buffer.subarray(0, SAMPLE_SIZE))
    const middlePos = Math.floor(size / 2) - Math.floor(SAMPLE_SIZE / 2)
    expected.update(buffer.subarray(middlePos, middlePos + SAMPLE_SIZE))
    expected.update(buffer.subarray(size - SAMPLE_SIZE, size))

    expect(await calculateFastFileHash(path)).toBe(expected.digest('hex'))
  })

  it('小文件走整文件读取，同样是确定的', async () => {
    const path = join(dir, 'small.bin')
    writeFileSync(path, Buffer.from('hello world'))

    const hashes = await Promise.all(Array.from({ length: 5 }, () => calculateFastFileHash(path)))

    expect(new Set(hashes).size).toBe(1)
  })
})
