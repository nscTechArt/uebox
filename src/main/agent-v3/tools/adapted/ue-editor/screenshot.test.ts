/**
 * @vitest-environment node
 *
 * `ue_screenshot` 的契约测试。
 *
 * 重点是「这张图拍的是哪个世界」这条信息有没有一路带到模型面前 ——
 * PIE 跑着的时候拍回一张编辑器世界的图，画面看着正常，模型会拿它去下
 * 运行时的结论，那是最难发现的一类错。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1',
  getTargetProjectPath: () => undefined
}))

vi.mock('../../../../appWindows', () => ({
  getAppWindows: () => []
}))

// 压缩要拉 sharp 并读真实文件，这里只关心「有图就带上」
vi.mock('../../contextImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contextImage')>()),
  compressForContext: vi.fn(async () => ({ data: 'ZmFrZQ==', mimeType: 'image/jpeg' }))
}))

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => Buffer.from('png'))
}))

// 这一侧不再 spawn 任何进程抬窗口（原因见 screenshot.ts「拍窗口前不在这一侧抬窗口」）。
// 谁要是又加回去，这一句会让它在测试里当场炸掉，而不是悄悄真去弹 powershell
vi.mock('child_process', () => ({
  spawn: () => {
    throw new Error('screenshot 不该再在应用侧 spawn 进程抬窗口')
  }
}))

import { runWithEditorScreenshotScope } from '../../../core/editorScreenshotScope'
import { createScreenshotTool } from './screenshot'
import { noteViewportMove, resetViewportProvenance } from './viewportProvenance'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown = {}): Promise<ToolResult> =>
  (createScreenshotTool() as unknown as Executable).execute(input)

const EDITOR_SHOT = {
  path: 'C:/tmp/UAShot.png',
  filename: 'UAShot.png',
  width: 1920,
  height: 1080,
  saved: true,
  show_ui: false,
  method: 'scene_capture',
  world: 'editor' as const,
  view: 'viewport' as const
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset()
  getConnectionCount.mockReturnValue(1)
  resetViewportProvenance()
})

describe('拍的是哪个世界', () => {
  it('默认不指定世界 —— 由插件按 PIE 在不在跑自己判断', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    await run({})

    expect(callRequest.mock.calls[0][1]).not.toHaveProperty('world')
  })

  it('PIE 在跑时把「游戏世界 + 玩家视角」写进结论，不只放字段里', async () => {
    callRequest.mockResolvedValue({ ...EDITOR_SHOT, world: 'pie', view: 'player' })

    const result = await run({})

    expect(result.world).toBe('pie')
    expect(result.view).toBe('player')
    expect(String(result.message)).toContain('正在跑的游戏世界')
    expect(String(result.message)).toContain('玩家视角')
  })

  it('PIE 里没有玩家控制器（Simulate）时说清机位是视口', async () => {
    callRequest.mockResolvedValue({ ...EDITOR_SHOT, world: 'pie', view: 'viewport' })

    const result = await run({})

    expect(String(result.message)).toContain('正在跑的游戏世界')
    expect(String(result.message)).toContain('视口视角')
  })

  /**
   * 2026-09-16 的反馈：模型拿 PIE 截图核对 HUD，画面干净、返回写着「玩家视角」，
   * 于是交付了一个假阳性结论 —— 而 HUD 一直好好地显示在用户屏幕上。
   * SceneCapture 渲的是场景，UMG 那一层根本不在取景里，缺的东西不画，
   * 模型光看图分不出「没显示」和「不在这张图里」。这句话必须在 message 里。
   */
  it('PIE 那一帧说清「画面里不含 UMG 界面层」，并给出验界面的路', async () => {
    callRequest.mockResolvedValue({ ...EDITOR_SHOT, world: 'pie', view: 'player' })

    const result = await run({})

    expect(String(result.message)).toContain('不含 UMG 界面层')
    expect(String(result.message)).toContain('show_ui=true')
    expect(String(result.message)).toContain('widget_preview')
  })

  it('编辑器世界那一帧不提界面层 —— 那里本来就没有运行时界面', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    const result = await run({})

    expect(String(result.message)).not.toContain('UMG')
  })

  it('要看编辑器场景本身时把 world=editor 发下去', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    await run({ world: 'editor' })

    expect((callRequest.mock.calls[0][1] as { world?: string }).world).toBe('editor')
  })

  it('auto 不往下发 —— 那本来就是插件的默认行为', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    await run({ world: 'auto' })

    expect(callRequest.mock.calls[0][1]).not.toHaveProperty('world')
  })

  /**
   * 老版本插件不回 world。这时候一个字都不能加 —— 写成「编辑器世界」
   * 是在替插件编一个我们没确认的事实，而模型会当真。
   */
  it('插件没回 world 时结论里不提世界', async () => {
    const legacy: Record<string, unknown> = { ...EDITOR_SHOT }
    delete legacy.world
    delete legacy.view
    callRequest.mockResolvedValue(legacy)

    const result = await run({})

    expect(result).not.toHaveProperty('world')
    expect(String(result.message)).not.toContain('世界')
  })
})

