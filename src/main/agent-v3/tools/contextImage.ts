/**
 * 把一张图压到「能进模型上下文」的大小。
 *
 * ## 为什么必须压
 *
 * 图片按字节数折算 token，1MB 的图大概值 30 万 token。视口截图最早那一版
 * 把上限设成 1.5MB 并且「不超限就原样发 PNG」—— 真机任务评测里，模型截了
 * 两张图，上下文直接冲到 **123 万 token**，撞上模型 105 万的窗口，整轮报错
 * 作废，顺带把主进程的网络服务也搞崩了。
 *
 * 视觉模型看 768px 宽的图已经足够判断「这个立方体是不是蓝的」「这张渲染图
 * 构图对不对」—— 那正是这些工具的用途。再大只是烧 token。
 *
 * ## 为什么抽成一个模块
 *
 * 这几个数是真机调出来的（见上），而往上下文里塞图的路不止一条：视口截图
 * （截图 / Widget 预览 / PIE 试玩）、AI 生图、`read_local_file` 读用户磁盘上的
 * 图、第三方 MCP server 返回的图。各写一份必然漂移，而漂移的表现不是报错，
 * 是某一天某个工具悄悄把上下文撑爆。
 *
 * 后两条尤其不能省：图有多大**完全不由我们决定**。截图的分辨率是自己定的，
 * 用户指的那张 2048×2048 UV 图不是 —— 那张图原样发出去换来的是一次 413，
 * 而且因为 pi 每次都重发整条 transcript，之后每一轮都会再 413 一次。
 *
 * ## 为什么是「阶梯」而不是压一次
 *
 * 原来只按一个固定质量压一次，压完还超上限就**整张放弃**，模型什么都看不到。
 * 这在「一张噪点很多的大图」上是常事，而放弃的代价（模型对着一片空白下结论）
 * 比降一档画质大得多。
 *
 * 现在按质量阶梯逐档试，**第一个塞得进预算的就用**；一档都塞不下时保留最小的
 * 那份而不是丢掉 —— 请求级的总预算（见 `core/requestBudget.ts`）会兜住真正
 * 过大的情况，这一层不需要为此牺牲掉整张图。DeepSeek Harness 的
 * `encodeFirstWithinLimit` 是同一个取舍。
 *
 * 实测过：768px 下**连纯噪声都只有 124KB**（最难压的输入），所以第一档几乎
 * 总是命中，后两档是兜底而不是常态。别为了省一次编码把阶梯拆掉 —— 省不下
 * 什么，而兜底那一档正是留给「哪天某个新工具塞进来一张我们没见过的图」。
 *
 * ## 为什么要回读校验
 *
 * 编完之后重新解一遍，尺寸和格式对不上就当失败。sharp 在少数损坏输入上会
 * 「成功」返回一段解不开的字节 —— 那段字节发给厂商换来的是一次 400，
 * 而错误信息只会说「invalid image」，查不到是哪一步坏的。宁可在这里就说
 * 「这张图没进去」。
 */

import { getSharp } from '../../utils/sharpLoader'

/** 进上下文的图片最大宽度 */
export const CONTEXT_IMAGE_MAX_WIDTH = 768

/**
 * 拼图（多帧九宫格）的最大宽度。**只有拼图能用这个数，单张图一律走 768。**
 *
 * 一张拼图里装的是 N 个格子，缩到 768 宽之后每个格子只剩 768/列数 ——
 * 3 列就是 256×144，比手机图标大不了多少。文件头那句「768 够判断这个
 * 立方体是不是蓝的」说的是**整张图就是一个画面**的情况，格子图不适用：
 * 同样的 768 分到九格，每格的有效像素只有单张图的九分之一。
 *
 * 1152 是按「3 列时每格 384×216」定的 —— 那个尺寸能看出角色位置、
 * 画面黑没黑、大件东西在不在，正是时间轴要回答的问题。
 *
 * 字节预算不跟着放宽（见 `CONTEXT_IMAGE_MAX_BYTES`）：像素多了就让质量阶梯
 * 自己往下掉一档，而不是让一张图吃掉三倍上下文。
 */
export const CONTACT_SHEET_MAX_WIDTH = 1152

