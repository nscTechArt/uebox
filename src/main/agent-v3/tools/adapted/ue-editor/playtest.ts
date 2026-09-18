/**
 * `ue_playtest` —— 把游戏跑起来，回一份「这段时间里发生了什么」。
 *
 * ## 为什么不是 start_pie / stop_pie 两个工具
 *
 * 那种两段式对调用方几乎没用：它把游戏跑起来了，然后看不见任何东西。
 * 而且会漏 —— 忘了调 stop，PIE 就一直挂着，之后所有引擎操作都作用在
 * 一个正在运行的游戏上。
 *
 * 一次调用跑固定时长、回一份报告，跑不漏也看得见。
 *
 * ## 报告里最重要的是 print_strings
 *
 * PrintString 是蓝图开发者唯一的调试手段，游戏里所有「我到这一步了」
 * 「血量是 3」都从那儿出。没有它，这个工具就退化成「跑了 5 秒，
 * 不知道发生了什么」。
 *
 * ## 画面那一半：为什么一张收尾截图不够
 *
 * 2026-09-17 的用户反馈：模型拿一张 PIE 截图就下定论。这不是模型偷懒 ——
 * 单帧里**物理上不含时间**。角色有没有动、门什么时候开的、第几秒开始变黑、
 * 东西生成完又消失了没有，这些信息在一张图里根本不存在，再强的模型也只能猜。
 * 而那张图构图正常、看着可信，正好够支撑一个错误结论。
 *
 * 所以有了 `frames`：按时间抓 N 帧，每九帧拼成一张九宫格进上下文
 * （拼图在 `contactSheet.ts`）。**格子大小恒定，时间盖得更长就多给一张图** ——
 * 帧数和图片数是两个旋钮：一张几格决定看不看得清，几张图决定盖多长时间。
 * 把三十六格塞进一张只会得到一张谁也看不清的图，那不是省预算，是白花。
 *
 * 两条抓帧的路都留着，用 `frame_mode` 切：
 *
 * - `scene`（默认）走 SceneCapture，和 `ue_screenshot` 默认那条同源 ——
 *   跟窗口状态无关，最小化被遮挡都出图，但**不画 UMG 界面层**。
 * - `window` 抓编辑器窗口那块像素，HUD、血条、Print String 的屏幕字都在，
 *   代价是编辑器面板一起进画面、窗口最小化就抓不到。
 *
 * 不做成两个工具、也不自动选：交付物是同一个（一张时间轴拼图），而
 * 「这次要不要看界面」只有调用方知道，判据不在我们手里。默认给 scene 是因为
 * 它不依赖窗口状态 —— 默认值可以错，但不能是「有时候什么都抓不到」。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import {
  editorScreenshotAllowed,
  EDITOR_SCREENSHOT_SKIPPED_NOTE
} from '../../../core/editorScreenshotScope'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { readScreenshotImage } from './screenshot'
import {
  buildContactSheets,
  describeContactSheets,
  type ContactSheet,
  type SheetFrame
} from './contactSheet'
import * as fs from 'fs/promises'
import * as path from 'path'
import { CONTACT_SHEET_MAX_WIDTH, compressForContext } from '../../contextImage'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

/** 收尾那一刻 PIE 世界的关卡组成，字段与 `ue_get_levels` 同源 */
interface PlaytestLevels {
  persistent?: { package: string; name: string; actor_count: number }
  is_world_partition?: boolean
  streaming_level_count?: number
  editor_only_levels?: string[]
  game_only_levels?: string[]
  streaming_levels?: Array<Record<string, unknown>>
}

interface PlaytestResponse {
  ok: boolean
  ran: boolean
  ended_by: 'duration' | 'error' | 'failed_to_start' | 'stopped_externally' | string
  elapsed_seconds: number
  requested_seconds: number
  print_strings: string[]
  errors: string[]
  warnings: string[]
  error_count: number
  warning_count: number
  actors_at_start?: number
  actors_at_end?: number
  actors_spawned?: number
  screenshot_path?: string
  screenshot_error?: string
  events?: Array<{ at: number; command: string; fired: boolean; accepted: boolean }>
  levels?: PlaytestLevels
  /** 按时间抓的帧。没抓成的那些也在里面，带 error；capture_ms 是这一帧卡了游戏多久 */
  frames?: Array<{ at: number; path?: string; error?: string; capture_ms?: number }>
  frame_mode?: 'scene' | 'window' | string
}