describe('参数与图片', () => {
  it('分辨率转成插件要的 [宽, 高]', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    await run({ resolution_width: 1280, resolution_height: 720 })

    expect((callRequest.mock.calls[0][1] as { resolution?: number[] }).resolution).toEqual([
      1280, 720
    ])
  })

  it('截图直接进上下文', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    const result = await run({})

    expect(result.images).toHaveLength(1)
    expect(result.path).toBe('C:/tmp/UAShot.png')
  })
})

/**
 * 「这张图准备好了没有」必须一路带到模型面前。
 *
 * 着色器没编完时材质是灰的、贴图没流完时是糊的 —— 模型光看图分不出
 * 「材质坏了」和「材质还没编完」，会去修一个根本不存在的问题。
 */
describe('画面准备好了没有', () => {
  it('全都干净时不加任何警告', async () => {
    callRequest.mockResolvedValue({
      ...EDITOR_SHOT,
      pending_assets: 0,
      pending_shaders: 0,
      streaming_in_flight: 0
    })

    const result = await run({})

    expect(String(result.message)).not.toContain('⚠️')
  })

  it('着色器还在编时把「材质可能是灰的」说出来', async () => {
    callRequest.mockResolvedValue({ ...EDITOR_SHOT, pending_shaders: 7 })

    const result = await run({})

    expect(result.pending_shaders).toBe(7)
    expect(String(result.message)).toContain('7 个着色器')
    expect(String(result.message)).toContain('不要据此判断材质')
  })

  it('贴图没流完时说贴图可能偏糊', async () => {
    callRequest.mockResolvedValue({ ...EDITOR_SHOT, streaming_in_flight: 3 })

    const result = await run({})

    expect(result.streaming_in_flight).toBe(3)
    expect(String(result.message)).toContain('偏糊')
  })

  /** 老版本插件不回这几个字段，那就一个字都不加 —— 别替它编一个没确认的事实 */
  it('插件没回这些字段时不加警告，也不编造 0', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    const result = await run({})

    expect(result).not.toHaveProperty('pending_shaders')
    expect(String(result.message)).not.toContain('⚠️')
  })

  it('预热帧数按调用方给的往下发', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    await run({ warmup_frames: 8 })

    expect((callRequest.mock.calls[0][1] as { warmup_frames?: number }).warmup_frames).toBe(8)
  })

  it('没给预热帧数就不发 —— 默认值归插件管', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    await run({})

    expect(callRequest.mock.calls[0][1]).not.toHaveProperty('warmup_frames')
  })
})

/**
 * 兜底机位必须被点破。
 *
 * 插件取不到透视视口时会退回一台固定相机（原点上方、俯角 30°），截图照样
 * success + saved。这两种情况在返回值里长得一模一样时，模型会拿一张构图随机的
 * 图去核对场景摆放，看不见目标就去修一个不存在的问题 —— 实测里白走了整整
 * 一轮，而且顺着错误结论越走越远。
 */
