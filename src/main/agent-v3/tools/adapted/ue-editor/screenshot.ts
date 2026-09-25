/**
 * 抓取当前画面截图。
 *
 * 从 Editor 视口抓屏，**图片直接进模型上下文**。
 *
 * ## 两条路，一个入口
 *
 * `show_ui: false`（默认）渲染场景；`show_ui: true` 抓整个编辑器窗口
 * （`editor.capture_app_window`，见下面的 `captureAppWindow`）。
 * 不拆成两个工具：交付物是同一个（一张图进上下文），拆开只会让模型
 * 在两个名字之间挑，而挑错的代价是拍回一张没有它要找的东西的图。
 *
 * ## 抓窗口时抓的是哪一扇
 *
 * 不传 `window` 时插件拍**用户最后用过的那扇**编辑器窗口（蓝图编辑器浮在外面
 * 就是蓝图编辑器）；有模态弹窗时拍弹窗。以前一律落到主关卡窗口：用户在盒子里
 * 敲字的那一刻引擎所有窗口都失活，Slate 的「活跃窗口」是空，插件就退回第一扇，
 * 而第一扇永远是主窗口 —— 用户开着蓝图说「看看我这张图」，拍回去的却是场景。
 * 传 `window`（资产名或路径，或 `level`）可以点名。插件回 `window_title` 和
 * `window_source`，贴进 message：拍到的是哪扇窗口，模型必须知道。
 *
 * ## 拍哪个世界由插件自己判断
 *
 * PIE 在跑就拍**正在跑的游戏世界**（玩家视角），没在跑才拍编辑器世界。
 * 以前一律拍编辑器世界：游戏跑着的时候截回来的是一张看着正常、
 * 但和游戏里发生的事完全无关的图 —— 角色跑到哪、门开没开、生成了什么，
 * 那张图里统统没发生，而模型分不出来，会拿它去下运行时的结论。
 *
 * 判据是客观的（有没有 PIE 世界），没有需要人来定的地方，所以不做成必填参数。
 * `world: 'editor'` 是唯一的例外口子：PIE 跑着但要看编辑器场景本身时才用。
 *
 * ## 机位是哪来的，也必须回上去
 *
 * 插件取不到透视视口时会退回一台固定相机（原点上方、俯角 30°），照样出图、
 * 照样 `saved: true`。这两种情况原来在返回值里**完全分不出来** —— 于是一张
 * 构图随机的图会被当成场景的真实样子：画面里没有要找的东西，就得出「东西没摆上」
 * 的结论，接着去修一个不存在的问题。
 *
 * 所以插件现在回 `camera_source`（viewport / player / fallback）和机位坐标，
 * fallback 时这一侧翻成一条 ⚠️ 贴进 message。和 `world` 字段是同一条规矩：
 * **一张图的结论对不对，取决于它是从哪儿拍的，那就不能只有我们知道。**
 *
 * 原来唯一的出图途径是上传 S3 换 URL —— 没配凭据就必定失败（社区版默认
 * 就没有），降级成 file:// 而模型打不开。已经移除：图片现在本地压缩后
 * 直接返回，既不依赖外部服务，也不用把用户的编辑器画面传到第三方存储。
 *
 * ## 已经移除的 `analyze` 参数
 *
 * V2 的主模型看不见图，所以这里有过一条绕路：把截图发给另一个视觉模型，
 * 让它写一段中文描述，再把那段文字回给主模型。在「模型看不见图」的前提下
 * 这是唯一的办法。
 *
 * 现在图片本来就进上下文，那条路的收益归零，代价却全留着 —— 多一次完整的
 * 模型调用、多一个「必须绑定视觉模型」的依赖，换回来的是一段模型自己
 * 看一眼就知道的话，而且还隔了一手转述。一并删掉的还有 `image_url`：
 * 那是个 `file:///` 本地路径，模型打不开，每次都白发。
 *
 * ## 曝光：不再叫模型「别信亮度」
 *
 * 描述里原来写着「这张图亮度不准，别因为它去调灯光或曝光，那是截图偏差」。
 * 2026-09-26 科幻塔防里这句话成了借口：关卡美术在自动曝光下调了四轮灯，
 * 每张图都「一片蓝、发白」，最后认定「截图自动曝光补偿，实际视口更暗」收工 ——
 * 用户的视口一样亮。偏差只在自动曝光时存在（插件在 `UAL_SetupSceneCapture`
 * 里尽量对齐，但自适应的收敛点本来就不固定）；锁成手动曝光后截图、视口、
 * 游戏同一个亮度。所以现在说的是「先查锁没锁」，不是「别信」。
 *
 * ## 「等一下再拍」这件事在插件里做，不在这里 sleep
 *
 * 在这一侧 sleep 一两秒是**没用**的，别再加：截图不是打开快门等曝光，
 * 插件那条路是按需渲帧、立刻读回。等待期间那台相机一帧都没渲，
 * 眼适应、Lumen、TSR 的历史全都停在原地（引擎源码依据记在
 * `UAL_EditorCommands.cpp` 的 `UAL_TickAsyncCapture` 上面）。
 *
 * 真正要等的是三样确定的信号，插件里都等了：着色器/资产编译完、
 * 贴图流送冲干净、预热帧渲够。等不到位会原样回到 `pending_*` 字段，
 * 由 `describeReadiness` 翻成一句警告贴进 message。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { getAppWindows } from '../../../../appWindows'
import { serviceManager } from '../../../../services'
import * as fs from 'fs/promises'

import {
  editorScreenshotAllowed,
  editorScreenshotRefusal
} from '../../../core/editorScreenshotScope'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { compressForContext } from '../../contextImage'
import { describeCameraAim } from '../../ueOrientation'
import { describeViewportProvenance } from './viewportProvenance'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

// ============================================================================
// Schema 定义
// ============================================================================

/**
 * 抓取截图请求参数
 */
