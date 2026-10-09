/**
 * `sequence_render` —— 用 Movie Render Queue 把一条 Level Sequence 渲成文件。
 *
 * ## 为什么现在做了
 *
 * 之前的硬边界是「不做渲染出片」：渲染是不可逆的资源消耗（几小时机器时间、几十 GB
 * 磁盘），交付责任必须在人。这条理由没变，变的是**谁来拍板**：
 * 现在每一次渲染都要用户当场批准（`requiresExplicitApproval`，「本对话内都允许」对它
 * 无效），参数就写在审批卡上。拍板仍然在人，只是不用再让人自己去点 MRQ。
 *
 * 画质档和流程来自维护者早年的 MRQ 插件 UNTRender：档位制、按相机切出片、
 * 进度看「第几帧 / 共几帧」。蓝图界面没法给 Agent 用，搬过来的是那套想法，
 * 不是那个插件。
 *
 * ## 一次调用 = 一整次渲染
 *
 * 插件那边是三条命令：开始（`sequence.render`）、查进度（`sequence.render_status`）、
 * 取消（`sequence.render_cancel`）。这里把它们收成一个工具：开始之后就地轮询，
 * 进度经 `report()` 推给界面，渲完才返回。理由：
 *
 *   - 模型不用学「开始了要记得回来查」—— 它一定会忘，或者每两秒查一次把上下文刷爆
 *   - 用户按停止 = 取消渲染。工具握着 job，取消只能由它来发
 *
 * 渲染期间编辑器在跑 PIE，别的编辑器工具本来也做不了事，所以占着这一轮不亏。
 *
 * ## 停止 = 取消
 *
 * 用户按停止时，我们向插件发取消，并在 abort note 里写明「已请求取消、已渲出的帧在哪」。
 * 取消请求本身也可能没送到（编辑器卡死），所以那句话写的是「已请求」，不是「已取消」。
 *
 * ## 渲完的回执只说引擎报的事实
 *
 * 输出目录里实际有几个文件是插件渲完之后扫盘数出来的，不是按帧数算出来的
 * （AGENTS.md §5 第 14 条）。数对不上就照实说。
 *
 * ## 要视频：先出 PNG，再用 FFmpeg 合成
 *
 * `format: 'mp4'` 不交给 MRQ 的 MP4 编码器（5.6 才有），而是让 MRQ 出 PNG 序列帧、
 * 渲完由盒子调用户装的 FFmpeg 合成，九个版本一条路，帧也留着。见 `composeVideo.ts`。
 * FFmpeg 在**开渲之前**就查：没装的话几小时之后才发现合不了，那几小时就白等了。
 */

import { z } from 'zod'

import { findFFmpeg } from '../../../services/ffmpegPath'
import { callUe, callUeRaw } from '../defineUeTool'
import { defineTool, type ToolCallContext, type UnrealAgentTool } from '../defineTool'
import { composeVideo, type ComposedVideo } from './composeVideo'

const NAMESPACE = 'ue.sequencer'

/** 轮询间隔。进度条两秒一跳足够，再快只是给编辑器添 RPC */
const POLL_MS = 2_000

/**
 * 连续几次查不到进度就当编辑器没了。
 *
 * 一次失败不算：PIE 起停、着色器编译的那几秒里，游戏线程可能顾不上回 RPC。
 * 15 次 × 2 秒 = 半分钟没回话，再等下去用户只会看着一个不动的进度条。
 */
const MAX_STATUS_FAILURES = 15

/** 插件回「MRQ 没启用」时接在报错后面的下一步 */
export const MRQ_DISABLED_HINT =
  '下一步：先问用户要不要给这个工程启用 Movie Render Queue，同意后调 ' +
  'project_manage(action="enable_plugins", pluginNames=["MovieRenderPipeline"])。' +
  '启用后要重启编辑器才生效，重启前别再调 sequence_render。'

export const RENDER_FORMATS = ['png', 'jpg', 'exr', 'bmp', 'mp4', 'mp4_mrq'] as const
export const RENDER_QUALITIES = ['draft', 'standard', 'high', 'ultra'] as const