describe('机位来源', () => {
  it('fallback 时在 message 里挑明，并说清「看不见 ≠ 不存在」', async () => {
    callRequest.mockResolvedValue({
      ...EDITOR_SHOT,
      camera_source: 'fallback',
      camera_location: { x: 0, y: 0, z: 500 },
      camera_rotation: { pitch: -30, yaw: 0, roll: 0 }
    })

    const result = await run({})

    expect(result.success).toBe(true)
    expect(result.camera_source).toBe('fallback')
    expect(String(result.message)).toContain('⚠️')
    expect(String(result.message)).toContain('不代表它不在场景里')
    expect(String(result.message)).toContain('ue_focus_viewport')
  })

  it('用的是视口相机时不加警告，但机位照样透出去', async () => {
    callRequest.mockResolvedValue({
      ...EDITOR_SHOT,
      camera_source: 'viewport',
      camera_location: { x: 100, y: 200, z: 300 }
    })

    const result = await run({})

    expect(result.camera_source).toBe('viewport')
    expect(result.camera_location).toEqual({ x: 100, y: 200, z: 300 })
    expect(String(result.message)).not.toContain('兜底机位')
  })

  it('老版本插件不回 camera_source 时一个字都不加', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    const result = await run({})

    expect(result).not.toHaveProperty('camera_source')
    expect(String(result.message)).not.toContain('兜底机位')
  })

  /**
   * 真机上模型用 Python 把视口写成朝天，拍回一片云后怀疑的是场景而不是自己那行代码。
   * 拍视口那一帧要说清「这个视口最后是哪次调用动的」，把怀疑对象指回去。
   */
  it('拍视口那一帧说清视口最后是谁动的', async () => {
    noteViewportMove('ue_run_python_script', '脚本里调了 set_level_viewport_camera_info')
    callRequest.mockResolvedValue({
      ...EDITOR_SHOT,
      camera_source: 'viewport',
      camera_rotation: { pitch: 90, yaw: 0, roll: 0 }
    })

    const result = await run({})

    expect(String(result.message)).toContain('仰视 90°')
    expect(String(result.message)).toContain('视口最后一次是')
    expect(String(result.message)).toContain('ue_run_python_script')
  })

  it('没人动过视口就不提', async () => {
    callRequest.mockResolvedValue({ ...EDITOR_SHOT, camera_source: 'viewport' })
    const result = await run({})
    expect(String(result.message)).not.toContain('视口最后一次是')
  })

  it('兜底机位不是视口，不说视口是谁动的', async () => {
    noteViewportMove('ue_focus_viewport', '对准 BP_Chair')
    callRequest.mockResolvedValue({ ...EDITOR_SHOT, camera_source: 'fallback' })
    const result = await run({})
    expect(String(result.message)).not.toContain('视口最后一次是')
  })
})

describe('拒绝与异常', () => {
  it('没连引擎时不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await run({})

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('插件返回失败时不当成成功', async () => {
    callRequest.mockResolvedValue({ success: false, error: '拿不到世界（没有打开关卡？）' })

    const result = await run({})

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('拿不到世界')
  })

  /**
   * 用户关掉「允许编辑器截图」之后这里连请求都不发。
   *
   * 主闸在工具池（`resolveTools` 把这个工具整个摘掉），这一道是第二层：
   * 工具对象是进程级缓存的、`/api/debug/tool` 那条调试入口又直接从
   * `buildAllTools()` 取工具执行，不过工具池那道闸。少了这一句，一个明确
   * 关掉的开关就还剩一条绕得过去的路。
   */
  it('用户关掉编辑器截图时直接拒绝，一帧都不渲', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    const result = await runWithEditorScreenshotScope(false, () => run({}))

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
    // 拒绝必须能自解：说清怎么放开，还要告诉模型别绕路
    expect(String(result.error)).toContain('设置 → AI 助手 → 隐私')
    expect(String(result.error)).toContain('ue_run_python_script')
  })

  it('开着时照常拍', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    const result = await runWithEditorScreenshotScope(true, () => run({}))

    expect(result.success).toBe(true)
    expect(callRequest).toHaveBeenCalledTimes(1)
  })
})

/**
 * 「界面上弹了个错，你看看」—— 这件事以前办不到。
 *
 * 视口那条路渲的是**场景**，弹窗、大纲、细节面板一个都不在渲染结果里，
 * 拍回去是一张构图正常但什么报错都没有的图，而模型看不出少了东西，
 * 会直接回一句「没看到报错」。插件的 editor.capture_app_window 一直都在，
 * 只是没有任何工具调它（2026-08-31 的工具体检就点名过）。
 */