/**
 * 最大高度。**故意比宽度宽松得多**。
 *
 * 它挡的是 512×16384 那种贴图集 —— 宽度本来就小于 768，不限高的话一个像素
 * 都不缩，只是重新编一次码，压出来仍有好几 MB。
 *
 * 但不能和宽度取同一个数：`fit: 'inside'` 是按两边比例的较小者缩的，
 * 高度也给 768 的话，每一张竖图都会跟着变窄（1080×1920 → 432×768），
 * 而竖构图的 AI 生成图和竖向界面截图都是常见输入。
 */
export const CONTEXT_IMAGE_HEIGHT_WIDTH_RATIO = 4
export const CONTEXT_IMAGE_MAX_HEIGHT = CONTEXT_IMAGE_MAX_WIDTH * CONTEXT_IMAGE_HEIGHT_WIDTH_RATIO

/**
 * 丢 alpha 时垫在底下的颜色。**中性灰，不是白也不是黑。**
 *
 * JPEG 没有 alpha，垫黑的话透明底深色字的 logo 压完是一块纯黑；垫白的话
 * 透明底**浅色**字的 logo 压完是一块纯白 —— 而浅色 logo 在美术资产里更常见。
 * 实测（前景 245）：垫白之后前景和底色差 10，肉眼和模型都认不出来；
 * 垫中性灰差 117，深浅两种前景同时保得住。
 */
export const CONTEXT_IMAGE_FLATTEN_BACKGROUND = '#808080'

/**
 * JPEG 质量阶梯，从高到低。
 *
 * 档与档之间拉开足够距离，每降一档都要换来实打实的体积下降 —— 挨得太近的话
 * 多编一次只省几个百分点，纯粹浪费 CPU。
 */
export const CONTEXT_IMAGE_QUALITY_LADDER = [65, 50, 35] as const

/** 一张图进上下文的字节预算（约 5 万 token）。阶梯从高到低找第一个塞得进的 */
export const CONTEXT_IMAGE_MAX_BYTES = 180_000

/**
 * 单张图的硬上限。压到最低一档还超过这个数就**不进上下文**。
 *
 * 预算可以超一点（请求级预算会裁决），但不能没有天花板：请求级预算只管
 * 「这一轮请求多少字节」，管不了「一张图吃掉多少上下文窗口」，而且 MCP server
 * 那条对外的路根本不经过它。
 */
export const CONTEXT_IMAGE_HARD_MAX_BYTES = CONTEXT_IMAGE_MAX_BYTES * 2

export interface ContextImage {
  /** 不带 data URI 前缀的 base64 */
  data: string
  mimeType: string
  /** 进上下文这一份的尺寸 */
  width: number
  height: number
  /** 磁盘上原图的尺寸。调用方拿它告诉模型「你看的是缩过的」 */
  sourceWidth: number
  sourceHeight: number
}

interface Candidate {
  data: Buffer
  width: number
  height: number
}

/**
 * 压一张图给模型看。解不开或压出来的东西校验不过时返回 null —— 调用方照常
 * 返回路径，只是模型这一轮看不到图，并且**要把这件事告诉模型**。
 *
 * **一律重新编码**，不做「够小就原样发」的快捷路径：一张视口 PNG 即便只有
 * 400KB 也值十几万 token，而同一张图转成 768px 的 JPEG 只要几十 KB。
 */
