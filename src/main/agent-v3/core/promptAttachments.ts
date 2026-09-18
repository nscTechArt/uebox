import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'

import type { ImageContent } from '@earendil-works/pi-ai'

/**
 * 把用户随这轮贴进来的图**落一份到盘上**，并把路径告诉模型。
 *
 * ## 为什么需要这一层
 *
 * 贴图本来就能进模型上下文（`ImageContent`），模型**看得见**那张图 ——
 * 真机上它能准确描述出「肌肉猛男版皮卡丘在摆美健姿势」。但它**没有任何句柄
 * 能把这张图交给工具**：`generate_3d_model` / `generate_image` 的
 * `reference_images` 收的是路径或直链，而那张图在模型上下文里是几十万字符的
 * base64，模型不可能逐字复述出来。
 *
 * 结果就是真机上那次：用户贴了图说「照着这张图生成 3D 模型」，模型只能回一句
 * 「我这边拿不到它的本地文件路径」，然后退回文生 3D 用文字描述硬凑 ——
 * 而图生 3D 的效果比文生稳得多，用户要的正是那张图。
 *
 * 落一份到盘上、把路径写进提示词，这个缺口就补上了：模型照抄那个路径即可。
 *
 * ## 为什么不存进素材库
 *
 * 素材库是用户的**成果**，聊天里随手贴的参考图不是。存进去只会把它撑爆，
 * 而且用户删不干净。这里放临时目录，由系统按自己的节奏回收。
 */

/** 落盘的目录。放 temp 而不是 userData —— 这些是过程产物，不该跟着备份走 */
function attachmentDir(): string {
  return join(app.getPath('temp'), 'unreal-box-attachments')
}

/** 常见图片类型的扩展名。认不出来按 png —— 下游按扩展名判类型，不能留空 */
const EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp'
})

function extensionOf(mimeType: string): string {
  return EXTENSIONS[String(mimeType || '').toLowerCase()] ?? '.png'
}

/**
 * 附件目录保留多久。
 *
 * 系统自己会清 temp，但那个节奏说不准（Windows 上可能几个月都不清）。
 * 而这里每贴一张图就落一个文件 —— 一个重度使用的人一周能攒出上千个。
 *
 * 七天：够长到「昨天那张图再用一次」还在，够短到不会无限长。
 * 清理是**尽力而为**的：删不掉（文件被占用之类）就跳过，绝不因此打断对话。
 */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 顺手清掉过期的附件。
 *
 * 挂在落盘这条路上而不是开个定时器：只有真的在用这个功能的人才需要清理，
 * 而定时器要管生命周期、要考虑多窗口，为一件顺带的事不值得。
 */
async function sweepExpired(dir: string): Promise<void> {
  try {
    const now = Date.now()
    const names = await fs.readdir(dir)
    await Promise.all(
      names.map(async (name) => {
        const path = join(dir, name)
        try {
          const stat = await fs.stat(path)
          if (now - stat.mtimeMs > KEEP_MS) await fs.rm(path, { force: true })
        } catch {
          // 单个删不掉就算了
        }
      })
    )
  } catch {
    // 目录读不了就算了 —— 清理失败绝不该影响这一轮对话
  }
}

export interface SavedAttachment {
  path: string
  mimeType: string
}

/**
 * 把这一轮的图落盘。返回落盘成功的那些。
 *
 * **落盘失败不算整轮失败**：图照样进模型上下文，模型仍然看得见，只是没法
 * 交给工具。为一个「顺带的便利」把整轮对话打断，代价不成比例。
 *
 * 文件名用内容哈希：同一张图反复贴（改一句话重发很常见）不会堆出一堆副本，
 * 而且同一张图在同一轮里拿到的是同一个路径。
 */
export async function savePromptAttachments(
  images: readonly ImageContent[] | undefined
): Promise<SavedAttachment[]> {
  if (!images || images.length === 0) return []

  const dir = attachmentDir()
  const saved: SavedAttachment[] = []
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch {
    return []
  }

  // 顺手清一次过期的。不 await 之前的结果 —— 清理慢不该拖着这轮对话
  void sweepExpired(dir)

  for (const image of images) {
    try {
      const bytes = Buffer.from(image.data, 'base64')
      if (bytes.byteLength === 0) continue
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
      const path = join(dir, `${hash}${extensionOf(image.mimeType)}`)
      // 已经存过就不重写 —— 同一张图重发时省一次磁盘写
      await fs.writeFile(path, bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
        if (error?.code !== 'EEXIST') throw error
      })
      saved.push({ path, mimeType: image.mimeType })
    } catch {
      // 单张失败跳过，其余照存
    }
  }
  return saved
}

/** 附件块的开闭标签。拼和剥都从这里取 —— 两边各写一遍迟早会分叉 */
const BLOCK_OPEN = '<attachments>'
const BLOCK_CLOSE = '</attachments>'

/**
 * 拼给模型看的那一段。
 *
 * 措辞上要说清**两件事**，缺一不可：
 * 1. 这些路径对应的就是上面那几张图（否则模型不知道谁是谁）
 * 2. 要把图交给工具时**用路径**，不要试图自己复述图片内容
 *
 * 第二条是真机那次的直接教训：模型没有路径时，会退而求其次用文字描述去做
 * 文生，而它自己并不知道那样效果差很多。
 */
export function formatAttachmentBlock(saved: readonly SavedAttachment[]): string {
  if (saved.length === 0) return ''
  const lines = saved.map((item, index) => `${index + 1}. ${item.path}`)
  return [
    BLOCK_OPEN,
    `The user attached ${saved.length} image(s) to this message. You can see them directly above.`,
    'Each one is also saved on disk at the path below.',
    ...lines,
    'When a tool needs one of these images (reference_images, image inputs, etc.), pass the PATH.',
    'Do not describe the image in words as a substitute — image-driven generation is markedly better than text-driven.',
    BLOCK_CLOSE
  ].join('\n')
}

/**
 * 把附件块剥掉，还原成用户真正打的那句话。
 *
 * 和闪存块的 `stripEditorSnapshotBlock` 是同一件事、同一个理由：插话的回执按
 * **文本相等**匹配（`steerQueue.markSteerDelivered` / `agentStream.markSteerApplied`），
 * 界面上存的是原话，而模型收到的是「闪存块 + 附件块 + 原话」。不剥的话两边永远
 * 对不上，那条带图的插话会一直显示「未生效」—— 而它其实早就进上下文了。
 *
 * 只认开头那一处：块永远拼在最前面，正文里出现同名标签是用户自己写的字，不该动。
 */
export function stripAttachmentBlock(text: string): string {
  if (!text.startsWith(BLOCK_OPEN)) return text
  const end = text.indexOf(BLOCK_CLOSE)
  if (end < 0) return text
  return text.slice(end + BLOCK_CLOSE.length).replace(/^\r?\n\r?\n?/, '')
}