const InputSchema = z.object({
  sequence_path: z.string().trim().min(1).describe('要渲的序列，如 /Game/Cinematics/SQ_Intro'),
  map_path: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('在哪个关卡里渲，如 /Game/Maps/Showroom。不填就用编辑器当前打开的关卡'),
  format: z
    .enum(RENDER_FORMATS)
    .optional()
    .describe(
      '输出格式，不填是 png。png / jpg / bmp / exr 出序列帧；exr 是 16 位浮点，给合成用。' +
        'mp4：先出 PNG 序列帧，渲完用 FFmpeg 合成 H.264 视频，帧也保留；要求本机装了 FFmpeg。' +
        'mp4_mrq：用 MRQ 自带的 MP4 编码器直接出视频（只有 UE 5.6+，不留帧）—— 只在用户明确要用 MRQ 自己的编码时才选'
    ),
  quality: z
    .enum(RENDER_QUALITIES)
    .optional()
    .describe(
      '画质档，不填是 standard。draft：不加采样，最快，用来看镜头对不对；standard：每帧 4 次时间采样；' +
        'high：2×8；ultra：4×16，最慢。档位越高，同一帧渲得越久'
    ),
  renderer: z
    .enum(['lumen', 'path_tracer'])
    .optional()
    .describe(
      '不填是 lumen。lumen：延迟渲染，和视口里看到的一致。' +
        'path_tracer：路径追踪，质量最高但慢得多，要求项目开了硬件光追'
    ),
  // 不用 z.tuple：转出来是元组式 items: [...]，MiMo 等 OpenAI 兼容端点整单 400
  resolution: z
    .array(z.number().int().min(16).max(16384))
    .length(2)
    .optional()
    .describe('输出分辨率 [宽, 高]，如 [3840, 2160]。不填是 [1920, 1080]'),
  frame_start: z
    .number()
    .int()
    .optional()
    .describe('只渲一段时的起始帧（含）。按 Sequencer 里显示的帧号，不填就从播放范围开头'),
  frame_end: z
    .number()
    .int()
    .optional()
    .describe('只渲一段时的结束帧（不含）。不填就到播放范围结尾'),
  preset_path: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      '用户自己存的 MRQ 预设资产（Movie Pipeline Primary Config），如 /Game/Render/MyPreset。' +
        '给了就以它为准，上面的画质档和渲染器不再生效；分辨率、格式、帧范围、输出目录照样能覆盖'
    ),
  output_dir: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('输出目录的绝对路径。不填就是 工程/Saved/MovieRenders/序列名/时间戳')
})

type RenderInput = z.infer<typeof InputSchema>

/** `sequence.render` 的回包，与 `UAL_RenderCommands.cpp` 的 Handle_Render 逐字对应 */
export interface RenderStartOutput {
  job_id: string
  sequence_path: string
  map_path: string
  output_dir: string
  format: string
  resolution: [number, number]
  renderer: string
  quality: string
  /** 实际要渲的范围，闭开区间，显示帧号 */
  frame_range: [number, number]
  /** 用了用户的预设时才有 */
  preset_path?: string
  warnings?: string[]
}

export type RenderState = 'rendering' | 'finished' | 'failed' | 'canceled' | 'none'

/** `sequence.render_status` 的回包 */
export interface RenderStatusOutput {
  job_id: string
  state: RenderState
  /** 0..1 */
  progress: number
  /** 已经输出的帧数 / 总帧数。引擎还没开始出帧时两个都是 0 */
  output_frame: number
  total_frames: number
  elapsed_seconds: number
  /** 引擎估出来的剩余时间。估不出来时不发 */
  eta_seconds?: number
  output_dir: string
  /** 渲完之后扫盘数出来的文件数。还在渲时不发 */
  files_written?: number
  /** 前几个输出文件的绝对路径，给模型和用户看一眼。还在渲时不发 */
  sample_files?: string[]
  error?: string
}

export interface RenderDetails {
  start: RenderStartOutput
  status: RenderStatusOutput
  /** 要了 mp4 才有：合成成功给路径，失败给原因 */
  video?: ComposedVideo | { error: string }
}

/** 没装 FFmpeg 时，开渲之前就拦下来的那句话 */
export const FFMPEG_MISSING =
  '要出 MP4 需要本机装 FFmpeg（先出 PNG 帧，再用它合成），但没有检测到。' +
  '把两条路告诉用户让他选：装 FFmpeg（Windows: winget install Gyan.FFmpeg，装完不用重启盒子）后再渲；' +
  '或者改 format: "png" 只出序列帧。还没开始渲染。'