const PlaytestSchema = z.object({
  duration_seconds: z
    .number()
    .optional()
    .describe('跑多久，默认 5 秒，上限 60。够 BeginPlay 和几十帧 Tick 跑起来就行'),
  screenshot: z
    .boolean()
    .optional()
    .describe('结束前截一张玩家视角的画面，默认 true。截图会直接进上下文让你看到'),
  /**
   * 多帧采样。**这个工具唯一能回答「过程中发生了什么」的东西。**
   *
   * 收尾那一张截图里物理上不含时间：角色有没有动、门什么时候开的、
   * 第几秒开始变黑 —— 单帧里这些信息根本不存在，而一张构图正常的图
   * 足以让人照着它下一个关于「运行效果」的结论。这正是 2026-09-17
   * 用户反馈的那件事：拿一张图就下定论。
   */
  frames: z
    .number()
    .int()
    .min(0)
    .max(36)
    .optional()
    .describe(
      '抓几帧拼成时间轴拼图，默认 0（只有收尾那一张）。' +
        '移动、掉落、生成、变黑这些事单帧里看不出来。' +
        '**每 9 帧一张图**，格子大小恒定：9=一张，18=两张，27=三张。' +
        '每多一张就多一份图片预算，跑得久要看全程才往上加。时间在整段里均分，首尾各一帧。' +
        '抓一帧会让游戏卡约 0.1 秒（实测），帧数×0.1 秒超过时长两成就别信这次的流畅度'
    ),
  frame_times: z
    .array(z.number())
    .optional()
    .describe(
      '可选，每帧抓在开跑后第几秒，给了就不再均分。用来把帧钉在事件前后：' +
        '第 2 秒发了 ce OpenDoor 就传 [1.9, 2.1, 2.5, 3.5]。超过时长的夹到结尾'
    ),
  frame_mode: z
    .enum(['scene', 'window'])
    .optional()
    .describe(
      '默认 scene = 渲场景，跟窗口状态无关但**不含 HUD/UMG 界面层**；' +
        'window = 抓编辑器窗口，HUD 和屏幕字都在，代价是编辑器面板一起进画面、' +
        '窗口最小化就抓不到'
    ),
  stop_on_error: z
    .boolean()
    .optional()
    .describe('一出现运行时错误就提前停，默认 false。想快速定位崩溃点时用'),
  events: z
    .array(
      z.object({
        at: z.number().describe('开跑后第几秒发，必须小于 duration_seconds'),
        /**
         * 引擎那边走的是 `GEngine->Exec`，任何控制台命令都收 —— 但**收不回输出**。
         *
         * 注入用的是两参数 `Exec(World, Cmd)`，命令的文字输出进 GLog，而本次会话的
         * 捕获器只留 LogBlueprintUserMessages / Error / Warning 三档，
         * `obj list` 那种 Display 级的打印全被丢掉。
         *
         * 所以描述只能说到「能执行、能改状态」为止。写成「输出会进 print_strings」
         * 是拿一个不存在的能力去骗调用方：它会花掉一整次 5 秒试跑去查一件
         * 注定查不到的事，然后照着空数组下错结论。
         * （要真拿到输出得学 system.run_console_command，换三参数 Exec + FStringOutputDevice。）
         */
        command: z
          .string()
          .describe(
            '任意控制台命令。"ce OpenDoor" 触发玩家控制器上的自定义事件；' +
              'exec 函数、CheatManager 命令、改状态的 cvar 同样能发。' +
              '注意：命令自己的文字输出拿不回来，只有它引发的 PrintString 和报错会进报告'
          )
      })
    )
    .optional()
    .describe(
      '在指定时刻往游戏里发控制台命令，用来戳一下靠事件驱动的逻辑。' +
        '替代不了真实按键，也拿不回命令的输出'
    )
})

