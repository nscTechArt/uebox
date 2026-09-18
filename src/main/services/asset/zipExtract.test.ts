// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { Readable } from 'stream'
import AdmZip from 'adm-zip'
import { createZipStoreStream, planZipStore, type ZipStoreSource } from './zipStoreStream'
import { extractZip, readZipEntries } from './zipExtract'
import { UnsafeZipEntryError } from '../project/safeExtract'

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

const FILES: Record<string, Buffer> = {
  'Proj/Proj.uproject': Buffer.from('{"FileVersion":3}'),
  'Proj/Content/Maps/Lobby.umap': (() => {
    const b = Buffer.alloc(2 * 1024 * 1024 + 333)
    for (let i = 0; i < b.length; i++) b[i] = (i * 13 + 5) & 0xff
    return b
  })(),
  'Proj/Content/中文/空.txt': Buffer.alloc(0),
  'Proj/Config/DefaultEngine.ini': Buffer.from('[Core]\nA=1\n')
}

function writeSources(dir: string): ZipStoreSource[] {
  return Object.entries(FILES).map(([zipPath, content]) => {
    const absPath = path.join(dir, 'src', zipPath.replace(/\//g, path.sep))
    mkdirSync(path.dirname(absPath), { recursive: true })
    writeFileSync(absPath, content)
    const st = statSync(absPath)
    return { absPath, zipPath, size: st.size, mtime: st.mtime }
  })
}

async function writeStoreArchive(dir: string): Promise<string> {
  const plan = planZipStore(writeSources(dir))
  const bytes = await collect(createZipStoreStream(plan))
  const zipPath = path.join(dir, 'Proj.zip')
  writeFileSync(zipPath, bytes)
  return zipPath
}

function expectExtracted(dest: string): void {
  for (const [zipPath, content] of Object.entries(FILES)) {
    const target = path.join(dest, zipPath.replace(/\//g, path.sep))
    expect(existsSync(target), zipPath).toBe(true)
    expect(readFileSync(target).equals(content), zipPath).toBe(true)
  }
}

describe('zipExtract', () => {
  it('extracts a store-mode archive produced by zipStoreStream and verifies every byte', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zipx-'))
    try {
      const zipPath = await writeStoreArchive(dir)
      const dest = path.join(dir, 'out')
      const progress: number[] = []
      const result = await extractZip(zipPath, dest, {
        onProgress: (p) => progress.push(p.entriesDone)
      })
      expect(result.fileCount).toBe(4)
      expect(result.topLevelDirs).toEqual(['Proj'])
      expect(result.bytes).toBe(Object.values(FILES).reduce((s, b) => s + b.length, 0))
      expect(progress[progress.length - 1]).toBe(4)
      expectExtracted(dest)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('extracts deflate archives written by other tools (adm-zip)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zipx-'))
    try {
      const zip = new AdmZip()
      for (const [zipPath, content] of Object.entries(FILES)) zip.addFile(zipPath, content)
      const zipPath = path.join(dir, 'deflate.zip')
      zip.writeZip(zipPath)

      const entries = await readZipEntries(zipPath)
      expect(
        entries
          .filter((e) => !e.isDirectory)
          .map((e) => e.name)
          .sort()
      ).toEqual(Object.keys(FILES).sort())
      const dest = path.join(dir, 'out')
      const result = await extractZip(zipPath, dest)
      expect(result.fileCount).toBe(4)
      expectExtracted(dest)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses archives with entries escaping the destination before writing anything', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zipx-'))
    try {
      // adm-zip 会把 ../ 洗掉，要造越界条目得用自己的写入器（它不校验包内路径）
      mkdirSync(path.join(dir, 'src'))
      const okPath = path.join(dir, 'src', 'ok.txt')
      const evilPath = path.join(dir, 'src', 'evil.txt')
      writeFileSync(okPath, 'ok')
      writeFileSync(evilPath, 'evil')
      const plan = planZipStore([
        { absPath: okPath, zipPath: 'Proj/ok.txt', size: 2, mtime: new Date() },
        { absPath: evilPath, zipPath: '../evil.txt', size: 4, mtime: new Date() }
      ])
      const zipPath = path.join(dir, 'evil.zip')
      writeFileSync(zipPath, await collect(createZipStoreStream(plan)))
      const dest = path.join(dir, 'out')
      await expect(extractZip(zipPath, dest)).rejects.toBeInstanceOf(UnsafeZipEntryError)
      expect(existsSync(path.join(dest, 'Proj', 'ok.txt'))).toBe(false)
      expect(existsSync(path.join(dir, 'evil.txt'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the central directory through a ZIP64 end record', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zipx-'))
    try {
      const zipPath = await writeStoreArchive(dir)
      const original = readFileSync(zipPath)
      const eocd = original.subarray(original.length - 22)
      const body = original.subarray(0, original.length - 22)
      const entryCount = eocd.readUInt16LE(10)
      const cdSize = eocd.readUInt32LE(12)
      const cdOffset = eocd.readUInt32LE(16)

      // 把普通 EOCD 改写成 ZIP64 形态：记录 + 定位器 + 全是 0xFFFF 占位的 EOCD
      const zip64Record = Buffer.alloc(56)
      zip64Record.writeUInt32LE(0x06064b50, 0)
      zip64Record.writeBigUInt64LE(BigInt(44), 4)
      zip64Record.writeUInt16LE(45, 12)
      zip64Record.writeUInt16LE(45, 14)
      zip64Record.writeBigUInt64LE(BigInt(entryCount), 24)
      zip64Record.writeBigUInt64LE(BigInt(entryCount), 32)
      zip64Record.writeBigUInt64LE(BigInt(cdSize), 40)
      zip64Record.writeBigUInt64LE(BigInt(cdOffset), 48)
      const locator = Buffer.alloc(20)
      locator.writeUInt32LE(0x07064b50, 0)
      locator.writeBigUInt64LE(BigInt(body.length), 8)
      locator.writeUInt32LE(1, 16)
      const markerEocd = Buffer.from(eocd)
      markerEocd.writeUInt16LE(0xffff, 8)
      markerEocd.writeUInt16LE(0xffff, 10)
      markerEocd.writeUInt32LE(0xffffffff, 12)
      markerEocd.writeUInt32LE(0xffffffff, 16)

      const zip64Path = path.join(dir, 'zip64.zip')
      writeFileSync(zip64Path, Buffer.concat([body, zip64Record, locator, markerEocd]))

      const entries = await readZipEntries(zip64Path)
      expect(entries.map((e) => e.name).sort()).toEqual(Object.keys(FILES).sort())
      const dest = path.join(dir, 'out64')
      await extractZip(zip64Path, dest)
      expectExtracted(dest)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a central directory whose last entry claims more bytes than remain', async () => {
    // subarray 越界会悄悄截断，条数校验又刚好被最后一条满足 —— 只能在解析时拦
    const dir = mkdtempSync(path.join(tmpdir(), 'zipx-'))
    try {
      const zipPath = await writeStoreArchive(dir)
      const bytes = readFileSync(zipPath)
      const eocdStart = bytes.length - 22
      const cdOffset = bytes.readUInt32LE(eocdStart + 16)

      // 找到最后一条中央目录条目，把它的 nameLength 撑爆
      let cursor = cdOffset
      let lastEntry = cursor
      while (cursor + 46 <= eocdStart && bytes.readUInt32LE(cursor) === 0x02014b50) {
        lastEntry = cursor
        cursor +=
          46 +
          bytes.readUInt16LE(cursor + 28) +
          bytes.readUInt16LE(cursor + 30) +
          bytes.readUInt16LE(cursor + 32)
      }
      bytes.writeUInt16LE(60000, lastEntry + 28)

      const corruptPath = path.join(dir, 'oversized-name.zip')
      writeFileSync(corruptPath, bytes)
      await expect(readZipEntries(corruptPath)).rejects.toThrow(/Corrupt zip: central header/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rolls back the files it already wrote when an entry fails mid-extraction', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zipx-'))
    try {
      const zipPath = await writeStoreArchive(dir)
      const bytes = readFileSync(zipPath)
      const entries = await readZipEntries(zipPath)
      const big = entries.find((e) => e.name.endsWith('Lobby.umap'))!
      const dataStart = big.localHeaderOffset + 30 + Buffer.byteLength(big.name)
      bytes[dataStart + 1000] ^= 0xff
      const corruptPath = path.join(dir, 'corrupt.zip')
      writeFileSync(corruptPath, bytes)

      const dest = path.join(dir, 'outr')
      await expect(extractZip(corruptPath, dest)).rejects.toThrow(/CRC mismatch/)
      // 解到一半的文件不能留在用户目录里
      for (const zipPathName of Object.keys(FILES)) {
        expect(existsSync(path.join(dest, zipPathName)), zipPathName).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes the directories it created when rollback runs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zipx-'))
    try {
      const zipPath = await writeStoreArchive(dir)
      const bytes = readFileSync(zipPath)
      const entries = await readZipEntries(zipPath)
      const big = entries.find((e) => e.name.endsWith('Lobby.umap'))!
      const dataStart = big.localHeaderOffset + 30 + Buffer.byteLength(big.name)
      bytes[dataStart + 1000] ^= 0xff
      const corruptPath = path.join(dir, 'corrupt.zip')
      writeFileSync(corruptPath, bytes)

      const dest = path.join(dir, 'outd')
      await expect(extractZip(corruptPath, dest)).rejects.toThrow(/CRC mismatch/)
      // 失败后不该留下一棵空目录骨架
      expect(existsSync(path.join(dest, 'Proj'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves files that already existed in the destination alone when rollback runs', async () => {
    // 回滚只该删自己新建的。用户上一次取回的那份就摆在这儿，
    // 解压失败再把它删掉，等于连他原来能用的工程一起弄没了
    const dir = mkdtempSync(path.join(tmpdir(), 'zipx-'))
    try {
      const zipPath = await writeStoreArchive(dir)
      const bytes = readFileSync(zipPath)
      const entries = await readZipEntries(zipPath)
      const big = entries.find((e) => e.name.endsWith('Lobby.umap'))!
      const dataStart = big.localHeaderOffset + 30 + Buffer.byteLength(big.name)
      bytes[dataStart + 1000] ^= 0xff
      const corruptPath = path.join(dir, 'corrupt.zip')
      writeFileSync(corruptPath, bytes)

      // 先放一份「上一次取回」的文件在目标位置
      const dest = path.join(dir, 'outp')
      const survivor = path.join(dest, 'Proj', 'Proj.uproject')
      mkdirSync(path.dirname(survivor), { recursive: true })
      writeFileSync(survivor, 'previous copy')

      await expect(extractZip(corruptPath, dest)).rejects.toThrow(/CRC mismatch/)
      expect(existsSync(survivor)).toBe(true)
      // 新建的那些还是要清掉
      expect(existsSync(path.join(dest, 'Proj', 'Config', 'DefaultEngine.ini'))).toBe(false)
      // 用户原本就有的目录不能被顺手 rmdir 掉（它还装着 survivor）
      expect(existsSync(path.dirname(survivor))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects top-level directories in archives written with backslash separators', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zipx-'))
    try {
      mkdirSync(path.join(dir, 'src'), { recursive: true })
      const filePath = path.join(dir, 'src', 'a.txt')
      writeFileSync(filePath, 'hello')
      const plan = planZipStore([
        { absPath: filePath, zipPath: 'Proj\\Content\\a.txt', size: 5, mtime: new Date() }
      ])
      const zipPath = path.join(dir, 'backslash.zip')
      writeFileSync(zipPath, await collect(createZipStoreStream(plan)))

      const dest = path.join(dir, 'outb')
      const result = await extractZip(zipPath, dest)
      expect(result.topLevelDirs).toEqual(['Proj'])
      expect(readFileSync(path.join(dest, 'Proj', 'Content', 'a.txt'), 'utf8')).toBe('hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails loudly on a corrupted payload instead of writing a wrong file silently', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zipx-'))
    try {
      const zipPath = await writeStoreArchive(dir)
      const bytes = readFileSync(zipPath)
      const entries = await readZipEntries(zipPath)
      const big = entries.find((e) => e.name.endsWith('Lobby.umap'))!
      // 本地头 30 字节 + 文件名后面就是数据；翻一个字节
      const dataStart = big.localHeaderOffset + 30 + Buffer.byteLength(big.name)
      bytes[dataStart + 1000] ^= 0xff
      const corruptPath = path.join(dir, 'corrupt.zip')
      writeFileSync(corruptPath, bytes)
      await expect(extractZip(corruptPath, path.join(dir, 'outc'))).rejects.toThrow(/CRC mismatch/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