/** 秒 → 「3 分 20 秒」。不到一秒按一秒说，免得出现「0 秒」 */
export function formatDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${rest} 秒`
  return `${rest} 秒`
}

/** 渲染中的一行进度，给界面看 */
export function formatProgress(s: RenderStatusOutput): string {
  if (s.total_frames <= 0) return '渲染准备中（启动 PIE、预热、编译着色器）…'
  const pct = Math.floor(Math.min(1, Math.max(0, s.progress)) * 100)
  const eta = s.eta_seconds !== undefined ? `，预计还要 ${formatDuration(s.eta_seconds)}` : ''
  return `渲染中 ${pct}%（第 ${s.output_frame}/${s.total_frames} 帧），已用 ${formatDuration(s.elapsed_seconds)}${eta}`
}

/** 开始那一刻的参数摘要，渲完的回执和中途报错都用它开头 */
function describeJob(j: RenderStartOutput): string {
  const [w, h] = j.resolution
  const settings = j.preset_path
    ? `预设 ${j.preset_path}`
    : `${j.renderer === 'path_tracer' ? '路径追踪' : 'Lumen'}，${j.quality} 档`
  return (
    `${j.sequence_path}（关卡 ${j.map_path}）→ ${j.format.toUpperCase()} ${w}×${h}，` +
    `${settings}，帧 [${j.frame_range[0]}, ${j.frame_range[1]})`
  )
}

/** 渲染终态 → 给模型的回执 */
export function formatResult(j: RenderStartOutput, s: RenderStatusOutput): string {
  const lines: string[] = []
  const head = describeJob(j)

  if (s.state === 'finished') {
    const expected = j.frame_range[1] - j.frame_range[0]
    const written = s.files_written ?? 0
    lines.push(`渲染完成：${head}，用时 ${formatDuration(s.elapsed_seconds)}。`)
    lines.push(`输出目录：${s.output_dir}`)
    if (j.format === 'mp4') {
      // MRQ 自带的 MP4 编码：一个视频文件，不按帧对账
      lines.push(`目录里有 ${written} 个文件。`)
    } else if (written === expected) {
      lines.push(`共 ${written} 帧。`)
    } else {
      // 帧数对不上要照实说：可能是帧范围外的段、也可能是中途丢帧。不替引擎圆
      lines.push(
        `⚠️ 目录里有 ${written} 个文件，按帧范围应为 ${expected} 帧，对不上。打开目录确认一下。`
      )
    }
    for (const f of s.sample_files ?? []) lines.push(`  ${f}`)
    // 渲完了但中途报过错（非致命）：照实转述，别让「完成」盖住它
    if (s.error) lines.push(`⚠️ 渲染过程中引擎报过错：${s.error}`)
    if (written === 0) {
      lines.push(
        '⚠️ 引擎说渲完了，但输出目录里一个文件都没有。先看输出日志里的 LogMovieRenderPipeline。'
      )
    }
  } else if (s.state === 'canceled') {
    lines.push(`渲染已取消：${head}。`)
    lines.push(`取消前已经写出的文件在 ${s.output_dir}（${s.files_written ?? 0} 个）。`)
  } else {
    lines.push(`渲染失败：${head}。`)
    lines.push(`原因：${s.error || '引擎没有给出原因，看输出日志里的 LogMovieRenderPipeline'}`)
    if ((s.files_written ?? 0) > 0) {
      lines.push(`失败前已经写出 ${s.files_written} 个文件，在 ${s.output_dir}。`)
    }
  }

  for (const w of j.warnings ?? []) lines.push(`⚠️ ${w}`)
  return lines.join('\n')
}

/** 合成结果 → 放在回执最前面的几行。失败时第一句就要说失败，不能让「渲染完成」打头 */
export function formatVideo(video: ComposedVideo | { error: string }, frameDir: string): string[] {
  if ('error' in video) {
    return [
      `⚠️ PNG 帧渲完了，但合成 MP4 失败：${video.error}`,
      `帧都在 ${frameDir}，不用重渲 —— 修好 FFmpeg 之后对这个目录重新合成即可。`,
      ''
    ]
  }
  const lines = [`已合成 MP4：${video.path}（${video.frames} 帧，H.264）`]
  if (video.gapWarning) lines.push(`⚠️ ${video.gapWarning}`)
  lines.push('')
  return lines
}

/** 帧率字符串从 `sequence.describe` 来，形如 `24/1`、`30000/1001`，FFmpeg 直接认 */
async function sequenceFps(sequencePath: string): Promise<string> {
  const d = await callUe<{ sequence?: { display_rate?: string } }>(
    'sequence.describe',
    { sequence_path: sequencePath, detail: 'names' },
    { timeoutMs: 30_000 }
  )
  const rate = d?.sequence?.display_rate
  if (!rate || !/^\d+(\/\d+)?$/.test(rate)) {
    throw new Error(
      `读不到 ${sequencePath} 的帧率（引擎回的是 ${String(rate)}），没法合成视频。还没开始渲染`
    )
  }
  return rate
}

/**
 * 只把填了的字段发给引擎，没填的由插件按自己的默认值处理。
 *
 * 格式、画质、渲染器在 schema 里故意不带 `.default()`：给了预设时，没填就该以预设为准，
 * 而 Zod 补上的默认值会被插件当成「用户要覆盖」。
 */
export function toRenderParams(input: RenderInput): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })

async function waitForRender(
  job: RenderStartOutput,
  ctx: ToolCallContext<RenderDetails>
): Promise<RenderStatusOutput> {
  let failures = 0
  let lastError = ''

  for (;;) {
    await sleep(POLL_MS, ctx.signal)
    // 停止由 abort 监听那边发取消；这里只管别再轮询
    if (ctx.signal?.aborted) {
      return {
        job_id: job.job_id,
        state: 'canceled',
        progress: 0,
        output_frame: 0,
        total_frames: 0,
        elapsed_seconds: 0,
        output_dir: job.output_dir
      }
    }

    let status: RenderStatusOutput
    try {
      status = await callUe<RenderStatusOutput>(
        'sequence.render_status',
        { job_id: job.job_id },
        { timeoutMs: 15_000 }
      )
      failures = 0
    } catch (error) {
      failures += 1
      lastError = error instanceof Error ? error.message : String(error)
      if (failures >= MAX_STATUS_FAILURES) {
        return {
          job_id: job.job_id,
          state: 'failed',
          progress: 0,
          output_frame: 0,
          total_frames: 0,
          elapsed_seconds: 0,
          output_dir: job.output_dir,
          error:
            `连续 ${MAX_STATUS_FAILURES} 次查不到渲染进度，编辑器可能卡死或崩溃了（最后一次：${lastError}）。` +
            `已经写出的帧还在 ${job.output_dir}。先调 ue_session_health 看编辑器还在不在`
        }
      }
      continue
    }

    if (status.state === 'rendering') {
      ctx.report({ text: formatProgress(status), details: { start: job, status } })
      continue
    }
    return status
  }
}

export function createSequenceRenderTool(): UnrealAgentTool<RenderDetails> {
  return defineTool<typeof InputSchema, RenderDetails>({
    name: 'sequence_render',
    namespace: NAMESPACE,
    risk: 'mutating',
    // 每次渲染都要用户当场点头：参数每次不同，而参数本身就是代价（几小时、几十 GB）
    requiresExplicitApproval: true,
    concurrency: 'sequential',
    description: `用 Movie Render Queue（MRQ）把一条 Level Sequence 渲成文件：序列帧（PNG / JPG / EXR / BMP），或者先出 PNG 再用 FFmpeg 合成 MP4。这是**引擎真实渲染**，不是 AI 生图。

