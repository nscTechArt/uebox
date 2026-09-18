/**
 * 本地文件读取与目录列举。
 *
 * ## 为什么要有
 *
 * 真机验证 68 个工具后发现的一个明确缺口：**没有任何工具能看本地磁盘。**
 * 用户说「把 D:\素材\ 这个文件夹里的模型导进来」，agent 无法枚举目录，
 * 而 `ue_content_import` 要的是一条条具体文件路径 —— 于是最自然的一句话
 * 请求直接卡死。参考图同理：用户给了路径，agent 看不到。
 *
 * ## 为什么直接用 pi 的
 *
 * 我们依赖的 `@earendil-works/pi-agent-core` 本来就带 read/bash/edit/write
 * 四个内置工具，只是一直没注册。`read` 是其中最该接的：它把图片原生转成
 * 上下文里的 image 块（真机验证 `types: 'text,image'`），文本带 offset/limit
 * 和截断，这些自己重写一遍没有意义。
 *
 * 目录列举 pi 没有单独的工具（在 CLI 里靠 bash `ls`），但 `NodeExecutionEnv`
 * 实现了 `listDir`，用它包一个即可 —— 列目录这种基础能力不该依赖用户
 * 装没装 Git Bash（pi 的 bash 在 Windows 上只认
 * `Program Files\Git\bin\bash.exe`，找不到就返回 shell_unavailable）。
 * 引擎开发者机器上多半有，纯蓝图工程的用户则未必。
 *
 * ## 边界
 *
 * 读盘是新增的暴露面 —— 在这之前 agent 完全碰不到本地文件。所以挡掉
 * 明确敏感的位置（凭据、密钥、浏览器数据），其余放行：用户报出来的路径
 * 就是用户的授权，把范围锁死在工程目录会让上面那个主用例直接失效。
 *
 * 那份清单本来就写在这个文件里，现在搬去了 `pathBoundary.ts` —— 碰盘的工具
 * 已经不止这里的两个（还有 write / edit / find / grep / shell），规则跟着
 * 其中一个走，别的就会漏。搬家的缘由写在那个模块的头部。
 */

import { isAbsolute, resolve as resolvePath } from 'node:path'

import { createReadTool } from '@earendil-works/pi-agent-core'
import type { AgentToolResult, ReadImageProcessor } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { app } from 'electron'
import { z } from 'zod'

import { compressForContext, describeResize } from '../contextImage'
import { defineTool, type UnrealAgentTool } from '../defineTool'
import { assertInAccessScope } from './accessScope'
import { assertPathAllowed } from './pathBoundary'

/** 一次最多列多少条。目录里几万个文件时全带回去会挤爆上下文 */
const MAX_ENTRIES = 200

/** 懒建 —— 只有真用到本地文件工具时才起，且全进程共用一个 */
let env: NodeExecutionEnv | undefined
export function getExecutionEnv(): NodeExecutionEnv {
  return getEnv()
}

function getEnv(): NodeExecutionEnv {
  if (!env) {
    // cwd 用用户目录：相对路径在对话里基本不出现，真出现时以用户为基准
    // 比以应用安装目录为基准更符合直觉
    env = new NodeExecutionEnv({ cwd: app.getPath('home') })
  }
  return env
}

/**
 * 读到图片时先压一遍再进上下文。
 *
 * ## 为什么必须有
 *
 * pi 的 read 工具**没挂这个钩子就把原始字节原样 base64 发出去**
 * （`harness/tools/read.js`：`{ type: 'image', data: encodeBase64(bytes) }`）。
 * 真机上炸过一次：用户让 agent 看一张 2048×2048 的 UV 排布图（3.5MB PNG），
 * base64 撑到 4.7MB 塞进一个 JSON body，厂商网关（openresty）默认的请求体
 * 上限是 1MB，直接退回一页 413 的 HTML —— 界面上显示的是「Agent 执行失败」
 * 加半张网页，没有任何线索指向那张图。
 *
 * 更要命的是这一下不可恢复：pi 每次请求都重发整条 transcript，那 4.7MB 一直
 * 钉在历史里，「继续尝试」只是再 413 一次，整个会话报废。
 *
 * 截图、生图、生视频参考图早就各自压过了（见 `contextImage.ts` 文件头），
 * 读本地文件是漏掉的那条路 —— 而它恰恰是唯一一条图**由用户指定、大小完全
 * 不可控**的路：截图的分辨率是我们自己定的，用户磁盘上那张不是。
 *
 * ## 读不了的时候说实话
 *
 * 返回 `ok: false`，pi 会把 message 当文本块交给模型，图不进上下文。
 * 这比悄悄塞一张坏图强：模型知道自己没看见，会去问用户。BMP 走这条路
 * —— sharp 不支持 BMP 输入。
 *
 * 「压完仍然过大」不再走这里：阶梯会保留最小的那份，真正超标由请求级的
 * 总预算裁决（见 `core/requestBudget.ts`）。丢掉一张能看的图，代价比降一档
 * 画质大得多。
 */
