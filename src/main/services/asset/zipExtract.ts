/**
 * zipExtract — 随机读的 ZIP 解包器，配 zipStoreStream 用，也能解普通的 deflate 包。
 *
 * 为什么不用 adm-zip：它把整个包读进内存，取回的工程整包动辄几十 GB。
 * 这里只把中央目录读进内存（每个条目几十字节），数据按条目从文件里定位后流式写出，
 * 常驻内存与包大小无关。
 *
 * 支持：存储（method 0）与 deflate（method 8）、ZIP64（大文件 / 大偏移 / 多条目）、
 * 数据描述符（本地头里大小为零也无所谓 —— 一律以中央目录为准，这也是所有主流解包器的做法）。
 * 每个条目解完都核对字节数和 CRC32，坏包不会悄悄解出一半。
 *
 * 路径安全沿用 safeExtract 的规则：越界条目直接失败，不解出任何东西到目标目录之外。
 */
import { promises as fsp, createReadStream, createWriteStream, existsSync } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import * as zlib from 'zlib'
import { resolveSafeEntryPath, UnsafeZipEntryError } from '../project/safeExtract'
import { crc32 } from './zipStoreStream'

export interface ZipEntryInfo {
  name: string
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  isDirectory: boolean
}

export interface ZipExtractProgress {
  bytesDone: number
  bytesTotal: number
  entriesDone: number
  entriesTotal: number
}

export interface ZipExtractResult {
  fileCount: number
  bytes: number
  /** 包内顶层目录名（去重）。工程整包只有一个：工程名 */
  topLevelDirs: string[]
}

const SIG_CENTRAL_HEADER = 0x02014b50
const SIG_END_OF_CENTRAL_DIR = 0x06054b50
const SIG_ZIP64_END_OF_CENTRAL_DIR = 0x06064b50
const SIG_ZIP64_END_LOCATOR = 0x07064b50
const SIG_LOCAL_HEADER = 0x04034b50

const U16_MAX = 0xffff
const U32_MAX = 0xffffffff
const END_RECORD_MIN = 22
/** EOCD 后面最多跟 65535 字节注释，往回最多扫这么多 */
const END_RECORD_SCAN_MAX = END_RECORD_MIN + U16_MAX
const ZIP64_END_LOCATOR_LENGTH = 20

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

function readUInt64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`ZIP64 value too large at offset ${offset}`)
  }
  return Number(value)
}

async function readAt(handle: fsp.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done)
    if (bytesRead === 0) throw new Error(`Unexpected end of zip file at ${position + done}`)
    done += bytesRead
  }
  return buffer
}

interface CentralDirectoryLocation {
  offset: number
  size: number
  entryCount: number
}

async function locateCentralDirectory(
  handle: fsp.FileHandle,
  fileSize: number
): Promise<CentralDirectoryLocation> {
  if (fileSize < END_RECORD_MIN) throw new Error('Not a zip file: too small')
  const tailLength = Math.min(fileSize, END_RECORD_SCAN_MAX)
  const tailStart = fileSize - tailLength
  const tail = await readAt(handle, tailStart, tailLength)

  let eocdIndex = -1
  for (let i = tail.length - END_RECORD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_END_OF_CENTRAL_DIR) {
      eocdIndex = i
      break
    }
  }
  if (eocdIndex < 0) throw new Error('Not a zip file: end of central directory not found')

  let entryCount = tail.readUInt16LE(eocdIndex + 10)
  let size = tail.readUInt32LE(eocdIndex + 12)
  let offset = tail.readUInt32LE(eocdIndex + 16)

  const needsZip64 = entryCount === U16_MAX || size === U32_MAX || offset === U32_MAX
  const locatorIndex = eocdIndex - ZIP64_END_LOCATOR_LENGTH
  const hasLocator = locatorIndex >= 0 && tail.readUInt32LE(locatorIndex) === SIG_ZIP64_END_LOCATOR
  if (hasLocator) {
    const zip64EndOffset = readUInt64(tail, locatorIndex + 8)
    const record = await readAt(handle, zip64EndOffset, 56)
    if (record.readUInt32LE(0) !== SIG_ZIP64_END_OF_CENTRAL_DIR) {
      throw new Error('Corrupt zip: ZIP64 end of central directory signature mismatch')
    }
    entryCount = readUInt64(record, 32)
    size = readUInt64(record, 40)
    offset = readUInt64(record, 48)
  } else if (needsZip64) {
    throw new Error('Corrupt zip: ZIP64 fields present but locator missing')
  }

  return { offset, size, entryCount }
}