【什么时候用】
用户说「出片」「渲染序列」「用 MRQ 渲」「出序列帧」「出 EXR 给合成」「渲个视频」。

【调之前】
1. 先跑 \`sequence_audit\`，FAIL 就先修 —— 黑屏、缺相机切轨的序列渲出来也是废片
2. 跟用户确认格式、画质档、分辨率。默认出 PNG 序列帧；要视频用 mp4（帧照样保留）。用户点名要的 MRQ 原生输出（EXR、MRQ 自带的 MP4 = mp4_mrq）照他说的来。拿不准就问，别靠渲两遍去试：每一遍都是真金白银的机器时间
3. 很长的序列先用 draft 档或 frame_start / frame_end 渲一小段，让用户看过再渲全片

【它做什么】
在编辑器里起一次 PIE 渲染（和 MRQ 窗口的 Render (Local) 一样），一直等到渲完，过程中推进度。渲染期间编辑器在跑 PIE，别的编辑器工具用不了。
用户按停止会取消渲染，已渲出的帧保留。

【需要】
项目要启用 Movie Render Queue 插件。没开时它会报出来 —— 用 project_manage 的 enable_plugins 开 MovieRenderPipeline，开完要重启编辑器。

【渲完】
回执给出输出目录和实际写出的文件数。把目录告诉用户；要看效果就截一帧给他。`,
    input: InputSchema,
    execute: async (input, ctx) => {
      // 要视频：开渲之前把 FFmpeg 和帧率都拿到，缺一样就别让用户白等几小时
      const wantVideo = input.format === 'mp4'
      let ffmpeg: string | null = null
      let fps = ''
      if (wantVideo) {
        ffmpeg = await findFFmpeg()
        if (!ffmpeg) return { text: FFMPEG_MISSING, isError: true }
        fps = await sequenceFps(input.sequence_path)
      }
      const params = toRenderParams(input)
      if (wantVideo) params.format = 'png'
      // 用户明确要 MRQ 自带的 MP4 编码器：原样交给插件（5.6 以下插件会报没有这个输出）
      if (input.format === 'mp4_mrq') params.format = 'mp4'

      let job: RenderStartOutput
      try {
        job = await callUe<RenderStartOutput>('sequence.render', params, {
          timeoutMs: 60_000,
          ...(ctx.signal ? { signal: ctx.signal } : {})
        })
      } catch (error) {
        // 第一次用最常见的就是这一条。下一步写死在报错里，比指望模型翻回描述可靠
        if (error instanceof Error && error.message.includes('MovieRenderPipeline')) {
          throw new Error(`${error.message}\n${MRQ_DISABLED_HINT}`)
        }
        throw error
      }
      if (!job?.job_id) {
        return { text: '失败：引擎没有返回渲染任务', isError: true }
      }

      ctx.report({
        text: `已开始渲染：${describeJob(job)}`,
        details: {
          start: job,
          status: {
            job_id: job.job_id,
            state: 'rendering',
            progress: 0,
            output_frame: 0,
            total_frames: 0,
            elapsed_seconds: 0,
            output_dir: job.output_dir
          }
        }
      })

      // 停止 = 取消。发出去就不管了：编辑器卡死时这条也会超时，那时 note 里的
      // 「已请求取消」就是全部真相
      const onAbort = (): void => {
        void callUeRaw(
          'sequence.render_cancel',
          { job_id: job.job_id },
          { timeoutMs: 15_000 }
        ).catch(() => undefined)
      }
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      ctx.setAbortNote?.(
        () =>
          ` 已向编辑器请求取消这次渲染（${job.sequence_path}）。` +
          `取消前已经写出的帧在 ${job.output_dir}。` +
          '要确认是否真的停了，看编辑器里的 PIE 渲染窗口还在不在。'
      )

      try {
        const status = await waitForRender(job, ctx)
        let text = formatResult(job, status)
        let video: RenderDetails['video']
        if (wantVideo && ffmpeg && status.state === 'finished' && !ctx.signal?.aborted) {
          ctx.report({
            text: 'PNG 帧渲完了，正在用 FFmpeg 合成 MP4…',
            details: { start: job, status }
          })
          try {
            video = await composeVideo({
              ffmpeg,
              frameDir: status.output_dir,
              fps,
              ...(ctx.signal ? { signal: ctx.signal } : {})
            })
          } catch (error) {
            video = { error: error instanceof Error ? error.message : String(error) }
          }
          text = [...formatVideo(video, status.output_dir), text].join('\n')
        }
        // 失败按错误交给模型；取消不是故障，是用户要的。合成失败也不算：帧是好的，回执第一句已经说了
        return {
          text,
          details: { start: job, status, ...(video ? { video } : {}) },
          isError: status.state === 'failed'
        }
      } finally {
        ctx.signal?.removeEventListener('abort', onAbort)
      }
    }
  })
}