/**
 * 把报告读成一句结论。
 *
 * 模型不一定会逐条看数组，结论必须写进 summary 里 —— 尤其是
 * 「跑起来了但一行 PrintString 都没有」这种：它不是错误，但基本说明
 * 逻辑压根没执行。
 */
function summarize(response: PlaytestResponse): string {
  if (response.ended_by === 'failed_to_start') {
    return 'PIE 没能启动。关卡可能有问题，或者编辑器正忙。'
  }
  if (response.ended_by === 'stopped_externally') {
    return `游戏在跑满之前就停了（用户按了停止，或者游戏自己退出）——只跑了 ${response.elapsed_seconds} 秒。`
  }

  const parts: string[] = [`跑了 ${response.elapsed_seconds} 秒`]

  if (response.error_count > 0) {
    parts.push(`**${response.error_count} 个运行时错误**（见 errors）`)
  } else {
    parts.push('无运行时错误')
  }

  if (response.print_strings.length > 0) {
    parts.push(`${response.print_strings.length} 条 PrintString 输出`)
  } else {
    // 这条比「有错误」更容易被忽略，但往往同样致命
    parts.push('没有任何 PrintString 输出——如果逻辑里应该有打印，说明它没被执行')
  }

  if (response.actors_spawned !== undefined && response.actors_spawned !== 0) {
    parts.push(
      response.actors_spawned > 0
        ? `运行中新增 ${response.actors_spawned} 个 Actor`
        : `运行中减少 ${-response.actors_spawned} 个 Actor`
    )
  }

  if (response.warning_count > 0) {
    parts.push(`${response.warning_count} 个警告`)
  }

  /**
   * 「命令发出去了」和「引擎认这条命令」是两回事。
   *
   * 名字写错的 `ce` 命令会被静默忽略 —— 不点出来的话，模型会以为自己
   * 触发了那段逻辑，然后对着一份「什么都没发生」的报告去查别的地方。
   */
  const rejected = (response.events ?? []).filter((event) => event.fired && !event.accepted)
  if (rejected.length > 0) {
    parts.push(
      `**${rejected.length} 条注入命令引擎不认**（${rejected
        .map((event) => event.command)
        .join('、')}）——多半是事件名写错了，那段逻辑根本没被触发`
    )
  }

  /**
   * 「画面不对但一条错误都没有」的头号答案。
   *
   * 背景、地面、光照、后期处理体积经常整层挂在子关卡里，而子关卡的
   * 编辑器可见和游戏加载是两个独立开关 —— 那一层不加载，游戏里就是一片黑，
   * 日志干干净净，截图看着像渲染坏了。真机撞过一次（2026-09-07 Studio 关卡），
   * 排查绕了材质、bHidden、构造脚本三圈才落到这儿。
   *
   * PIE 世界一销毁这份信息就没了，所以插件在收尾那一刻当场取，这里必须说出来。
   */
  const editorOnly = response.levels?.editor_only_levels ?? []
  if (editorOnly.length > 0) {
    parts.push(
      `**${editorOnly.length} 个子关卡在这次游戏世界里不可见**（${editorOnly.join('、')}）——` +
        '它们在编辑器视口里看得见。如果画面里少了背景、地面或光照，' +
        '先看这条，再去查材质和 bHidden。' +
        '用 ue_get_levels 看这几层的 mismatch_reason 再决定怎么改：' +
        'not_loaded 要 always_loaded=true，loaded_but_hidden 要 should_be_visible=true'
    )
  }

  /**
   * 试玩截图和视口截图走同一条 SceneCapture 路（插件的 `CaptureSceneToFile`），
   * 所以同样**不画 UMG**。这里必须说，理由和 `screenshot.ts` 的
   * `describeUiLayer` 一字不差：返回写着「玩家视角」，模型就会把它当
   * 「玩家看到的东西」，而 HUD 那一层压根不在取景里。
   */
  if (response.screenshot_path) {
    parts.push(
      '截图只有场景，**不含 HUD / UMG 界面层和 Print String 的屏幕字** ——' +
        '画面里没有界面不代表界面没显示，要验界面用 ue_screenshot 的 show_ui=true 或 widget_preview'
    )
  }

  /**
   * 计划抓的帧和真抓到的帧对不上时必须点名。
   *
   * 少了的那几格不会在拼图上留下任何痕迹 —— 剩下的格子照样首尾相接，
   * 看着就是一条完整的时间轴。而漏掉的那一秒恰恰可能是出事的那一秒，
   * 「整段时间里什么都没发生」这种结论就是这么来的。
   */
  const planned = response.frames ?? []
  const lost = planned.filter((frame) => !frame.path)
  if (lost.length > 0) {
    const reasons = Array.from(new Set(lost.map((frame) => frame.error).filter(Boolean)))
    parts.push(
      `**计划抓 ${planned.length} 帧，有 ${lost.length} 帧没抓成**（${lost
        .map((frame) => `${frame.at}s`)
        .join('、')}${reasons.length > 0 ? `；${reasons.join('；')}` : ''}）——` +
        '拼图上的时间轴是不完整的，两格之间可能漏掉了事情'
    )
  }

  /**
   * 采样把被测的那次运行拖慢了多少。
   *
   * 每抓一帧游戏都当场卡一下（GPU 回读 + PNG 编码）。抓得太密时，
   * 报告里的「跑了 5 秒」就不是游戏跑了 5 秒 —— 掉帧、卡顿、定时器错位
   * 都可能是采样造成的，而模型会把它当成游戏本身的毛病去修。
   *
   * 阈值取 15%：低于这个数属于正常开销，说了是噪音；超了就必须说，
   * 因为那时候「运行效果」里已经掺进了工具自己的影子。
   */
  const stallMs = planned.reduce((sum, frame) => sum + (frame.capture_ms ?? 0), 0)
  const elapsedMs = response.elapsed_seconds * 1000
  if (stallMs > 0 && elapsedMs > 0 && stallMs / elapsedMs > 0.15) {
    parts.push(
      `**抓这 ${planned.length} 帧本身占掉了 ${Math.round(stallMs)}ms**` +
        `（这段时间游戏是卡住的，约占整段的 ${Math.round((stallMs / elapsedMs) * 100)}%）——` +
        '掉帧和卡顿这次不能算数，要测流畅度就把 frames 调小或关掉再跑一次'
    )
  }

  return parts.join('；')
}