const ScreenshotParamsSchema = z.object({
  filepath: z
    .string()
    .optional()
    .describe('可选，文件名或路径，默认按时间戳命名保存到 Saved/Screenshots/UAL/'),
  // Gemini 原生 API 不支持 z.tuple (会转换为 JSON Schema 的 items 字段)，改用 object
  resolution_width: z.number().optional().describe('可选，截图宽度，默认 1920'),
  resolution_height: z.number().optional().describe('可选，截图高度，默认 1080'),
  show_ui: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      '可选，默认 false = 只拍场景（大纲、细节面板、弹窗都不在画面里）。' +
        'true = 拍**整个编辑器窗口**：面板、菜单、报错弹窗都看得见。' +
        '「界面上弹了个框」「这个面板里显示的是什么」用 true；' +
        '看场景本身一律用 false —— 那条路直接渲染，窗口最小化或被挡住也能出图'
    ),
  window: z
    .string()
    .optional()
    .describe(
      '可选，只在 show_ui=true 时有效：点名拍哪个资产编辑器窗口，传资产名或路径' +
        '（如 BP_Door、/Game/BP/BP_Door），传 level 拍主关卡窗口。' +
        '不传就拍用户最后用过的那扇窗口（有弹窗时拍弹窗），通常就是对的；' +
        '只有拍回来不是要看的那扇时才点名'
    ),
  world: z
    .enum(['auto', 'editor'])
    .optional()
    .describe(
      '可选，截哪个世界，默认 auto —— PIE 在跑就拍游戏世界（玩家视角），' +
        '没在跑就拍编辑器世界。只有 PIE 跑着但你要看编辑器场景本身时才传 editor'
    ),
  warmup_frames: z
    .number()
    .int()
    .min(0)
    .max(16)
    .optional()
    .describe(
      '可选，正式那帧之前先渲几帧预热，默认 4。Lumen 的全局光、虚拟阴影贴图、' +
        'TSR 都是**每帧攒一点历史**，帧数不够画面会有噪点、阴影缺角。' +
        '嫌图脏就调大（每帧约 16ms），赶时间可以调到 0'
    )
})

// ============================================================================
// 类型定义
// ============================================================================

/** 截图响应数据 (UE 插件返回) */
interface ScreenshotResponse {
  path: string
  filename: string
  width: number
  height: number
  saved: boolean
  show_ui: boolean
  /** 'scene_capture' = 主动渲染（不依赖窗口）；缺省表示走了旧的 HighResShot */
  method?: string
  /** 'pie' = 拍的是正在跑的游戏世界；'editor' = 编辑器世界 */
  world?: 'pie' | 'editor'
  /** 'player' = 玩家视角；'viewport' = 编辑器视口那台相机 */
  view?: 'player' | 'viewport'
  base64?: string
  save_error?: string
  restore_app_window?: boolean // 是否需要恢复应用窗口到前台
  /** 拍下这一帧时还有多少资产没编译完（纹理、静态网格体等）。0 才算干净 */
  pending_assets?: number
  /** 还有多少着色器编译任务没完。>0 意味着材质可能还是灰的 */
  pending_shaders?: number
  /** 流送冲完之后仍在飞的请求数。>0 意味着贴图可能还是糊的 */
  streaming_in_flight?: number
  /** 实际用了几帧预热 */
  warmup_frames?: number
  /** 为了等编译花掉的毫秒数 */
  wait_ms?: number
  /**
   * 这一帧的机位是哪来的。
   * viewport = 编辑器视口那台相机；player = PIE 玩家视角；
   * fallback = 没找到透视视口，用的是兜底机位（原点上方，俯角 30°）
   */
  camera_source?: 'viewport' | 'player' | 'fallback'
  /** 拍这一帧用的相机位置，单位厘米 */
  camera_location?: { x: number; y: number; z: number }
  camera_rotation?: { pitch: number; yaw: number; roll: number }
}