function parseCentralDirectory(directory: Buffer, expectedCount: number): ZipEntryInfo[] {
  const entries: ZipEntryInfo[] = []
  let cursor = 0
  while (cursor + 46 <= directory.length && entries.length < expectedCount) {
    if (directory.readUInt32LE(cursor) !== SIG_CENTRAL_HEADER) {
      throw new Error(`Corrupt zip: central header signature mismatch at ${cursor}`)
    }
    const flags = directory.readUInt16LE(cursor + 8)
    const method = directory.readUInt16LE(cursor + 10)
    const crc = directory.readUInt32LE(cursor + 16)
    let compressedSize = directory.readUInt32LE(cursor + 20)
    let uncompressedSize = directory.readUInt32LE(cursor + 24)
    const nameLength = directory.readUInt16LE(cursor + 28)
    const extraLength = directory.readUInt16LE(cursor + 30)
    const commentLength = directory.readUInt16LE(cursor + 32)
    let localHeaderOffset = directory.readUInt32LE(cursor + 42)

    const nameStart = cursor + 46
    const extraStart = nameStart + nameLength
    const extraEnd = extraStart + extraLength
    const entryEnd = extraEnd + commentLength
    // subarray 越界不抛错，会**悄悄截断** —— 于是坏掉的长度字段会变成一个看着正常的
    // 短名字，游标也跟着错位。最后一条坏掉时连条数校验都发现不了，只能在这里拦。
    if (entryEnd > directory.length) {
      throw new Error(
        `Corrupt zip: central header at ${cursor} claims ${entryEnd - cursor} bytes, ` +
          `only ${directory.length - cursor} remain`
      )
    }

    const nameBytes = directory.subarray(nameStart, extraStart)
    // bit 11 置位是 UTF-8；没置位的老包规范上是 CP437，但今天的实际情况是几乎所有
    // 写入器都写 UTF-8 而不置位，按 UTF-8 解更接近真相。flags 只在这里用一次。
    void flags
    const name = nameBytes.toString('utf8')

    let extraCursor = extraStart
    while (extraCursor + 4 <= extraEnd) {
      const headerId = directory.readUInt16LE(extraCursor)
      const dataSize = directory.readUInt16LE(extraCursor + 2)
      const dataStart = extraCursor + 4
      if (headerId === 0x0001) {
        // ZIP64 扩展信息：只有溢出的字段才在这里出现，顺序固定
        let fieldCursor = dataStart
        if (uncompressedSize === U32_MAX && fieldCursor + 8 <= dataStart + dataSize) {
          uncompressedSize = readUInt64(directory, fieldCursor)
          fieldCursor += 8
        }
        if (compressedSize === U32_MAX && fieldCursor + 8 <= dataStart + dataSize) {
          compressedSize = readUInt64(directory, fieldCursor)
          fieldCursor += 8
        }
        if (localHeaderOffset === U32_MAX && fieldCursor + 8 <= dataStart + dataSize) {
          localHeaderOffset = readUInt64(directory, fieldCursor)
        }
      }
      extraCursor = dataStart + dataSize
    }

    entries.push({
      name,
      method,
      crc32: crc >>> 0,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: name.endsWith('/') || name.endsWith('\\')
    })
    cursor = entryEnd
  }
  if (entries.length !== expectedCount) {
    throw new Error(`Corrupt zip: expected ${expectedCount} entries, parsed ${entries.length}`)
  }
  return entries
}

/** 只读中央目录，不碰数据 */
export async function readZipEntries(zipPath: string): Promise<ZipEntryInfo[]> {
  const handle = await fsp.open(zipPath, 'r')
  try {
    const { size: fileSize } = await handle.stat()
    const location = await locateCentralDirectory(handle, fileSize)
    if (location.offset + location.size > fileSize) {
      throw new Error('Corrupt zip: central directory points past end of file')
    }
    const directory = await readAt(handle, location.offset, location.size)
    return parseCentralDirectory(directory, location.entryCount)
  } finally {
    await handle.close()
  }
}

class CountingCrcTransform extends Transform {
  bytes = 0
  crc = 0
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.bytes += chunk.length
    this.crc = crc32(chunk, this.crc)
    callback(null, chunk)
  }
}

async function dataOffsetOf(handle: fsp.FileHandle, entry: ZipEntryInfo): Promise<number> {
  const header = await readAt(handle, entry.localHeaderOffset, 30)
  if (header.readUInt32LE(0) !== SIG_LOCAL_HEADER) {
    throw new Error(`Corrupt zip: local header signature mismatch for ${entry.name}`)
  }
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  return entry.localHeaderOffset + 30 + nameLength + extraLength
}

export interface ZipExtractOptions {
  onProgress?: (progress: ZipExtractProgress) => void
}

/**
 * 解到 destDir。包内路径原样落地（工程整包的顶层就是工程目录名）。
 * 目标已存在的文件会被覆盖 —— 取回同一个工程两次，第二次就是想覆盖。
 */
