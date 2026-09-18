/**
 * zipStoreStream — 边读边发的「存储模式」ZIP 打包器（支持 ZIP64）。
 *
 * 为什么自己写而不用现成库：
 *   - 仓库里只有 adm-zip，它把整个包读进内存，几十 GB 的工程根本装不下。
 *   - 我们要的是**流**：一个 Readable，边读源文件边吐 ZIP 字节，直接 pipe 进
 *     HTTP 请求体，不落临时文件、不占内存（常驻只有一个读缓冲）。
 *   - 不压缩（method 0）。UE 资产本来就是压缩过的，再压一遍只烧 CPU 不省字节；
 *     不压缩时吞吐只受磁盘和网卡限制，这正是「整包上传」要的。
 *
 * 为什么能提前算出总长度：存储模式下每个字节的位置都是确定的（头 + 数据 + 描述符），
 * 只有 CRC 要读完文件才知道，而 CRC 放在**数据描述符**（通用标志位 3）和中央目录里，
 * 不影响长度。于是可以先给 HTTP 一个精确的 Content-Length，服务端按清单校验大小。
 *
 * 兼容性：布局与 Go 的 archive/zip 流式写法一致 —— 本地头里 CRC/大小置零、
 * 靠描述符和中央目录给出真值；单文件 ≥ 4 GiB 或偏移 ≥ 4 GiB 时用 ZIP64 扩展字段。
 * 7-Zip、WinRAR、Windows 资源管理器都按中央目录解包，读得出来。
 */
import { createReadStream } from 'fs'
import { Readable } from 'stream'
import * as zlib from 'zlib'

export interface ZipStoreSource {
  /** 源文件绝对路径 */
  absPath: string
  /** 包内路径，用 `/` 分隔，例如 `MyProject/Content/Maps/Lobby.umap` */
  zipPath: string
  /** 文件大小（字节）。打包时会核对，读到的字节数不一致会直接报错 */
  size: number
  /** 修改时间，写进 DOS 时间字段 */
  mtime: Date
  /**
   * 目录条目（zipPath 以 `/` 结尾、size 恒为 0）。
   * 空目录在 zip 里没有条目就等于不存在，取回时会凭空少掉，所以要显式写一条。
   * 目录没有数据可读，打包时跳过开流。
   */
  isDirectory?: boolean
}

interface PlannedEntry {
  source: ZipStoreSource
  nameBytes: Buffer
  /** 单文件大小需要 ZIP64（≥ 4 GiB） */
  zip64Size: boolean
  /** 本地头偏移需要 ZIP64（≥ 4 GiB） */
  zip64Offset: boolean
  localHeaderOffset: number
  /** 数据描述符长度：16 或 24（ZIP64 用 8 字节大小） */
  descriptorLength: number
  /** 中央目录条目里 ZIP64 扩展字段的总长度（含 4 字节头），0 表示没有 */
  centralExtraLength: number
}

export interface ZipStorePlan {
  entries: PlannedEntry[]
  centralDirectoryOffset: number
  centralDirectorySize: number
  needsZip64EndRecord: boolean
  /** 整个 ZIP 的精确字节数，可直接当 Content-Length */
  totalSize: number
}

const SIG_LOCAL_HEADER = 0x04034b50
const SIG_DATA_DESCRIPTOR = 0x08074b50
const SIG_CENTRAL_HEADER = 0x02014b50
const SIG_END_OF_CENTRAL_DIR = 0x06054b50
const SIG_ZIP64_END_OF_CENTRAL_DIR = 0x06064b50
const SIG_ZIP64_END_LOCATOR = 0x07064b50

const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

/** 通用标志：bit 3 = 大小/CRC 在数据描述符里；bit 11 = 文件名是 UTF-8 */
const GENERAL_FLAGS = 0x0808
const METHOD_STORE = 0
const VERSION_DEFAULT = 20
const VERSION_ZIP64 = 45

const LOCAL_HEADER_FIXED = 30
const CENTRAL_HEADER_FIXED = 46
const END_RECORD_LENGTH = 22
const ZIP64_END_RECORD_LENGTH = 56
const ZIP64_END_LOCATOR_LENGTH = 20

/** 读源文件的缓冲。1 MiB 一块，网卡和磁盘都吃得饱，CRC 调用次数也少 */
const READ_HIGH_WATER_MARK = 1024 * 1024