/**
 * 把「这张图到底准备好了没有」翻译成一句人话，没问题就返回空串。
 *
 * 必须说出来，不能咽掉：着色器没编完时材质是灰的、贴图没流完时是糊的，
 * 而模型光看图分不出「材质坏了」和「材质还没编完」—— 它会去修一个
 * 根本不存在的问题。插件已经尽力等过了（编译等到零、流送冲一次），
 * 这里报的是**等到上限仍然没干净**的残留。
 */
function describeReadiness(response: ScreenshotResponse): string {
  const notes: string[] = []
  if ((response.pending_shaders ?? 0) > 0) {
    notes.push(`还有 ${response.pending_shaders} 个着色器在编译，材质可能显示为灰色/默认棋盘`)
  }
  if ((response.pending_assets ?? 0) > 0) {
    notes.push(`还有 ${response.pending_assets} 个资产在编译`)
  }
  if ((response.streaming_in_flight ?? 0) > 0) {
    notes.push(`还有 ${response.streaming_in_flight} 个贴图流送请求没回来，贴图可能偏糊`)
  }
  if (notes.length === 0) return ''
  return `\n⚠️ 这一帧不是最终画面：${notes.join('；')}。不要据此判断材质或贴图有问题，等一会儿再截一张。`
}

/**
 * PIE 那一帧必须说清：这条路渲的是**场景**，界面层不在里面。
 *
 * `editor.screenshot` 走 `USceneCaptureComponent2D`（插件
 * `UAL_EditorCommands.cpp` 的 `UAL_SetupSceneCapture` / `CaptureSceneToFile`），
 * 渲的是场景本身；UMG 是 Slate 画在玩家视口**上面**的一层，HUD 画布文字
 * （Print String、`DrawText`）同理 —— 两者都不进 SceneCapture 的取景。
 *
 * 不说这一句的代价在 2026-09-16 的反馈里兑现过一次：模型给 HUD 截图核对，
 * 返回写着「正在跑的游戏世界，玩家视角」，画面里干干净净没有 HUD，
 * 而用户屏幕上那行大字一直显示着。它读到的是「玩家看到的东西」，
 * 于是拿属性读数当证据交付了一个假阳性结论，被用户截图抓出来。
 *
 * **缺的东西根本不画**，所以模型光看图分不出「HUD 没显示」和「HUD 不在这张图里」。
 * 只在 PIE 那一帧说：编辑器世界里本来就没有运行时界面，说了是噪音。
 */
function describeUiLayer(response: ScreenshotResponse): string {
  if (response.world !== 'pie') return ''
  return (
    `\n⚠️ 这一帧是直接渲染场景，**画面里不含 UMG 界面层** —— HUD、血条、菜单、` +
    `Print String 的屏幕字都不会出现，哪怕它们正显示在用户屏幕上。` +
    `所以图里没有 HUD **不等于 HUD 没显示**，不要拿这张图确认界面。` +
    `要核对界面：show_ui=true 拍一张编辑器窗口（PIE 画面连同 HUD 都在里面），` +
    `或者 widget_preview 渲染那个 Widget 本身。`
  )
}

/**
 * 机位不是视口那台相机时，必须挑明。
 *
 * 插件取不到透视视口就退回一台固定相机（原点上方 5 米、俯角 30°），
 * 截图照样 success、照样 saved —— 从返回值里完全看不出构图是随机的。
 * 实测里的代价是：拿这张图去核对场景摆放，看不见要找的东西，
 * 于是去修一个根本不存在的问题，再顺着错误结论多烧几轮。
 *
 * 老版本插件不回 camera_source，那就一个字都不加 —— 说不准的时候不说，
 * 好过替插件编一个我们没确认的事实（和 world 字段同一条规矩）。
 */