export async function compressForContext(
  bytes: Buffer,
  options?: { maxWidth?: number }
): Promise<ContextImage | null> {
  try {
    const sharp = await getSharp()
    const source = await sharp(bytes).metadata()
    // 只有拼图会传这个参数，理由见 CONTACT_SHEET_MAX_WIDTH。
    // 高度上限跟着一起放大，否则 3×3 的方形拼图会被高度那条卡住反而更小
    const maxWidth = options?.maxWidth ?? CONTEXT_IMAGE_MAX_WIDTH
    const maxHeight = maxWidth * CONTEXT_IMAGE_HEIGHT_WIDTH_RATIO
    // 缩放只做一次，三档质量共用同一条流水线（clone 出来各编各的）
    //
    // 高度也要限，但**不能和宽度同一个数**：`fit: 'inside'` 按
    // `min(768/w, 768/h)` 缩，两边都给 768 的话每一张竖图都跟着变窄 ——
    // 一张 1080×1920 的竖构图会从 768×1365 掉到 432×768，比文件头论证过的
    // 768 宽窄了 43%。要挡的只是 512×16384 那种极端长条，所以高度单独给一个
    // 宽松得多的上限，见 `CONTEXT_IMAGE_MAX_HEIGHT`。
    //
    // `.flatten()` 也不能少：JPEG 没有 alpha 通道，sharp 丢 alpha 时把像素
    // 合成到**黑底**上。以前这里只看得到不透明的视口截图所以没事，现在用户
    // 自己指的图和第三方 MCP 返的图都走这条路 —— 一张透明底深色字的 logo
    // 压完就是一块纯黑，模型会照实报告「这个文件是空的」。
    const resized = sharp(bytes)
      .resize({
        width: maxWidth,
        height: maxHeight,
        fit: 'inside',
        withoutEnlargement: true
      })
      .flatten({ background: CONTEXT_IMAGE_FLATTEN_BACKGROUND })

    let smallest: Candidate | undefined
    let fitted: Candidate | undefined
    for (const quality of CONTEXT_IMAGE_QUALITY_LADDER) {
      const { data, info } = await resized
        .clone()
        .jpeg({ quality })
        .toBuffer({ resolveWithObject: true })
      const candidate: Candidate = { data, width: info.width, height: info.height }
      if (data.byteLength <= CONTEXT_IMAGE_MAX_BYTES) {
        fitted = candidate
        break
      }
      if (!smallest || data.byteLength < smallest.data.byteLength) smallest = candidate
    }

    const chosen = fitted ?? smallest
    if (!chosen) return null
    if (!fitted) {
      // 超一点就带上（请求级预算会裁决），但**必须有个上限**：请求级预算管的是
      // 整个请求的字节数，管不了「单张图吃掉多少上下文窗口」，而 MCP server
      // 那条路（`McpServerHost.callTool`，工具结果直接回给外部客户端）压根不经过
      // 请求级预算。少了这道，一张图就能把上下文顶爆，和原来那次事故一模一样。
      if (chosen.data.byteLength > CONTEXT_IMAGE_HARD_MAX_BYTES) {
        console.warn(
          `[contextImage] 最低一档仍有 ${chosen.data.byteLength} 字节，超过硬上限 ` +
            `${CONTEXT_IMAGE_HARD_MAX_BYTES}，不进上下文`
        )
        return null
      }
      console.warn(
        `[contextImage] 最低一档仍有 ${chosen.data.byteLength} 字节，超出 ${CONTEXT_IMAGE_MAX_BYTES} 预算，` +
          '先带上，由请求级预算决定要不要丢'
      )
    }

    const verified = await sharp(chosen.data).metadata()
    if (
      verified.format !== 'jpeg' ||
      verified.width !== chosen.width ||
      verified.height !== chosen.height
    ) {
      console.warn('[contextImage] 压出来的图回读校验不过，不进上下文')
      return null
    }

    return {
      data: chosen.data.toString('base64'),
      mimeType: 'image/jpeg',
      width: chosen.width,
      height: chosen.height,
      // 读不出原尺寸时退回压后的尺寸：调用方据此判断「缩过没有」，
      // 宁可说「没缩」也不要报一个编出来的原始尺寸
      sourceWidth: source.width ?? chosen.width,
      sourceHeight: source.height ?? chosen.height
    }
  } catch (error) {
    console.warn('[contextImage] 压缩失败:', error)
    return null
  }
}

/**
 * 「这张图被缩过没有」以及缩成了什么样，一句给模型看的话。
 *
 * 给确切的前后尺寸，不给「已压缩」这种空话：模型据此判断细节能不能信 ——
 * 2048 的 UV 图缩到 768 之后，小字标注是认不出来的，而模型不知道自己看的是
 * 缩过的版本时，会把「看不清」当成「图上没有」。Codex 的 `ImageResizeNotice`
 * 给的也是确切数字。
 */
export function describeResize(image: ContextImage): string | undefined {
  if (image.sourceWidth === image.width && image.sourceHeight === image.height) return undefined
  return (
    `[这张图已从 ${image.sourceWidth}×${image.sourceHeight} 缩到 ${image.width}×${image.height} 再进上下文，` +
    '磁盘上的原图没动。细节看不清就说看不清，别猜。]'
  )
}