export function planZipStore(sources: ZipStoreSource[]): ZipStorePlan {
  const entries: PlannedEntry[] = []
  let offset = 0

  for (const source of sources) {
    if (!Number.isInteger(source.size) || source.size < 0) {
      throw new Error(`Invalid size for ${source.zipPath}: ${source.size}`)
    }
    // 目录条目在打包时会跳过读源，一个字节都不吐。这里要是给了非零 size，
    // 版面就按那个长度排了，算出来的 totalSize（直接当 Content-Length 用）
    // 会比实际吐出去的字节多一截 —— 传上去是个断头包，中央目录偏移全错。
    if (source.isDirectory) {
      if (source.size !== 0) {
        throw new Error(`Directory entry must have size 0: ${source.zipPath} (${source.size})`)
      }
      if (!source.zipPath.endsWith('/')) {
        throw new Error(`Directory entry name must end with '/': ${source.zipPath}`)
      }
    }
    const nameBytes = Buffer.from(source.zipPath, 'utf8')
    if (nameBytes.length > U16_MAX) {
      throw new Error(`Zip entry name too long: ${source.zipPath}`)
    }
    const zip64Size = source.size >= U32_MAX
    const zip64Offset = offset >= U32_MAX
    const descriptorLength = zip64Size ? 24 : 16
    const zip64FieldBytes = (zip64Size ? 16 : 0) + (zip64Offset ? 8 : 0)
    const centralExtraLength = zip64FieldBytes > 0 ? 4 + zip64FieldBytes : 0

    entries.push({
      source,
      nameBytes,
      zip64Size,
      zip64Offset,
      localHeaderOffset: offset,
      descriptorLength,
      centralExtraLength
    })
    offset += LOCAL_HEADER_FIXED + nameBytes.length + source.size + descriptorLength
  }

  const centralDirectoryOffset = offset
  let centralDirectorySize = 0
  for (const entry of entries) {
    centralDirectorySize += CENTRAL_HEADER_FIXED + entry.nameBytes.length + entry.centralExtraLength
  }

  const needsZip64EndRecord =
    entries.length >= U16_MAX ||
    centralDirectorySize >= U32_MAX ||
    centralDirectoryOffset >= U32_MAX

  const totalSize =
    centralDirectoryOffset +
    centralDirectorySize +
    (needsZip64EndRecord ? ZIP64_END_RECORD_LENGTH + ZIP64_END_LOCATOR_LENGTH : 0) +
    END_RECORD_LENGTH

  return { entries, centralDirectoryOffset, centralDirectorySize, needsZip64EndRecord, totalSize }
}

