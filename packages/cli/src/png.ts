/**
 * PNG 核验。
 *
 * ## 为什么要自己验，而不是信工具说的 saved: true
 *
 * 「收到了图片附件」和「用户要的那个文件已经躺在磁盘上、能打开」是两件事。
 * 中间隔着：插件那侧的写盘、跨进程的路径、磁盘空间、权限。任何一环断掉，
 * 工具照样回 `saved: true`（它说的是它那一步成功了），而用户打开 `--output`
 * 得到的是一个 0 字节的文件，或者根本没有文件。
 *
 * 报告成功之前必须自己看一眼：文件在不在、是不是空的、是不是 PNG、
 * 尺寸对不对得上。
 *
 * ## 只读头部，不解码
 *
 * PNG 的前 8 个字节是固定签名，紧跟着的 IHDR 块头 25 字节里就有宽高。
 * 判断「这是不是一张完整的 PNG」不需要把像素解出来，也就不需要引一个图像库。
 */

/** PNG 签名：\x89 P N G \r \n \x1a \n */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 签名 8 + 长度 4 + 类型 4 + 宽 4 + 高 4 = 24，读到这里就够了 */
const HEADER_BYTES = 24

export interface PngInfo {
  width: number
  height: number
  bytes: number
}

export class PngError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PngError'
  }
}

/**
 * 从文件头认出这是一张 PNG，并读出它声明的宽高。
 *
 * @throws {PngError} 不是 PNG、被截断、或者尺寸不合理
 */
export function readPngHeader(buffer: Buffer): PngInfo {
  if (buffer.byteLength === 0) {
    throw new PngError('文件是空的（0 字节）。')
  }
  if (buffer.byteLength < HEADER_BYTES) {
    throw new PngError(`文件只有 ${buffer.byteLength} 字节，连 PNG 文件头都不完整。`)
  }
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError('文件不是 PNG（签名对不上）。')
  }

  // 第一个块必须是 IHDR，这是 PNG 规范的硬性要求
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new PngError('PNG 的第一个数据块不是 IHDR，文件已损坏。')
  }

  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)

  if (width <= 0 || height <= 0) {
    throw new PngError(`PNG 声明的尺寸不合理：${width}×${height}。`)
  }

  return { width, height, bytes: buffer.byteLength }
}

/**
 * 把文件里读到的尺寸和工具报的尺寸对一遍。
 *
 * 对不上说明我们拿到的不是这次那张图 —— 最可能是读到了上一次遗留的文件。
 * 那种情况下「成功」二字最危险：用户会拿一张旧图去判断他刚改的东西。
 *
 * 工具没报尺寸（旧插件）时不比对，也不因此判失败：说不准的时候不说。
 */
export function assertMatchesReported(
  actual: PngInfo,
  reported: { width: number | null; height: number | null }
): void {
  if (reported.width === null || reported.height === null) return

  if (actual.width !== reported.width || actual.height !== reported.height) {
    throw new PngError(
      `文件里的尺寸（${actual.width}×${actual.height}）和引擎报的` +
        `（${reported.width}×${reported.height}）对不上，这可能不是这次拍的那张图。`
    )
  }
}