/**
 * 这一组帧是怎么来的，能看见什么、看不见什么。
 *
 * 和 `screenshot.ts` 的 `describeUiLayer` 是同一条规矩，而且在时间轴上
 * 更要紧：九格里一格 HUD 都没有，比一张图里没有 HUD 更像「界面真的没显示」。
 */
/**
 * 把拼好的图存到磁盘，和那一批帧放在一起。
 *
 * ## 为什么必须存
 *
 * 界面上那个工具卡片显示的是**磁盘上的文件**（`AgentProcessLog.vue` 的
 * `findResultImageUrls`），不是进模型上下文那份 base64 —— base64 会随聊天记录
 * 写进 localStorage 把配额撑满，所以根本不发到渲染层。
 *
 * 不存盘的后果在 2026-09-17 真机上当场兑现了一次：模型收到了 4 张拼图、
 * 照着它们写了结论，而用户界面上只有收尾那一张截图。用户看到的是
 * 「跑了一下，出了一张图」，于是问「好像没运行，怎么触发」——
 * **人和模型看的不是同一批画面**，这比看不见更糟：用户没法复核模型说的话。
 *
 * 存在那批帧旁边（UE 工程的 `Saved/Screenshots/UAL/`），不新开目录概念。
 * 存不下不算失败：图已经在模型手里了，扔掉它换一句报错是最差的处理。
 */
