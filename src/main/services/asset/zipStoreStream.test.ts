// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { Readable } from 'stream'
import AdmZip from 'adm-zip'
import {
  createZipStoreStream,
  crc32,
  planZipStore,
  toDosDateTime,
  type ZipStoreSource
} from './zipStoreStream'

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function makeSources(dir: string, files: Record<string, Buffer>): ZipStoreSource[] {
  return Object.entries(files).map(([rel, content]) => {
    const absPath = path.join(dir, rel.replace(/\//g, path.sep))
    mkdirSync(path.dirname(absPath), { recursive: true })
    writeFileSync(absPath, content)
    const st = statSync(absPath)
    return { absPath, zipPath: `Proj/${rel}`, size: st.size, mtime: st.mtime }
  })
}

describe('zipStoreStream', () => {
  it('produces a zip that adm-zip reads back byte-for-byte, with exact planned length', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zipstore-'))
    try {
      const big = Buffer.alloc(3 * 1024 * 1024 + 17)
      for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff
      const files = {
        'a.uasset': Buffer.from('hello uasset'),
        'Content/Maps/Lobby.umap': big,
        'Content/中文 目录/空文件.txt': Buffer.alloc(0)
      }
      const sources = makeSources(dir, files)
      const plan = planZipStore(sources)
      const bytes = await collect(createZipStoreStream(plan))

      expect(bytes.length).toBe(plan.totalSize)

      const zip = new AdmZip(bytes)
      const entries = zip.getEntries()
      expect(entries.map((e) => e.entryName).sort()).toEqual(
        Object.keys(files)
          .map((k) => `Proj/${k}`)
          .sort()
      )
      for (const [rel, content] of Object.entries(files)) {
        const entry = zip.getEntry(`Proj/${rel}`)
        expect(entry).toBeTruthy()
        expect(entry!.getData().equals(content)).toBe(true)
        expect(entry!.header.crc >>> 0).toBe(crc32(content) >>> 0)
        expect(entry!.header.method).toBe(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports cumulative bytes for progress and fails if a source changes size mid-way', async () => {
    const source: ZipStoreSource = {
      absPath: 'virtual',
      zipPath: 'Proj/x.bin',
      size: 10,
      mtime: new Date('2024-05-06T07:08:09')
    }
    const plan = planZipStore([source])
    const seen: number[] = []
    const ok = await collect(
      createZipStoreStream(plan, {
        onBytes: (n) => seen.push(n),
        openSource: () => Readable.from([Buffer.alloc(4, 1), Buffer.alloc(6, 2)])
      })
    )
    expect(ok.length).toBe(plan.totalSize)
    expect(seen[seen.length - 1]).toBe(plan.totalSize)
    expect(seen.every((n, i) => i === 0 || n > seen[i - 1])).toBe(true)

    await expect(
      collect(
        createZipStoreStream(plan, { openSource: () => Readable.from([Buffer.alloc(11, 1)]) })
      )
    ).rejects.toThrow(/grew while packing/)
    await expect(
      collect(createZipStoreStream(plan, { openSource: () => Readable.from([Buffer.alloc(3, 1)]) }))
    ).rejects.toThrow(/shrank while packing/)
  })

  it('switches to ZIP64 fields for entries at or beyond 4 GiB and for far offsets', () => {
    const fourGiB = 0x100000000
    const huge: ZipStoreSource = {
      absPath: 'h',
      zipPath: 'Proj/huge.pak',
      size: fourGiB + 5,
      mtime: new Date()
    }
    const after: ZipStoreSource = {
      absPath: 'a',
      zipPath: 'Proj/after.bin',
      size: 3,
      mtime: new Date()
    }
    const plan = planZipStore([huge, after])

    expect(plan.entries[0].zip64Size).toBe(true)
    expect(plan.entries[0].descriptorLength).toBe(24)
    expect(plan.entries[0].centralExtraLength).toBe(4 + 16)
    // 第二个条目本身很小，但它的本地头偏移已经过了 4 GiB，中央目录要用 ZIP64 记偏移
    expect(plan.entries[1].zip64Size).toBe(false)
    expect(plan.entries[1].zip64Offset).toBe(true)
    expect(plan.entries[1].centralExtraLength).toBe(4 + 8)
    expect(plan.needsZip64EndRecord).toBe(true)

    const expectedTotal = plan.centralDirectoryOffset + plan.centralDirectorySize + 56 + 20 + 22
    expect(plan.totalSize).toBe(expectedTotal)
    expect(plan.centralDirectoryOffset).toBe(
      30 +
        Buffer.byteLength(huge.zipPath) +
        huge.size +
        24 +
        (30 + Buffer.byteLength(after.zipPath) + after.size + 16)
    )
  })

  it('marks directory entries with the directory attribute bit', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zipstore-'))
    try {
      const filePath = path.join(dir, 'a.txt')
      writeFileSync(filePath, 'x')
      const plan = planZipStore([
        { absPath: dir, zipPath: 'Proj/Empty/', size: 0, mtime: new Date(), isDirectory: true },
        { absPath: filePath, zipPath: 'Proj/a.txt', size: 1, mtime: new Date() }
      ])
      const bytes = await collect(createZipStoreStream(plan))
      expect(bytes.length).toBe(plan.totalSize)

      // 中央目录第一条就是目录条目，外部属性要带 FILE_ATTRIBUTE_DIRECTORY(0x10)
      const cdOffset = plan.centralDirectoryOffset
      expect(bytes.readUInt32LE(cdOffset)).toBe(0x02014b50)
      expect(bytes.readUInt32LE(cdOffset + 38) & 0x10).toBe(0x10)

      const zip = new AdmZip(bytes)
      expect(zip.getEntries().map((e) => e.entryName)).toContain('Proj/Empty/')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a directory entry that would reserve bytes it never emits', () => {
    // isDirectory 跳过读源，size 非零的话 totalSize 会比实际吐出去的多一截 ——
    // 那个数直接当 Content-Length 用，传上去就是个断头包
    expect(() =>
      planZipStore([
        { absPath: 'd', zipPath: 'Proj/Dir/', size: 10, mtime: new Date(), isDirectory: true }
      ])
    ).toThrow(/Directory entry must have size 0/)
    expect(() =>
      planZipStore([
        { absPath: 'd', zipPath: 'Proj/Dir', size: 0, mtime: new Date(), isDirectory: true }
      ])
    ).toThrow(/must end with/)
  })

  it('keeps the small-archive layout free of ZIP64 records', () => {
    const plan = planZipStore([
      { absPath: 'a', zipPath: 'a', size: 1, mtime: new Date() },
      { absPath: 'b', zipPath: 'b', size: 2, mtime: new Date() }
    ])
    expect(plan.needsZip64EndRecord).toBe(false)
    expect(plan.entries.every((e) => e.centralExtraLength === 0 && e.descriptorLength === 16)).toBe(
      true
    )
  })

  it('clamps DOS timestamps to the representable range', () => {
    expect(toDosDateTime(new Date('1970-01-01T00:00:00'))).toEqual({
      dosTime: 0,
      dosDate: (1 << 5) | 1
    })
    const { dosDate, dosTime } = toDosDateTime(new Date(2024, 4, 6, 7, 8, 9))
    expect(dosDate).toBe(((2024 - 1980) << 9) | (5 << 5) | 6)
    expect(dosTime).toBe((7 << 11) | (8 << 5) | (9 >> 1))
  })
})