function describeCamera(response: ScreenshotResponse): string {
  // 机位朝哪先说一句，三个裸角度看不出「仰视」，这一句看得出。
  // 真机上参考机位漂成仰视 33.6°，截回一片蓝天，模型以为场景没了
  const aim = describeCameraAim(response.camera_rotation)
  const source =
    response.camera_source === 'viewport'
      ? '编辑器视口那台相机'
      : response.camera_source === 'player'
        ? 'PIE 玩家视角'
        : ''
  const aimLine = aim ? `\n这一帧的机位${source ? `（${source}）` : ''}：${aim}。` : ''

  // 拍的是用户视口时，说清这个视口最后一次是被哪次调用挪的。真机上模型用 Python
  // 把镜头写成朝天，拍回一片云后怀疑的是场景而不是自己那行代码
  if (response.camera_source === 'viewport') return aimLine + describeViewportProvenance()
  if (response.camera_source !== 'fallback') return aimLine
  const at = response.camera_location
  const where = at ? `（${at.x}, ${at.y}, ${at.z}）厘米` : '一个固定的兜底位置'
  return (
    aimLine +
    `\n⚠️ 没找到编辑器的透视视口，这一帧是从${where}的兜底机位拍的，` +
    `**不是用户屏幕上看到的画面**。构图是随机的：画面里没有某个东西，` +
    `不代表它不在场景里。先用 ue_focus_viewport 对准目标再截一张，` +
    `或者请用户自己截图确认。`
  )
}

// ============================================================================
// 工具定义
// ============================================================================

/**
 * 创建截图工具
 * @returns 截图工具实例
 */
/** 插件侧自己的超时：定时器每 2 秒查一次，最多 15 次。改插件时这个数要跟着改 */
const PLUGIN_SCREENSHOT_TIMEOUT_MS = 30_000

/**
 * 拍窗口前**不在这一侧抬窗口**。
 *
 * 曾经有过一段 PowerShell 对进程主窗口 `ShowWindow(SW_RESTORE)`，理由是
 * 「插件主线程卡着时进程外还能救一下」—— 但主线程卡着时插件同样答不了这条
 * 请求，救不到；代价却是实打实的：它激活的是**主窗口**，Slate 随即把主窗口
 * 记成活跃窗口，插件那边「用户最后用过的窗口」就被顶掉 —— 用户在看蓝图编辑器，
 * 拍回去的却是场景。最小化的还原交给插件：它对**选中的那扇**窗口 `Restore()`。
 *
 * 以下做法都试过并排除，别再走一遍：
 * - `SetForegroundWindow`：受 Windows 前台限制，同一段代码两次调用一次 True
 *   一次 False，靠不住；而且会抢走用户正在打字的焦点。
 * - `AttachThreadInput` + `SetForegroundWindow`：能让 `GetForegroundWindow()`
 *   报出目标句柄，但**真实焦点并没有转移**，截图照样超时。
 * - 关节流（`Slate.bAllowThrottling 0`）、解限帧（`t.MaxFPS 0`）：与结果不相关。
 * - 靠 `render_thread_ms === 0` 探测"没在渲染"再提前报错：判据是错的，
 *   这个引擎全局量在本机任何时候都是 0，包括截图成功那次 —— 100% 误报。
 */

/**
 * 读截图，压到能进上下文的大小。
 *
 * 导出给 PIE 试玩复用 —— 试玩的截图和视口截图进上下文的代价完全一样，
 * 另起一份迟早漂移。压缩本身（尺寸、体积上限、为什么一律重新编码）
 * 见 `tools/contextImage.ts`，AI 生图那条路也用同一份。
 */
export async function readScreenshotImage(
  filePath: string | undefined
): Promise<Array<{ data: string; mimeType: string }>> {
  if (!filePath) return []
  try {
    const compressed = await compressForContext(await fs.readFile(filePath))
    return compressed ? [compressed] : []
  } catch (error) {
    console.warn('[ScreenshotTool] 读取截图失败:', error)
    return []
  }
}

/** 窗口截图是一次 GDI 抓屏，不排队等渲帧 —— 不需要视口那条路的 30 秒 */
const APP_WINDOW_TIMEOUT_MS = 20_000

/** editor.capture_app_window 的返回。没有 world / 机位 / 编译进度那些字段：它不渲染，只抓屏 */
interface AppWindowShotResponse {
  path: string
  filename: string
  width: number
  height: number
  saved: boolean
  /** 拍到的那扇窗口的标题，老插件不回 */
  window_title?: string
  /**
   * 这扇窗口是怎么选出来的：requested（点名）/ modal（弹窗，点了名也优先拍它）/
   * last_active（用户最后用过的）/ fallback（点名的定位不到窗口，或全落空，退回主窗口）。
   * 老插件不回
   */
  window_source?: string
}