async function saveSheets(sheets: ContactSheet[], nearFrame: string): Promise<string[]> {
  const dir = path.dirname(nearFrame)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  const saved: string[] = []
  for (let index = 0; index < sheets.length; index++) {
    const file = path.join(dir, `UAL_PieSheet_${stamp}_${index + 1}.png`)
    try {
      await fs.writeFile(file, sheets[index].buffer)
      saved.push(file)
    } catch (error) {
      console.warn('[PlaytestTool] 拼图存盘失败，界面上会少一张:', error)
    }
  }
  return saved
}

function describeFrameMode(mode: string | undefined): string {
  if (mode === 'window') {
    return (
      '这些帧抓的是**编辑器窗口那块像素**：HUD、血条、Print String 的屏幕字都在画面里，' +
      '但编辑器的面板和工具栏也一起进来了 —— 游戏画面只占其中一块，' +
      '实际能看清的游戏内容比格子尺寸还要小一圈。'
    )
  }
  return (
    '这些帧是直接渲染的**场景**，和 ue_screenshot 默认那条路一样：' +
    '**画面里不含 UMG 界面层** —— HUD、血条、菜单、Print String 的屏幕字都不会出现，' +
    '哪怕它们正显示在用户屏幕上。所以九格里都没有 HUD **不等于 HUD 没显示**。' +
    '要看界面随时间怎么变，重跑一次并传 frame_mode="window"。'
  )
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createPlaytestTool() {
  return defineV2Tool({
    description: `把当前关卡跑起来（PIE），跑几秒后停下，回报这段时间里发生了什么。

做完东西之后**用它验一下真的能跑**——编译通过只说明语法对，不说明运行时不炸。

返回里看三样：
- **print_strings**：蓝图 PrintString 的输出。逻辑有没有走到、值对不对，全靠它。
  想验某段逻辑执行了，就在那段逻辑里放一个 PrintString，再跑这个工具。
- **errors**：运行时错误（Accessed None 之类）。这才是「游戏到底能不能跑」。
- **screenshot**：结束时的画面，直接进上下文。它和采样帧默认渲的都是**场景**，
  **HUD、UMG 和 Print String 的屏幕字都不在里面** —— 图里没有界面不代表界面没显示。
  验界面用 frame_mode="window" 或 ue_screenshot 的 show_ui=true。
- **levels**：收尾那一刻游戏世界由哪些关卡组成。levels.editor_only_levels 里的子关卡
  **在编辑器视口里看得见，但没进这次游戏世界** —— 画面里少了背景、地面或光照
  而日志又干干净净时，先看这一条。

## ⚠️ 一张收尾截图看不出「跑起来什么样」

单帧里**不含时间**：动没动、门什么时候开的、第几秒变黑、生成完又没了 ——
这些在一张图里根本不存在，而那张图看着可信，足以支撑一个错误结论。

**判断运行效果就传 frames**：frames=9 抓 9 帧拼成一张九宫格进上下文，每格烧着
「序号 · 第几秒」，左到右、上到下就是时间顺序。**每 9 帧一张图**（18=两张、27=三张），
格子大小恒定，时间盖得更长就多一张 —— 每张多一份预算，别无脑拉满。
每格三四百像素：看得出东西在哪、动没动、黑没黑；**看不清材质、小物件和文字**。

## 往游戏里发命令

events: [{ at: 2, command: "ce OpenDoor" }] 能在开跑第 2 秒往游戏里发一条
控制台命令。**任何控制台命令都行**，不限于 "ce"："ce <事件名>" 触发
**玩家控制器蓝图上**的自定义事件，exec 函数、CheatManager 命令、改状态的
cvar 也都能发。

**但拿不回命令自己的输出。** "obj list"、"stat"、查 cvar 当前值这类查询发得出去、
看不到结果 —— 试玩的日志捕获只收 PrintString、报错和警告三档。想看查询结果
要等试玩结束再用 ue_run_console_command。

命令引发的 PrintString 和错误照常进 print_strings / errors。
返回的 events 里 accepted=false 表示引擎不认这条命令（多半事件名写错了）。

## 它验不了什么

**没法模拟玩家输入。** 只有自己会跑的东西才验得到：BeginPlay、Tick、物理、
定时器、碰撞、自动生成。像「按 E 开门」这种要按键才触发的逻辑，
这个工具**碰不到**——跑出一份干净的报告不代表那部分能用，不要据此
告诉用户「游戏没问题」。

## 用之前

**不需要先保存。** PIE 复制的是编辑器内存里的当前世界，没落盘的改动一样跑得到
（真机验过：刚摆进关卡、关卡还没保存的 Actor，它的 BeginPlay 照样执行）。
蓝图改完编译过就行。

保存是另一回事——干完活记得 ue_save，那是为了别丢，不是为了让试玩看见。

编辑器已经在 Play 模式时会被拒绝。`,

    inputSchema: PlaytestSchema,

    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        /*
         * 用户关掉「允许编辑器截图」时**强制不截**，而不是把整个工具摘掉。
         *
         * 试玩的正事是把游戏跑起来读日志，截图只是它的一个可选参数（插件那边
         * 默认还是 true）—— 整个摘掉等于拿一个隐私开关顺手关掉了「验证游戏
         * 到底能不能跑」这件事。这里显式传 false：不传的话插件照样会渲一帧
         * 玩家视角的画面存到磁盘上。
         */
        const screenshotBlocked = !editorScreenshotAllowed()
        const captureScreenshot = screenshotBlocked ? false : input.screenshot

        const params: Record<string, unknown> = {}
        if (input.duration_seconds !== undefined) params.duration_seconds = input.duration_seconds
        if (captureScreenshot !== undefined) params.screenshot = captureScreenshot
        if (input.stop_on_error !== undefined) params.stop_on_error = input.stop_on_error
        if (input.events?.length) params.events = input.events

        // 多帧采样也是编辑器截图，同一个开关管着。关着时一帧都不发出去 ——
        // 少了这一句，一个明确关掉的隐私开关会被「换个参数」绕过去
        if (!screenshotBlocked) {
          if (input.frames !== undefined) params.frames = input.frames
          if (input.frame_times?.length) params.frame_times = input.frame_times
          if (input.frame_mode) params.frame_mode = input.frame_mode
        }

        /**
         * 超时要比「跑多久」宽出一大截。
         *
         * 插件那边还有 30 秒启动窗口（大关卡加载）+ 截图 + 收尾。
         * 卡在传输超时上会让一次正常的试跑看起来像失败，而 PIE 其实
         * 还在跑——那才是最糟的状态。
         */
        const durationMs = (input.duration_seconds ?? 5) * 1000
        const timeoutMs = durationMs + 120000

        const response = await wsService.callRequest<PlaytestResponse>(
          'pie.run',
          params,
          getTargetConnectionId(),
          timeoutMs
        )

        if (!response) {
          return { success: false, error: '插件没有响应（pie.run）' }
        }
        if (!response.ok) {
          const message = (response as unknown as { error?: string })?.error || '试玩失败'
          return { success: false, error: message }
        }

        // 关着截图时一张也不读。上面已经让插件别拍了，这一句管的是「插件没听懂
        // 那个参数」（旧版本）—— 那时它仍然会回一个路径，读进去就等于开关白关
        const images =
          response.screenshot_path && !screenshotBlocked
            ? await readScreenshotImage(response.screenshot_path)
            : []

        /**
         * 把按时间抓的那些帧拼成**一张**图。
         *
         * 不是 N 张各自进上下文：那样是 N 份图片预算（一张 768 的截图就值
         * 几万 token），而且模型还得自己在 N 个附件之间建立先后关系 ——
         * 它会自己编一个顺序出来，然后拿编出来的顺序讲因果。
         * 拼成一张之后顺序是画面上的空间关系，编不了。
         */
        const captured: SheetFrame[] = (response.frames ?? [])
          .filter((frame): frame is { at: number; path: string } => Boolean(frame.path))
          .map((frame) => ({ path: frame.path, at: frame.at }))

        const sheets =
          captured.length > 0 && !screenshotBlocked ? await buildContactSheets(captured) : []
        const sheetImages = await Promise.all(
          sheets.map((sheet) =>
            compressForContext(sheet.buffer, { maxWidth: CONTACT_SHEET_MAX_WIDTH })
          )
        )

        // 拼图排在收尾那张前面、彼此按时间先后：先看完整段过程，再看最后定格。
        // 压不进去的那张**不能假装有** —— 少一张图而说明里写着四张，
        // 模型会对着不存在的那一段下结论
        const shown = sheets.filter((_, index) => sheetImages[index])
        images.unshift(
          ...sheetImages
            .filter((image) => image)
            .map((image) => ({ data: image!.data, mimeType: image!.mimeType }))
        )

        // 界面显示的是磁盘上的文件，不是上面那份 base64 —— 不存盘的话
        // 模型看到 4 张拼图、用户只看到收尾一张截图，他没法复核模型说的话
        const sheetPaths =
          shown.length > 0 && captured[0] ? await saveSheets(shown, captured[0].path) : []

        const dropped = sheets.length - shown.length
        const sheetNote =
          sheets.length === 0
            ? ''
            : shown.length === 0
              ? `\n⚠️ 抓到了 ${captured.length} 帧，但拼出来的图太大没能进上下文，这次你看不到画面。` +
                `把 frames 调小一点重跑一次。`
              : `\n${describeContactSheets(
                  shown,
                  sheetImages.filter((image) => image).map((image) => image!.width)
                )}\n${describeFrameMode(response.frame_mode)}` +
                (dropped > 0
                  ? `\n⚠️ 还有 ${dropped} 张拼图太大没进上下文，那几段时间你没看到。`
                  : '')

        // 启动失败算调用失败：什么都没跑起来，没有任何结论可给
        if (response.ended_by === 'failed_to_start') {
          return { success: false, error: summarize(response), ended_by: response.ended_by }
        }

        return {
          success: true,
          ran: response.ran,
          ended_by: response.ended_by,
          elapsed_seconds: response.elapsed_seconds,
          print_strings: response.print_strings,
          errors: response.errors,
          warnings: response.warnings,
          error_count: response.error_count,
          warning_count: response.warning_count,
          ...(response.actors_spawned !== undefined
            ? {
                actors_at_start: response.actors_at_start,
                actors_at_end: response.actors_at_end,
                actors_spawned: response.actors_spawned
              }
            : {}),
          ...(response.events?.length ? { events: response.events } : {}),
          ...(response.levels ? { levels: response.levels } : {}),
          ...(images.length > 0 ? { images } : {}),
          // 路径要留在返回值里：进上下文的那张图是压过的，界面显示的是磁盘上这张原图。
          // 关着截图时连路径都不回 —— 回了等于告诉模型「磁盘上有一张，自己去读」
          ...(response.screenshot_path && !screenshotBlocked
            ? { screenshot_path: response.screenshot_path }
            : {}),
          ...(response.screenshot_error ? { screenshot_error: response.screenshot_error } : {}),
          // 每一帧的时刻和路径都留着：拼图里的格子很小，模型要核对哪一格是
          // 第几秒、或者想让用户去看原图时，靠的是这份清单
          ...(response.frames?.length
            ? { frames: response.frames, frame_mode: response.frame_mode ?? 'scene' }
            : {}),
          // 界面按这个字段铺图。拼图排前面、收尾那张排后面，和模型看到的顺序一致 ——
          // 两边看的不是同一批画面时，用户没法复核模型说的话
          ...(sheetPaths.length > 0
            ? {
                image_paths: [
                  ...sheetPaths,
                  ...(response.screenshot_path && !screenshotBlocked
                    ? [response.screenshot_path]
                    : [])
                ]
              }
            : {}),
          // 没出图必须说清楚是**用户关的**，不是试玩失败。不说的话模型只会看见
          // 一份没有图的报告，然后再调一次 ue_screenshot 去补 —— 那次同样会被挡
          summary:
            summarize(response) +
            sheetNote +
            (screenshotBlocked ? `\n${EDITOR_SCREENSHOT_SKIPPED_NOTE}` : '')
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