/** DOS 时间戳：1980 年之前的一律钉在 1980-01-01，ZIP 表示不了更早的 */
export function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = date.getFullYear()
  if (!Number.isFinite(year) || year < 1980) {
    return { dosTime: 0, dosDate: (0 << 9) | (1 << 5) | 1 }
  }
  const clampedYear = Math.min(year, 1980 + 127)
  const dosDate = ((clampedYear - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  return { dosTime, dosDate }
}

type Crc32Fn = (data: Buffer, previous?: number) => number

/**
 * Node 22.2 起 zlib 自带原生 crc32，1 GB/s 量级；更老的运行时退回查表实现。
 * 打包 25 GB 时 CRC 是唯一的 CPU 开销，原生实现能让它不成为瓶颈。
 */
const nativeCrc32 = (zlib as unknown as { crc32?: Crc32Fn }).crc32

let crcTable: Int32Array | null = null
function tableCrc32(data: Buffer, previous = 0): number {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = previous ^ -1
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

export const crc32: Crc32Fn = typeof nativeCrc32 === 'function' ? nativeCrc32 : tableCrc32

function writeUInt64LE(buffer: Buffer, value: number, offset: number): void {
  buffer.writeBigUInt64LE(BigInt(value), offset)
}

function buildLocalHeader(entry: PlannedEntry): Buffer {
  const header = Buffer.alloc(LOCAL_HEADER_FIXED + entry.nameBytes.length)
  const { dosTime, dosDate } = toDosDateTime(entry.source.mtime)
  header.writeUInt32LE(SIG_LOCAL_HEADER, 0)
  header.writeUInt16LE(entry.zip64Size ? VERSION_ZIP64 : VERSION_DEFAULT, 4)
  header.writeUInt16LE(GENERAL_FLAGS, 6)
  header.writeUInt16LE(METHOD_STORE, 8)
  header.writeUInt16LE(dosTime, 10)
  header.writeUInt16LE(dosDate, 12)
  // CRC / 大小放数据描述符（bit 3），这里按规范置零
  header.writeUInt32LE(0, 14)
  header.writeUInt32LE(0, 18)
  header.writeUInt32LE(0, 22)
  header.writeUInt16LE(entry.nameBytes.length, 26)
  header.writeUInt16LE(0, 28)
  entry.nameBytes.copy(header, LOCAL_HEADER_FIXED)
  return header
}

function buildDataDescriptor(entry: PlannedEntry, crc: number): Buffer {
  const descriptor = Buffer.alloc(entry.descriptorLength)
  descriptor.writeUInt32LE(SIG_DATA_DESCRIPTOR, 0)
  descriptor.writeUInt32LE(crc >>> 0, 4)
  if (entry.zip64Size) {
    writeUInt64LE(descriptor, entry.source.size, 8)
    writeUInt64LE(descriptor, entry.source.size, 16)
  } else {
    descriptor.writeUInt32LE(entry.source.size, 8)
    descriptor.writeUInt32LE(entry.source.size, 12)
  }
  return descriptor
}

function buildCentralHeader(entry: PlannedEntry, crc: number): Buffer {
  const header = Buffer.alloc(
    CENTRAL_HEADER_FIXED + entry.nameBytes.length + entry.centralExtraLength
  )
  const { dosTime, dosDate } = toDosDateTime(entry.source.mtime)
  const usesZip64 = entry.zip64Size || entry.zip64Offset
  header.writeUInt32LE(SIG_CENTRAL_HEADER, 0)
  header.writeUInt16LE(usesZip64 ? VERSION_ZIP64 : VERSION_DEFAULT, 4) // version made by
  header.writeUInt16LE(usesZip64 ? VERSION_ZIP64 : VERSION_DEFAULT, 6) // version needed
  header.writeUInt16LE(GENERAL_FLAGS, 8)
  header.writeUInt16LE(METHOD_STORE, 10)
  header.writeUInt16LE(dosTime, 12)
  header.writeUInt16LE(dosDate, 14)
  header.writeUInt32LE(crc >>> 0, 16)
  header.writeUInt32LE(entry.zip64Size ? U32_MAX : entry.source.size, 20)
  header.writeUInt32LE(entry.zip64Size ? U32_MAX : entry.source.size, 24)
  header.writeUInt16LE(entry.nameBytes.length, 28)
  header.writeUInt16LE(entry.centralExtraLength, 30)
  header.writeUInt16LE(0, 32) // comment length
  header.writeUInt16LE(0, 34) // disk number start
  header.writeUInt16LE(0, 36) // internal attributes
  // 目录条目打上 FILE_ATTRIBUTE_DIRECTORY(0x10)。名字末尾的 `/` 是主要标志，
  // 但确实有读取器按外部属性认目录，不给这一位它会把条目解成一个同名的空文件
  header.writeUInt32LE(entry.source.isDirectory ? 0x10 : 0, 38) // external attributes
  header.writeUInt32LE(entry.zip64Offset ? U32_MAX : entry.localHeaderOffset, 42)
  entry.nameBytes.copy(header, CENTRAL_HEADER_FIXED)

  if (entry.centralExtraLength > 0) {
    let cursor = CENTRAL_HEADER_FIXED + entry.nameBytes.length
    header.writeUInt16LE(0x0001, cursor) // ZIP64 extended information
    header.writeUInt16LE(entry.centralExtraLength - 4, cursor + 2)
    cursor += 4
    if (entry.zip64Size) {
      writeUInt64LE(header, entry.source.size, cursor) // uncompressed
      writeUInt64LE(header, entry.source.size, cursor + 8) // compressed
      cursor += 16
    }
    if (entry.zip64Offset) {
      writeUInt64LE(header, entry.localHeaderOffset, cursor)
    }
  }
  return header
}

function buildEndRecords(plan: ZipStorePlan): Buffer {
  const parts: Buffer[] = []
  if (plan.needsZip64EndRecord) {
    const record = Buffer.alloc(ZIP64_END_RECORD_LENGTH)
    record.writeUInt32LE(SIG_ZIP64_END_OF_CENTRAL_DIR, 0)
    writeUInt64LE(record, ZIP64_END_RECORD_LENGTH - 12, 4)
    record.writeUInt16LE(VERSION_ZIP64, 12)
    record.writeUInt16LE(VERSION_ZIP64, 14)
    record.writeUInt32LE(0, 16)
    record.writeUInt32LE(0, 20)
    writeUInt64LE(record, plan.entries.length, 24)
    writeUInt64LE(record, plan.entries.length, 32)
    writeUInt64LE(record, plan.centralDirectorySize, 40)
    writeUInt64LE(record, plan.centralDirectoryOffset, 48)
    parts.push(record)

    const locator = Buffer.alloc(ZIP64_END_LOCATOR_LENGTH)
    locator.writeUInt32LE(SIG_ZIP64_END_LOCATOR, 0)
    locator.writeUInt32LE(0, 4)
    writeUInt64LE(locator, plan.centralDirectoryOffset + plan.centralDirectorySize, 8)
    locator.writeUInt32LE(1, 16)
    parts.push(locator)
  }

  const end = Buffer.alloc(END_RECORD_LENGTH)
  end.writeUInt32LE(SIG_END_OF_CENTRAL_DIR, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(Math.min(plan.entries.length, U16_MAX), 8)
  end.writeUInt16LE(Math.min(plan.entries.length, U16_MAX), 10)
  end.writeUInt32LE(Math.min(plan.centralDirectorySize, U32_MAX), 12)
  end.writeUInt32LE(Math.min(plan.centralDirectoryOffset, U32_MAX), 16)
  end.writeUInt16LE(0, 20)
  parts.push(end)
  return Buffer.concat(parts)
}

export interface ZipStoreStreamOptions {
  /** 每吐出一块数据回调一次累计字节数，给进度条用。调用方自己节流 */
  onBytes?: (bytesEmitted: number) => void
  /** 覆盖源文件读取方式，测试用 */
  openSource?: (source: ZipStoreSource) => NodeJS.ReadableStream
}

/**
 * 按 plan 生成 ZIP 字节流。
 *
 * 源文件在打包期间变了大小会直接报错让流失败 —— 宁可让这次上传失败重来，
 * 也不能吐出一个 Content-Length 对不上、中央目录也对不上的坏包。
 */
export function createZipStoreStream(
  plan: ZipStorePlan,
  options: ZipStoreStreamOptions = {}
): Readable {
  const openSource =
    options.openSource ??
    ((source: ZipStoreSource) =>
      createReadStream(source.absPath, { highWaterMark: READ_HIGH_WATER_MARK }))

  async function* generate(): AsyncGenerator<Buffer> {
    let emitted = 0
    const emit = (chunk: Buffer): Buffer => {
      emitted += chunk.length
      options.onBytes?.(emitted)
      return chunk
    }

    const crcs: number[] = []
    for (const entry of plan.entries) {
      yield emit(buildLocalHeader(entry))

      if (entry.source.isDirectory) {
        // 目录条目：只有头和描述符，没有数据，也就没有 CRC
        crcs.push(0)
        yield emit(buildDataDescriptor(entry, 0))
        continue
      }

      let crc = 0
      let bytesRead = 0
      const source = openSource(entry.source)
      for await (const raw of source as AsyncIterable<Buffer | string>) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        bytesRead += chunk.length
        if (bytesRead > entry.source.size) {
          throw new Error(
            `Source grew while packing: ${entry.source.zipPath} (expected ${entry.source.size} bytes)`
          )
        }
        crc = crc32(chunk, crc)
        yield emit(chunk)
      }
      if (bytesRead !== entry.source.size) {
        throw new Error(
          `Source shrank while packing: ${entry.source.zipPath} (expected ${entry.source.size}, read ${bytesRead})`
        )
      }
      crcs.push(crc >>> 0)
      yield emit(buildDataDescriptor(entry, crc))
    }

    for (let i = 0; i < plan.entries.length; i++) {
      yield emit(buildCentralHeader(plan.entries[i], crcs[i]))
    }
    yield emit(buildEndRecords(plan))
  }

  return Readable.from(generate(), { objectMode: false })
}
