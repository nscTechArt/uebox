import { getSharp } from '../utils/sharpLoader'

// The upload API allows 10 MB; leave room for multipart overhead and decimal limits.
const MAX_UPLOAD_BYTES = 9_500_000

/** Compress only oversized upload copies; never rewrite the user's original image. */
/**
 * 往下试的边长台阶。
 *
 * 原来是从图片自身的长边开始不断折半。两个毛病：第一步的 resize 是空操作
 * （长边就是它自己），而折半会一步跨过 512～长边之间所有能用的尺寸 ——
 * 600×600 的大图从 600 直接掉到 300，循环条件 `>= 512` 不满足就放弃了，
 * 512 那一档**压根没试过**，用户却被告知「换一张参考图」。
 */
const EDGE_LADDER = [4096, 3072, 2048, 1536, 1024, 768, 512]

/** Compress only oversized upload copies; never rewrite the user's original image. */
export async function prepareReferenceUpload(blob: Blob, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted()
  if (blob.size <= MAX_UPLOAD_BYTES) return blob

  /*
   * `getSharp()` 放在 try 外面。
   *
   * 它失败的意思是「这台机器上 sharp 原生模块没装起来」（架构不对、postinstall
   * 被挡），而不是「这张图压不下去」。包进下面那个 catch 的话，用户读到的是
   * 「请重试或换一张参考图」—— 重试一万次也不会好，换图也没用，
   * 而真正的原因（依赖坏了）在界面上一个字都不会出现。
   */
  const sharp = await getSharp()

  try {
    const source = Buffer.from(await blob.arrayBuffer())
    const metadata = await sharp(source).metadata()
    const longest = Math.max(metadata.width ?? 8192, metadata.height ?? 8192)
    // 比原图还大的台阶没有意义（withoutEnlargement 会让它们退化成同一张），
    // 但至少留一档 —— 小图也要有机会真的被缩一次
    const edges = EDGE_LADDER.filter((edge) => edge < longest)
    if (edges.length === 0) edges.push(Math.max(512, Math.floor(longest / 2)))

    // WebP retains transparency. First reduce encoding quality, then dimensions if necessary.
    for (const edge of [longest, ...edges]) {
      for (const quality of [90, 80, 70]) {
        signal.throwIfAborted()
        const compressed = await sharp(source)
          .rotate()
          .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
          .webp({ quality })
          .toBuffer()
        signal.throwIfAborted()
        if (compressed.byteLength <= MAX_UPLOAD_BYTES) {
          return new Blob([new Uint8Array(compressed)], { type: 'image/webp' })
        }
      }
    }
    throw new Error('Compression limit exceeded')
  } catch {
    signal.throwIfAborted()
    throw new Error('参考图上传失败：自动压缩未完成，请重试或换一张参考图。')
  }
}