describe('拍整个编辑器窗口（show_ui=true）', () => {
  const WINDOW_SHOT = {
    path: 'C:/tmp/UAL_AppShot.png',
    filename: 'UAL_AppShot.png',
    width: 2560,
    height: 1440,
    saved: true
  }

  it('走的是抓屏那条命令，不是渲染那条', async () => {
    callRequest.mockResolvedValue(WINDOW_SHOT)

    await run({ show_ui: true })

    expect(callRequest.mock.calls[0][0]).toBe('editor.capture_app_window')
  })

  it('图片照样进上下文，并说清这是用户屏幕上那一份', async () => {
    callRequest.mockResolvedValue(WINDOW_SHOT)

    const result = await run({ show_ui: true })

    expect(result.success).toBe(true)
    expect(result.images).toHaveLength(1)
    expect(result.width).toBe(2560)
    expect(String(result.message)).toContain('弹窗')
  })

  it('文件名传下去，渲染那条路的参数不发 —— 那边根本不认', async () => {
    callRequest.mockResolvedValue(WINDOW_SHOT)

    await run({
      show_ui: true,
      filepath: 'bug.png',
      resolution_width: 800,
      resolution_height: 600,
      warmup_frames: 8
    })

    const params = callRequest.mock.calls[0][1] as Record<string, unknown>
    expect(params.filepath).toBe('bug.png')
    expect(params).not.toHaveProperty('resolution')
    expect(params).not.toHaveProperty('warmup_frames')
    expect(params).not.toHaveProperty('show_ui')
  })

  /**
   * 最小化的窗口 PrintWindow 抓回来是一张白图，插件照样回 saved:true。
   * 这时候报 success 等于把一张白图送到模型面前让它下结论。
   */
  it('没落盘就不报成功', async () => {
    callRequest.mockResolvedValue({ ...WINDOW_SHOT, saved: false })

    const result = await run({ show_ui: true })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('最小化')
  })

  it('插件报错时原样透出去', async () => {
    callRequest.mockResolvedValue({ ok: false, error: 'No valid window to capture' })

    const result = await run({ show_ui: true })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('No valid window to capture')
  })

  it('默认那条路不再往下发 show_ui', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    await run({ show_ui: false })

    expect(callRequest.mock.calls[0][0]).toBe('editor.screenshot')
    expect(callRequest.mock.calls[0][1]).not.toHaveProperty('show_ui')
  })

  it('用户关掉编辑器截图时这条路也拦住', async () => {
    callRequest.mockResolvedValue(WINDOW_SHOT)

    const result = await runWithEditorScreenshotScope(false, () => run({ show_ui: true }))

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })

  /**
   * 「拍到的是哪扇窗口」必须回上去。
   *
   * 2026-09-22 的反馈：用户开着蓝图编辑器说「看看我这张图」，拍回去的永远是
   * 主关卡窗口 —— 用户在盒子里敲字那一刻引擎所有窗口都失活，Slate 的活跃窗口
   * 是空，插件退回第一扇，而第一扇永远是主窗口。一张拍错窗口的图看着完全正常，
   * 模型分不出来。现在插件按「用户最后用过的窗口」选，并回 window_title /
   * window_source；这一侧要把它翻进 message，fallback 时单独警告。
   */
  it('点名的窗口传下去', async () => {
    callRequest.mockResolvedValue({
      ...WINDOW_SHOT,
      window_title: 'BP_Door',
      window_source: 'requested'
    })

    const result = await run({ show_ui: true, window: 'BP_Door' })

    const params = callRequest.mock.calls[0][1] as Record<string, unknown>
    expect(params.window).toBe('BP_Door')
    expect(result.window_title).toBe('BP_Door')
    expect(String(result.message)).toContain('点名')
    expect(String(result.message)).toContain('BP_Door')
  })

  it('没点名就不发 window 字段', async () => {
    callRequest.mockResolvedValue(WINDOW_SHOT)

    await run({ show_ui: true })

    expect(callRequest.mock.calls[0][1]).not.toHaveProperty('window')
  })

  it('拍的是用户最后用过的窗口时把标题说出来，并给出点名的路', async () => {
    callRequest.mockResolvedValue({
      ...WINDOW_SHOT,
      window_title: 'BP_Chandelier',
      window_source: 'last_active'
    })

    const result = await run({ show_ui: true })

    expect(String(result.message)).toContain('BP_Chandelier')
    expect(String(result.message)).toContain('最后用过')
    expect(String(result.message)).toContain('window')
  })

  it('退回主窗口时挑明「可能不是用户在看的那扇」', async () => {
    callRequest.mockResolvedValue({
      ...WINDOW_SHOT,
      window_title: 'Demo_Village_v2',
      window_source: 'fallback'
    })

    const result = await run({ show_ui: true })

    expect(String(result.message)).toContain('⚠️')
    expect(String(result.message)).toContain('主窗口')
    expect(result.window_source).toBe('fallback')
  })

  it('老插件不回窗口信息时一个字都不加', async () => {
    callRequest.mockResolvedValue(WINDOW_SHOT)

    const result = await run({ show_ui: true })

    expect(String(result.message)).not.toContain('窗口「')
    expect(String(result.message)).not.toContain('最后用过')
  })

  it('点了名但老插件不认 window 时挑明被忽略了', async () => {
    callRequest.mockResolvedValue(WINDOW_SHOT)

    const result = await run({ show_ui: true, window: 'BP_Door' })

    expect(result.success).toBe(true)
    expect(String(result.message)).toContain('⚠️')
    expect(String(result.message)).toContain('不支持 window')
    expect(String(result.message)).toContain('BP_Door')
  })

  it('点了名但被模态弹窗挡住时说清拍的是弹窗', async () => {
    callRequest.mockResolvedValue({
      ...WINDOW_SHOT,
      window_title: '保存内容',
      window_source: 'modal'
    })

    const result = await run({ show_ui: true, window: 'BP_Door' })

    expect(String(result.message)).toContain('⚠️')
    expect(String(result.message)).toContain('弹窗')
    expect(String(result.message)).toContain('BP_Door')
  })

  it('点名的编辑器开着但定位不到窗口时说清退回了主窗口', async () => {
    callRequest.mockResolvedValue({
      ...WINDOW_SHOT,
      window_title: 'Demo_Village_v2',
      window_source: 'fallback'
    })

    const result = await run({ show_ui: true, window: 'M_Rock' })

    expect(String(result.message)).toContain('M_Rock')
    expect(String(result.message)).toContain('定位不到')
  })

  it('window 不配 show_ui=true 直接拒绝，不去渲场景', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)

    const result = await run({ window: 'BP_Door' })

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('show_ui')
    expect(callRequest).not.toHaveBeenCalled()
  })
})