const readImageProcessor: ReadImageProcessor = async (bytes) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const compressed = await compressForContext(buffer)

  if (!compressed) {
    return {
      ok: false,
      message:
        '[这张图没能进上下文：可能是解不开（例如 BMP），也可能是压到最低画质' +
        '仍然太大。磁盘上的原文件未必有问题 —— 告诉用户你看不到这张图，' +
        '请他自己打开看；要你看的话，让他转成 PNG / JPEG，或者裁掉一部分、' +
        '缩小之后再给你。不要重试同一个路径。]'
    }
  }

  // 缩过才说，没缩就别啰嗦 —— 每张图都挂一句废话会稀释真正要紧的那几句
  const resized = describeResize(compressed)
  return {
    ok: true,
    data: compressed.data,
    mimeType: compressed.mimeType,
    hints: resized ? [resized] : []
  }
}

/**
 * 读本地文件。直接复用 pi 的实现，只加一层路径检查和一层图片压缩。
 *
 * pi 的 `AgentHarnessTool.execute` 比我们的 `AgentTool` 多收一个 context 参数，
 * 这里把 `{ env }` 绑上去就能当普通工具用。
 */
function createReadLocalFileTool(): UnrealAgentTool<never> {
  const inner = createReadTool({ imageProcessor: readImageProcessor })

  return {
    ...inner,
    // pi 的工具没有 unrealBox 元数据，补上 —— `resolveTools` 靠它做
    // 动态过滤，审批门靠它判 risk。少了这块会在过滤时直接抛
    // 「Cannot read properties of undefined」，而且是在**造 agent 的时候**，
    // 整个会话起不来。
    unrealBox: { namespace: 'local', risk: 'safe' },
    name: 'read_local_file',
    description:
      '读取用户电脑上的一个文件。\n\n' +
      '文本文件返回内容（可用 offset / limit 翻页，超长会截断）；' +
      '**图片文件会直接变成你能看到的图** —— 用户给了参考图路径就用这个看。\n\n' +
      '【什么时候用】读日志、读 .uproject / ini 配置、看用户指定的参考图、' +
      '确认某个文件到底存不存在、内容是什么。\n' +
      '【什么时候不用】读虚幻工程里的资产（.uasset 是二进制，' +
      '要用 ue_content_describe 之类的工具）；列目录请用 list_local_dir。',
    execute: async (toolCallId, params, signal, onUpdate) => {
      const target = (params as { path?: string })?.path ?? ''
      const denied = assertPathAllowed(target) ?? (await assertInAccessScope(target))
      if (denied) {
        return { content: [{ type: 'text', text: denied }], isError: true }
      }
      const result = await inner.execute(toolCallId, params, signal, onUpdate, { env: getEnv() })
      return withViewedImageDetails(result, target)
    }
  } as unknown as UnrealAgentTool<never>
}

/** 图片扩展名。只在 pi 已经判定"这是张图"之后用来做兜底路径检查 */
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp)$/i

/**
 * 读到图片时，把磁盘上那条路径挂到 `details` 上。
 *
 * 不这么做的话，聊天里只剩一行「Read image file [image/png]」—— 模型看见了图，
 * 人没看见，用户没法判断它到底在看什么、看清没有。
 *
 * 挂的是**路径**不是图本身：进模型上下文的那份是压过的 base64，跟着聊天记录
 * 写进本地存储会把配额撑满（同 adaptV2Tool 里的取舍）。界面拿路径走
 * `local-resource` 协议读原图，既清楚又不占地方。
 */
function withViewedImageDetails(
  result: AgentToolResult<unknown>,
  requestedPath: string
): AgentToolResult<unknown> {
  const content = (result as { content?: Array<{ type?: string }> }).content ?? []
  const hasImage = content.some((block) => block?.type === 'image')
  if (!hasImage) return result

  // cwd 和 getEnv() 保持一致 —— 相对路径在对话里基本不出现，真出现时别指错文件
  const absolute = isAbsolute(requestedPath)
    ? requestedPath
    : resolvePath(app.getPath('home'), requestedPath)
  if (!IMAGE_EXTENSION.test(absolute)) return result

  const name = absolute.split(/[\\/]/).pop() || absolute
  return {
    ...result,
    details: {
      message: `看了图片 ${name}`,
      /** 界面用：默认收起，用户点一下才加载 —— agent 一次可能连着看好几张 */
      viewed_image_path: absolute
    }
  } as AgentToolResult<unknown>
}