export async function extractZip(
  zipPath: string,
  destDir: string,
  options: ZipExtractOptions = {}
): Promise<ZipExtractResult> {
  const entries = await readZipEntries(zipPath)
  const files = entries.filter((entry) => !entry.isDirectory)
  const bytesTotal = files.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
  const topLevelDirs = new Set<string>()

  // 先把所有目标路径算出来并校验，越界的一个都不解
  const targets = new Map<ZipEntryInfo, string>()
  for (const entry of entries) {
    const target = resolveSafeEntryPath(destDir, entry.name)
    if (target === null) throw new UnsafeZipEntryError(entry.name)
    targets.set(entry, target)
    // 判「有没有目录层级」要用归一化之后的名字：有些老写入器用 `\` 当分隔符，
    // 拿原始名字判 includes('/') 会漏掉，顶层目录名就此丢失
    const normalizedName = entry.name.replace(/\\/g, '/')
    const firstSegment = normalizedName.split('/')[0]
    if (firstSegment && normalizedName.includes('/')) topLevelDirs.add(firstSegment)
  }

  const handle = await fsp.open(zipPath, 'r')
  let bytesDone = 0
  let entriesDone = 0
  // 中途失败要把自己**新建**的东西删掉 —— 解到一半的工程留在用户挑的目录里，
  // 比直接报错更难收拾（他不知道哪些是好的、哪些是残的）。
  // 覆盖掉的旧文件不在此列：那是用户上一份，删了就真没了。
  const written: string[] = []
  // 几千个文件常常只落在几十个目录里，每个文件都 mkdir 一遍是纯浪费
  const madeDirs = new Set<string>()
  /** 这次新建出来的目录（原来就有的不算），失败时按最深优先 rmdir 掉 */
  const freshDirs = new Set<string>()
  /** @returns 这个目录是不是这次新建的 —— 是的话，里面的文件必然也都是新的 */
  const ensureDir = async (dir: string): Promise<boolean> => {
    if (madeDirs.has(dir)) return freshDirs.has(dir)
    // 先从最深处往上找到第一个已经存在的祖先：中间这几级都是 mkdir(recursive)
    // 顺手建出来的，不一一记下来的话回滚时它们会互相挡着删不掉
    const missing: string[] = []
    let cursor = dir
    while (!existsSync(cursor)) {
      missing.push(cursor)
      const parent = path.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
    await fsp.mkdir(dir, { recursive: true })
    madeDirs.add(dir)
    for (const created of missing) {
      madeDirs.add(created)
      freshDirs.add(created)
    }
    return missing.length > 0
  }
  try {
    for (const entry of entries) {
      const target = targets.get(entry)!
      if (entry.isDirectory) {
        await ensureDir(target)
        continue
      }
      // 压缩方式先认再建文件：反过来会在不认识的条目上留下一个 0 字节空壳。
      // 不管压缩后有多长都要认 —— 长度为零也可能是条伪造的条目
      if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
        throw new Error(`Unsupported compression method ${entry.method} for ${entry.name}`)
      }
      const parentIsFresh = await ensureDir(path.dirname(target))

      const dataStart = await dataOffsetOf(handle, entry)
      const source =
        entry.compressedSize === 0
          ? null
          : createReadStream('', {
              fd: handle.fd,
              autoClose: false,
              start: dataStart,
              end: dataStart + entry.compressedSize - 1,
              highWaterMark: 1024 * 1024
            })
      // 只登记「这次新建的」文件。目标已经存在说明用户上一份就摆在这儿：
      // 覆盖已经发生了没法回头，但**再把它删掉**会连他原来能用的那份一起弄没。
      // 父目录是这次新建的话，里面不可能有旧文件，这一步的 stat 就能省掉 ——
      // 解进空目录（最常见的取回场景）时一次都不用问磁盘。
      const isNewFile = parentIsFresh || !existsSync(target)
      const counter = new CountingCrcTransform()
      const sink = createWriteStream(target)
      if (isNewFile) written.push(target)

      if (source === null) {
        // 空文件：只建文件
        await new Promise<void>((resolve, reject) => {
          sink.on('error', reject)
          sink.end(resolve)
        })
      } else if (entry.method === METHOD_STORE) {
        await pipeline(source, counter, sink)
      } else {
        await pipeline(source, zlib.createInflateRaw(), counter, sink)
      }

      if (counter.bytes !== entry.uncompressedSize) {
        throw new Error(
          `Corrupt zip: ${entry.name} expected ${entry.uncompressedSize} bytes, got ${counter.bytes}`
        )
      }
      if (entry.uncompressedSize > 0 && counter.crc >>> 0 !== entry.crc32) {
        throw new Error(`Corrupt zip: CRC mismatch for ${entry.name}`)
      }

      bytesDone += entry.uncompressedSize
      entriesDone++
      options.onProgress?.({ bytesDone, bytesTotal, entriesDone, entriesTotal: files.length })
    }
  } catch (err) {
    for (const file of written) {
      await fsp.unlink(file).catch(() => undefined)
    }
    // 再把这次新建的空目录收掉，最深的先删。rmdir 碰到非空会失败 ——
    // 正好，用户自己原本就有东西的目录不会被顺手带走
    for (const dir of [...freshDirs].sort((a, b) => b.length - a.length)) {
      await fsp.rmdir(dir).catch(() => undefined)
    }
    throw err
  } finally {
    await handle.close()
  }

  return { fileCount: files.length, bytes: bytesDone, topLevelDirs: Array.from(topLevelDirs) }
}