/**
 * 拍整个编辑器窗口 —— 面板、菜单、弹窗都在画面里。
 *
 * ## 为什么不是视口截图加个开关
 *
 * 视口那条路（SceneCapture / HighResShot）渲的是**场景**。用户说「界面上弹了个
 * 错你看看」时，那个弹窗根本不在渲染结果里 —— 拍回去的是一张构图正常、
 * 但没有任何报错信息的场景图，而模型看不出少了东西，会直接回「没看到报错」。
 *
 * 插件的 `editor.capture_app_window` 走的是 Slate 顶层窗口的 GDI 抓屏
 * （Windows 用 PrintWindow + PW_RENDERFULLCONTENT，其余平台用
 * `FSlateApplication::TakeScreenshot`），拿的是用户屏幕上那一份。
 * 这条命令 2026-08-31 的工具体检就点名过「插件有、工具没接」，一直空着。
 *
 * 抓哪扇窗口由插件定（见文件头「抓窗口时抓的是哪一扇」）：点名优先，
 * 其次是模态弹窗，再是用户最后用过的那扇。拍到的是哪扇、怎么选的，
 * 一并贴进 message —— 拍错窗口的图看着完全正常，模型自己看不出来。
 */
async function captureAppWindow(
  filepath: string | undefined,
  window: string | undefined,
  abortSignal?: AbortSignal
): Promise<Record<string, unknown>> {
  const wsService = serviceManager.getWebSocketService()
  const params: Record<string, unknown> = {}
  if (filepath) params.filepath = filepath
  if (window) params.window = window

  console.log('[ScreenshotTool] 发送 editor.capture_app_window 请求:', params)

  const response = await wsService.callRequest<AppWindowShotResponse>(
    'editor.capture_app_window',
    params,
    getTargetConnectionId(),
    APP_WINDOW_TIMEOUT_MS,
    abortSignal
  )

  if (!response) {
    return { success: false, error: '服务未返回有效数据' }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = response as any
  if (raw?.ok === false || raw?.success === false) {
    return {
      success: false,
      error: `编辑器窗口截图失败：${raw?.error || raw?.message || '未知原因'}`,
      code: raw?.__rpc?.code ?? raw?.code,
      details: raw?.details,
      raw: response
    }
  }

  // 保存失败时没有文件可读，images 为空 —— 不能报 success
  const images = await readScreenshotImage(response.path)
  if (!response.saved || images.length === 0) {
    return {
      success: false,
      error:
        '窗口截图没能落盘或读不回来，这一张作废。' +
        '确认编辑器窗口没有最小化，再试一次；仍然不行就请用户自己截一张。',
      path: response.path
    }
  }

  return {
    success: true,
    path: response.path,
    filename: response.filename,
    width: response.width,
    height: response.height,
    saved: true,
    window_title: response.window_title,
    window_source: response.window_source,
    images,
    message:
      `编辑器窗口截图（${response.width}x${response.height}）—— 画面是**用户屏幕上那一份**，` +
      `面板、菜单、弹窗都在里面。\n` +
      describeCapturedWindow(response, window) +
      `这张图看不到场景的渲染细节（亮度、材质、阴影都按编辑器当前显示走），` +
      `要看场景本身用 show_ui=false 再拍一张。`
  }
}

/**
 * 把「拍到的是哪扇窗口」说给模型听。
 *
 * fallback 单独警告：那是所有判据都落空后退回的主窗口，和用户在看的那扇
 * 没有关系。一张拍错窗口的图看着完全正常，模型分不出来，会拿它下结论。
 */
function describeCapturedWindow(
  response: AppWindowShotResponse,
  requestedWindow: string | undefined
): string {
  if (!response.window_title && !response.window_source) {
    // 老插件不认 window：点了名却没回选窗信息，说明拍的是默认那扇，不能装作点名生效了
    return requestedWindow
      ? `⚠️ 当前插件版本不支持 window 参数，「${requestedWindow}」被忽略了，拍的是插件默认选的窗口，` +
          `不一定是它。请用户更新 UnrealAgentLink 插件。\n`
      : ''
  }
  const title = response.window_title ? `「${response.window_title}」` : '（标题未知）'
  switch (response.window_source) {
    case 'requested':
      return `拍的是你点名的窗口${title}。\n`
    case 'modal':
      return requestedWindow
        ? `⚠️ 你点名了「${requestedWindow}」，但当前有模态弹窗挡着编辑器，拍的是那个弹窗${title}。` +
            `先处理弹窗再拍点名的窗口。\n`
        : `拍的是当前的模态弹窗${title}。\n`
    case 'last_active':
      return `拍的是用户最后用过的窗口${title}。要看别的编辑器窗口就用 window 点名。\n`
    case 'fallback':
      return requestedWindow
        ? `⚠️ 「${requestedWindow}」的编辑器开着，但定位不到它所在的窗口，退回了主窗口${title}——` +
            `图里不一定有它。\n`
        : `⚠️ 没找到用户最后用过的窗口，退回了主窗口${title}——` +
            `这张图和用户正在看的编辑器可能不是同一扇，要看具体某个资产编辑器请用 window 点名。\n`
    default:
      return `拍的是窗口${title}。\n`
  }
}

export function createScreenshotTool(): V2Tool {
  return defineV2Tool({
    description: `抓取虚幻引擎当前视口的截图。

【功能说明】：
- 从 Editor 视口抓屏，图片**直接返回给你**，可以自己看
- 支持自定义分辨率和文件名

【什么时候用】：
- 改完东西后确认结果，不要只凭工具返回的 success 就下结论
- 用户描述「看起来不对」但说不清哪里不对时，先截一张自己看

**先读下面「曝光」那一段再下结论。** 这张图在物体位置、材质颜色、灯亮没亮、
阴影方向上是准的；**亮度准不准取决于场景有没有锁曝光**。

【它拍的是镜头当前对着的地方】想确认某个具体 Actor，先用 ue_focus_viewport
把镜头对准它再拍 —— 否则很可能拍回来一张画面里根本没有那个东西的图。

【先看 camera_source 再看画面】返回里的 camera_source 说了机位是哪来的：
viewport（用户视口那台相机）/ player（PIE 玩家视角）/ fallback（没找到视口，
用的兜底机位）。**fallback 时构图是随机的**，画面里没有某个东西不代表它不在场景里 ——
message 里会有一条 ⚠️。看到它就别拿这张图下结论，先 ue_focus_viewport 再拍，
或者请用户自己截一张。camera_location 是机位坐标（厘米），可以和 Actor 坐标对照
确认镜头确实对着目标。

【PIE 在跑就自动拍游戏】不用你判断：游戏跑着的时候拍的是**正在跑的那个世界**、
玩家视角；没在跑才拍编辑器世界、视口视角。返回里的 world 字段说了这一张是哪个
（pie / editor），view 说了机位是玩家还是视口 —— 下结论前先看一眼。
PIE 跑着但你要看编辑器场景本身（比如核对关卡里的摆放），传 world="editor"。
判断**最终画面**（好不好看、亮度对不对）以游戏跑起来时拍的为准：玩家相机上的
后期、运行时才生成的东西，只在那一张里。

【⚠️ 拍不到界面，PIE 也一样】默认路径渲的是**场景**：HUD、血条、菜单、
Print String 的屏幕字都不在画面里，哪怕正显示在用户屏幕上。**图里没有 HUD
不等于 HUD 没显示。** 验界面用 show_ui=true（抓编辑器窗口，PIE 画面连 HUD 都在）
或 widget_preview。

【默认拍场景，要看界面就 show_ui=true】默认走 SceneCapture 直接渲染一帧，
编辑器窗口最小化、被遮挡、没焦点都能出图，画面里**不含**大纲、细节面板和弹窗。

用户说「界面上弹了个错」「这个面板里写的什么」「按钮在哪」——
那些东西不在场景里，传 show_ui=true：抓的是用户屏幕上的整个编辑器窗口，
有模态弹窗时抓的就是那个弹窗，否则拍用户最后用过的那扇窗口（蓝图、材质
编辑器浮在外面就拍那扇）。返回的 window_title 说了拍到的是哪扇，先核对
再下结论；拍回来不是要看的那扇，或者要看别的编辑器，用 window 点名
（资产名或路径，level 是主关卡窗口）。这条路不渲染，拍的是屏幕上的原样，
但画面小、看不出材质、灯光这类渲染细节，看场景一律用默认。

【⚠️ 曝光：先看场景锁没锁】**自动曝光**下（没有 Metering Mode = Manual 的
PostProcessVolume），截图、视口、游戏各自收敛到不同亮度，还会把压暗的场景拉回来。
锁成手动曝光（无边界 PostProcessVolume：Manual、关 Apply Physical Camera Exposure、
调 Exposure Compensation）后三者同一个亮度，图上的明暗就是玩家看到的。
画面发白、太暗时**别归给截图偏差然后收工**：没锁就先锁再调，锁了就是场景的问题。
物体、位置、材质颜色、灯亮没亮、阴影方向、构图任何时候都准；界面层任何时候都不在图里。

【拍之前会自己等到位】不用你先 sleep 再截 —— 插件会等着色器和资产编译完、
把贴图流送冲一遍、再渲几帧预热，然后才拍。等不到位的部分会写在 message 里
（见下面的 pending_*），**看到那句警告就别拿这张图判断材质和贴图**。

【参数说明】：
- filepath: 可选，保存的文件名或路径
- resolution: 可选，[宽度, 高度]，默认 [1920, 1080]
- show_ui: 可选，true = 拍整个编辑器窗口（面板、菜单、弹窗），默认 false = 只拍场景。
  为 true 时 resolution / world / warmup_frames 都不起作用 —— 那条路是抓屏，不渲染
- window: 可选，只配合 show_ui=true：点名拍哪个资产编辑器（资产名或路径），
  或 level 拍主关卡窗口。不传就拍用户最后用过的那扇
- world: 可选，auto（默认，PIE 在跑就拍游戏）/ editor（强制拍编辑器世界）
- warmup_frames: 可选，预热帧数，默认 4。嫌 GI 有噪点、阴影缺角就调大

【返回数据】：
- 截图本身（作为图片附件，你能直接看到）
- path: 本地保存路径
- world: 这一张拍的是 pie（正在跑的游戏）还是 editor（编辑器世界）
- view: 机位是 player（玩家视角）还是 viewport（编辑器视口相机）
- pending_shaders / pending_assets: 拍的时候还有多少没编译完，0 才算干净
- streaming_in_flight: 还有多少贴图没流送完，0 才算干净
- camera_source: viewport / player / fallback —— fallback 表示构图不可信
- camera_location / camera_rotation: 这一帧的机位（位置单位厘米）
- window_title / window_source（仅 show_ui=true）: 拍到的是哪扇窗口、怎么选的。
  window_source=fallback 表示退回了主窗口，别当成用户看的那扇；
  有模态弹窗时一律拍弹窗（window_source=modal），点了名也一样`,

    inputSchema: ScreenshotParamsSchema,

    // `= {}` 是必需的：这个工具也被直接调用（测试、PIE 试玩那边复用），
    // 那些调用方只传一个参数，解构 undefined 会当场炸。
    execute: async (input, { abortSignal } = {}) => {
      console.log('[ScreenshotTool] 收到请求:', input)

      // 用户关掉「允许编辑器截图」时，这里连请求都不发。
      //
      // 主闸在工具池（`resolveTools` 把这个工具整个摘掉），这一道是第二层：
      // 工具对象是进程级缓存的、`/api/debug/tool` 那条调试入口又直接从
      // `buildAllTools()` 取工具执行，不过工具池那道闸。少了这一句，一个
      // 明确关掉的开关就还剩一条绕得过去的路。
      if (!editorScreenshotAllowed()) {
        return {
          success: false,
          error: editorScreenshotRefusal(
            input.show_ui ? '抓取编辑器窗口截图' : '抓取编辑器视口截图'
          )
        }
      }

      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        // 5. window 只在抓窗口那条路上有意义。渲染那条路根本不读它，
        // 悄悄忽略等于让模型以为拍到了点名的编辑器、实际拿到的是场景
        if (input.window && !input.show_ui) {
          return {
            success: false,
            error:
              'window 只配合 show_ui=true 使用：点名拍某个编辑器窗口要走抓屏那条路。要看场景就去掉 window。'
          }
        }

        if (input.show_ui) {
          return await captureAppWindow(input.filepath, input.window, abortSignal)
        }

        // 构建请求参数
        const params: Record<string, unknown> = {}
        if (input.filepath) params.filepath = input.filepath
        // 将 resolution_width/height 转换为 UE 插件期望的 [width, height] 格式
        if (input.resolution_width !== undefined && input.resolution_height !== undefined) {
          params.resolution = [input.resolution_width, input.resolution_height]
        }
        // show_ui 不再往下发：true 在上面就走掉了，剩下的只可能是 false，
        // 而 false 正是插件的默认。发过去只会让人以为这条路还认这个开关
        // auto 是插件那边的默认行为，不用发；只有强制拍编辑器世界才需要说一声
        if (input.world === 'editor') params.world = 'editor'
        if (input.warmup_frames !== undefined) params.warmup_frames = input.warmup_frames

        console.log('[ScreenshotTool] 发送 editor.screenshot 请求:', params)

        // 插件自己等 30 秒（2 秒 × 15 次）才放弃，而且它的超时文案是**具体的**：
        // 「请确保已打开一个关卡/场景视口并置于前台，而非材质、蓝图等编辑器窗口」。
        //
        // 我们这边原本也是 30000 —— 两边同时到期，赛跑的结果是我们的通用
        // 「请求超时」盖掉了插件那句有用的诊断。留出余量让插件先说话。
        const response = await wsService.callRequest<ScreenshotResponse>(
          'editor.screenshot',
          params,
          getTargetConnectionId(),
          PLUGIN_SCREENSHOT_TIMEOUT_MS + 8000,
          // 这条是全仓库最慢的一次等待（插件 30 秒 + 8 秒余量）。
          // 用户按停止时把它当场作废，别让暂存池挂着一条谁也不要的请求。
          abortSignal
        )

        console.log('[ScreenshotTool] 收到响应:', response ? '成功' : '无数据')

        if (response) {
          // RPC 错误响应透传
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcOk = (response as any)?.ok
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rpcSuccess = (response as any)?.success
          if (rpcOk === false || rpcSuccess === false) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = (response as any)?.error || (response as any)?.message || '截图失败'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const code = (response as any)?.__rpc?.code ?? (response as any)?.code
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const details = (response as any)?.details
            return { success: false, error: `截图失败：${msg}`, code, details, raw: response }
          }

          // 如果 UE 插件请求恢复应用窗口到前台
          if (response.restore_app_window) {
            try {
              // getAppWindows()：不能把 Agent 浏览器窗口恢复到前台，
              // 用户等的是盒子的界面
              const mainWindow = getAppWindows()[0]
              if (mainWindow) {
                if (mainWindow.isMinimized()) {
                  mainWindow.restore()
                }
                mainWindow.focus()
                console.log('[ScreenshotTool] 应用窗口已恢复到前台')
              }
            } catch (err) {
              console.warn('[ScreenshotTool] 恢复应用窗口失败:', err)
            }
          }

          // 把截图直接读进模型上下文。
          //
          // 原来唯一的出图途径是**上传 S3 换 URL**：没配 .env 凭证就直接失败
          // （真机上就是这样，upload_error: "S3 凭证未配置"），降级成 file:// ——
          // 而模型打不开本地路径。也就是说这个工具渲染出了一张
          // **模型永远看不到的图**，"截图看看场景"这件事根本办不到。
          //
          // pi 原生支持图片进上下文，不需要先传到远端；顺带也省掉了
          // 把用户编辑器画面上传到第三方存储这件事。
          const images = await readScreenshotImage(response.path)

          // 拍的是哪个世界必须写进 message，不能只放字段里 —— 模型不一定
          // 逐条看返回值，而「这张图是游戏还是编辑器」直接决定结论对不对。
          //
          // 老版本插件不回 world，那就一个字都不加：说不准的时候不说，
          // 比默认写成「编辑器世界」强 —— 那是在替插件编一个我们没确认的事实
          const scope =
            response.world === 'pie'
              ? response.view === 'player'
                ? '，正在跑的游戏世界，玩家视角'
                : '，正在跑的游戏世界，视口视角'
              : response.world === 'editor'
                ? '，编辑器世界'
                : ''

          const readiness = describeReadiness(response)
          const camera = describeCamera(response)
          const uiLayer = describeUiLayer(response)

          return {
            success: true,
            path: response.path,
            filename: response.filename,
            width: response.width,
            height: response.height,
            saved: response.saved,
            images,
            save_error: response.save_error,
            ...(response.world ? { world: response.world } : {}),
            ...(response.view ? { view: response.view } : {}),
            ...(response.pending_assets !== undefined
              ? { pending_assets: response.pending_assets }
              : {}),
            ...(response.pending_shaders !== undefined
              ? { pending_shaders: response.pending_shaders }
              : {}),
            ...(response.streaming_in_flight !== undefined
              ? { streaming_in_flight: response.streaming_in_flight }
              : {}),
            ...(response.camera_source ? { camera_source: response.camera_source } : {}),
            ...(response.camera_location ? { camera_location: response.camera_location } : {}),
            ...(response.camera_rotation ? { camera_rotation: response.camera_rotation } : {}),
            message:
              (response.saved
                ? `截图已成功获取（${response.width}x${response.height}${scope}）`
                : `截图已获取但是保存失败: ${response.save_error}`) +
              readiness +
              camera +
              uiLayer
          }
        }

        return {
          success: false,
          error: '服务未返回有效数据'
        }
      } catch (error) {
        console.error('[ScreenshotTool] 执行失败:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