const listInput = z.object({
  path: z.string().describe('要列举的目录绝对路径，如 "D:/素材/建筑"'),
  pattern: z
    .string()
    .optional()
    .describe('可选，只保留文件名包含这段文字的条目（不区分大小写），如 ".fbx"')
})

/**
 * 列目录。
 *
 * pi 没有对应的内置工具（CLI 里靠 bash `ls`），但用户机器上多半没有 bash，
 * 所以直接用 `NodeExecutionEnv.listDir` 包一个。
 */
function createListLocalDirTool(): UnrealAgentTool<never> {
  return defineTool({
    name: 'list_local_dir',
    namespace: 'local',
    risk: 'safe',
    description:
      '列出用户电脑上某个目录里有什么（文件和子目录）。\n\n' +
      '【什么时候用】用户说「把这个文件夹里的东西导进来 / 整理一下」时，' +
      '先用这个看清楚里面有哪些文件，再决定对哪些做事 —— ' +
      '不要凭文件夹名字猜里面的内容。\n' +
      `【注意】一次最多返回 ${MAX_ENTRIES} 条。目录很大时用 pattern 收窄` +
      '（如只看 ".fbx"），并把「还有更多」如实告诉用户。',
    input: listInput,
    execute: async (args) => {
      const denied = assertPathAllowed(args.path) ?? (await assertInAccessScope(args.path))
      if (denied) return { text: denied, isError: true }

      const result = await getEnv().listDir(args.path)
      if (!result.ok) {
        // 把底层错误原样带出来。「目录不存在」和「没有权限」需要不同的下一步，
        // 统一成一句「读取失败」会让调用方无从判断
        const reason = (result.error as { message?: string })?.message ?? String(result.error)
        return { text: `无法列出目录 ${args.path}：${reason}`, isError: true }
      }

      // pi 的 FileInfo 用 kind: 'file' | 'directory' | 'symlink'，不是 isDirectory。
      // 认错字段的话目录会被当成 0 字节的文件显示 —— 而「哪些是文件夹」
      // 恰恰是列目录时最要紧的信息。
      const all = result.value as Array<{ name: string; kind: string; size: number }>
      const filtered = args.pattern
        ? all.filter((e) => e.name.toLowerCase().includes(args.pattern!.toLowerCase()))
        : all

      // 目录排前面，同类按名字排 —— 和用户在资源管理器里看到的顺序一致
      const sorted = [...filtered].sort((a, b) => {
        const dirDelta = Number(b.kind === 'directory') - Number(a.kind === 'directory')
        return dirDelta !== 0 ? dirDelta : a.name.localeCompare(b.name)
      })

      const shown = sorted.slice(0, MAX_ENTRIES)
      const lines = shown.map((e) =>
        e.kind === 'directory' ? `[目录] ${e.name}` : `       ${e.name}${sizeHint(e.size)}`
      )

      const header =
        filtered.length > MAX_ENTRIES
          ? `${args.path} 共 ${filtered.length} 条，显示前 ${MAX_ENTRIES} 条：`
          : `${args.path} 共 ${filtered.length} 条：`

      return {
        text:
          filtered.length === 0
            ? `${args.path} 是空目录，或没有匹配的条目。`
            : `${header}\n${lines.join('\n')}`,
        details: {
          path: args.path,
          total: filtered.length,
          truncated: filtered.length > MAX_ENTRIES,
          entries: shown
        }
      }
    }
  }) as unknown as UnrealAgentTool<never>
}

function sizeHint(size?: number): string {
  if (typeof size !== 'number') return ''
  if (size < 1024) return ` (${size} B)`
  if (size < 1024 * 1024) return ` (${Math.round(size / 1024)} KB)`
  return ` (${(size / 1024 / 1024).toFixed(1)} MB)`
}

/** 本地文件工具。不依赖引擎连接 —— 未连接虚幻时它们照样可用 */
export function createLocalFileTools(): UnrealAgentTool<never>[] {
  return [createReadLocalFileTool(), createListLocalDirTool()]
}

export const __testing = { sizeHint, MAX_ENTRIES, withViewedImageDetails, readImageProcessor }

export type { AgentToolResult }