/**
 * 2026-09-26 科幻塔防：关卡美术在自动曝光下调了四轮灯，截图每张都发白，
 * 最后把它归给「截图偏差」收工。插件现在回这一帧用的是哪种曝光。
 */
describe('曝光锁没锁', () => {
  it('自动曝光：当场说明暗没有基准，并给出锁曝光的做法', async () => {
    callRequest.mockResolvedValue({ ...EDITOR_SHOT, exposure: 'auto', exposure_source: 'default' })
    const result = await run({})
    expect(result.exposure).toBe('auto')
    expect(String(result.message)).toMatch(/自动曝光[\s\S]*Metering Mode = Manual/)
  })

  it('锁住了：说一句明暗可信', async () => {
    callRequest.mockResolvedValue({
      ...EDITOR_SHOT,
      exposure: 'manual',
      exposure_source: 'post_process_volume'
    })
    const result = await run({})
    expect(String(result.message)).toContain('曝光已锁')
    expect(String(result.message)).not.toContain('自动曝光')
  })

  it('老插件不回曝光时一个字都不加', async () => {
    callRequest.mockResolvedValue(EDITOR_SHOT)
    const result = await run({})
    expect(result).not.toHaveProperty('exposure')
    expect(String(result.message)).not.toMatch(/曝光/)
  })
})
