/**
 * @vitest-environment node
 *
 * `ue_playtest` 的契约测试。
 *
 * 这个工具的产出是一份**给模型读的结论**，所以测的重点不是字段搬运，
 * 而是几种「跑完了但其实没成」的情况有没有被说清楚 —— 那些正是模型
 * 最容易误判成"游戏没问题"的地方。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as nodeFs from 'fs/promises'
import * as nodeOs from 'os'
import * as nodePath from 'path'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))

vi.mock('../../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

// 截图压缩要拉 sharp 并读真实文件，这里只关心「有图就带上」
vi.mock('./screenshot', () => ({
  readScreenshotImage: vi.fn(async (path?: string) =>
    path ? [{ data: 'ZmFrZQ==', mimeType: 'image/jpeg' }] : []
  )
}))

import { runWithEditorScreenshotScope } from '../../../core/editorScreenshotScope'
import { createPlaytestTool } from './playtest'

type ToolResult = Record<string, unknown>
type Executable = { execute: (input: unknown) => Promise<ToolResult> }

const run = (input: unknown = {}): Promise<ToolResult> =>
  (createPlaytestTool() as unknown as Executable).execute(input)

const CLEAN_RUN = {
  ok: true,
  ran: true,
  ended_by: 'duration',
  elapsed_seconds: 5,
  requested_seconds: 5,
  print_strings: ['door ready'],
  errors: [],
  warnings: [],
  error_count: 0,
  warning_count: 0,
  actors_at_start: 10,
  actors_at_end: 12,
  actors_spawned: 2,
  screenshot_path: 'C:/tmp/shot.png'
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('正常跑完', () => {
  it('把报告的各栏原样带上，截图进上下文', async () => {
    callRequest.mockResolvedValue(CLEAN_RUN)

    const result = await run({ duration_seconds: 5 })

    expect(result.success).toBe(true)
    expect(result.print_strings).toEqual(['door ready'])
    expect(result.actors_spawned).toBe(2)
    expect(result.images).toHaveLength(1)
    // 路径也要带上：进上下文的图是压过的，界面显示磁盘上那张原图
    expect(result.screenshot_path).toBe('C:/tmp/shot.png')
    expect(String(result.summary)).toContain('无运行时错误')
    expect(String(result.summary)).toContain('1 条 PrintString')
  })

  /**
   * 试玩截图和视口截图走同一条 SceneCapture 路，同样不画 UMG。
   * 报告里写着「玩家视角」而画面里没有 HUD，模型会当成「HUD 没显示」——
   * 2026-09-16 的反馈里这就是假阳性的另一半。
   */
  it('有截图时说清它不含 HUD / UMG 界面层', async () => {
    callRequest.mockResolvedValue(CLEAN_RUN)

    const result = await run({})

    expect(String(result.summary)).toContain('不含 HUD / UMG 界面层')
  })

  it('没截图时不提界面层 —— 没有图就没有这个误会', async () => {
    callRequest.mockResolvedValue({ ...CLEAN_RUN, screenshot_path: undefined })

    const result = await run({})

    expect(String(result.summary)).not.toContain('UMG')
  })

  /**
   * 用户关掉「允许编辑器截图」时**强制不截**，而不是把整个工具摘掉。
   *
   * 试玩的正事是把游戏跑起来读日志，截图只是它的一个可选参数 —— 整个摘掉
   * 等于拿一个隐私开关顺手关掉了「验证游戏到底能不能跑」这件事。
   */
  describe('用户关掉编辑器截图时', () => {
    const runBlocked = (input: unknown = {}): Promise<ToolResult> =>
      runWithEditorScreenshotScope(false, () => run(input))

    // 插件那边 screenshot 默认是 true，不显式传 false 的话它照样会渲一帧存盘
    it('显式告诉插件别截', async () => {
      callRequest.mockResolvedValue({ ...CLEAN_RUN, screenshot_path: undefined })

      await runBlocked()

      expect((callRequest.mock.calls[0][1] as { screenshot?: boolean }).screenshot).toBe(false)
    })

    // 旧插件不认那个参数时仍然会回一个路径，读进去就等于开关白关
    it('插件仍然回了路径也不读、不回传', async () => {
      callRequest.mockResolvedValue(CLEAN_RUN)

      const result = await runBlocked()

      expect(result.images).toBeUndefined()
      expect(result).not.toHaveProperty('screenshot_path')
    })

    /**
     * 没出图必须说清是**用户关的**，不是试玩失败。不说的话模型只会看见一份
     * 没有图的报告，然后再调一次 `ue_screenshot` 去补 —— 那次同样会被挡。
     */
    it('结论里说清为什么没有图，正事照常给结论', async () => {
      callRequest.mockResolvedValue(CLEAN_RUN)

      const summary = String((await runBlocked()).summary)

      expect(summary).toContain('允许编辑器截图')
      expect(summary).toContain('无运行时错误')
    })

    // 模型自己传 screenshot:false 是它的选择，不该被说成「用户关了截图」
    it('开着时模型自己不要图，不多这句解释', async () => {
      callRequest.mockResolvedValue({ ...CLEAN_RUN, screenshot_path: undefined })

      const result = await run({ screenshot: false })

      expect((callRequest.mock.calls[0][1] as { screenshot?: boolean }).screenshot).toBe(false)
      expect(String(result.summary)).not.toContain('允许编辑器截图')
    })
  })

  it('超时留足余量 —— 插件那边还有启动窗口和收尾', async () => {
    callRequest.mockResolvedValue(CLEAN_RUN)

    await run({ duration_seconds: 10 })

    const timeout = callRequest.mock.calls[0][3]
    // 卡在传输超时上会让一次正常试跑看起来像失败，而 PIE 其实还在跑
    expect(timeout).toBeGreaterThan(10000 + 60000)
  })
})

describe('跑完了但其实没成的几种情况', () => {
  /**
   * 一条 PrintString 都没有，往往说明逻辑压根没执行 —— 它不是错误，
   * 所以最容易被当成"一切正常"。必须写进结论。
   */
  it('没有任何 PrintString 输出时点出来', async () => {
    callRequest.mockResolvedValue({ ...CLEAN_RUN, print_strings: [] })

    const result = await run()

    expect(result.success).toBe(true)
    expect(String(result.summary)).toContain('没有任何 PrintString')
    expect(String(result.summary)).toContain('没被执行')
  })

  it('有运行时错误时在结论里加粗点名', async () => {
    callRequest.mockResolvedValue({
      ...CLEAN_RUN,
      errors: ['[LogBlueprintUserMessages] Accessed None trying to read Door'],
      error_count: 1
    })

    const result = await run()

    // 图确实跑了，所以仍算调用成功 —— 是游戏有问题，不是工具有问题
    expect(result.success).toBe(true)
    expect(result.error_count).toBe(1)
    expect(String(result.summary)).toContain('1 个运行时错误')
  })

  /**
   * 提前被打断时跑的时间不够，结论不能读起来像正常跑完。
   */
  it('被外部打断时说清只跑了多久', async () => {
    callRequest.mockResolvedValue({
      ...CLEAN_RUN,
      ended_by: 'stopped_externally',
      elapsed_seconds: 1.2
    })

    const result = await run({ duration_seconds: 10 })

    expect(result.ended_by).toBe('stopped_externally')
    expect(String(result.summary)).toContain('1.2 秒')
    expect(String(result.summary)).toContain('跑满之前')
  })

  /**
   * 压根没启动 = 什么结论都给不出，这时候必须算失败。
   * 报成功会让模型以为"跑过了，没问题"。
   */
  it('PIE 没启动起来算调用失败', async () => {
    callRequest.mockResolvedValue({
      ...CLEAN_RUN,
      ran: false,
      ended_by: 'failed_to_start',
      elapsed_seconds: 0,
      print_strings: []
    })

    const result = await run()

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('没能启动')
  })
})

describe('事件注入', () => {
  it('events 原样发给插件', async () => {
    callRequest.mockResolvedValue(CLEAN_RUN)

    await run({
      duration_seconds: 6,
      events: [{ at: 2, command: 'ce OpenDoor' }]
    })

    const params = callRequest.mock.calls[0][1] as { events?: unknown }
    expect(params.events).toEqual([{ at: 2, command: 'ce OpenDoor' }])
  })

  it('没给 events 时不塞空数组下去', async () => {
    callRequest.mockResolvedValue(CLEAN_RUN)

    await run({ events: [] })

    expect(callRequest.mock.calls[0][1]).not.toHaveProperty('events')
  })

  /**
   * 「命令发出去了」和「引擎认这条命令」是两回事。名字写错的 ce 会被静默
   * 忽略 —— 不点出来的话，模型以为自己触发了那段逻辑，然后对着一份
   * 「什么都没发生」的报告去查别的地方。
   */
  it('引擎不认的命令要在结论里点名', async () => {
    callRequest.mockResolvedValue({
      ...CLEAN_RUN,
      events: [
        { at: 2, command: 'ce OpenDoor', fired: true, accepted: false },
        { at: 3, command: 'stat fps', fired: true, accepted: true }
      ]
    })

    const result = await run({ duration_seconds: 6 })

    expect(result.events).toHaveLength(2)
    const summary = String(result.summary)
    expect(summary).toContain('1 条注入命令引擎不认')
    expect(summary).toContain('ce OpenDoor')
    // 被接受的那条不该被算进去
    expect(summary).not.toContain('stat fps')
  })

  it('命令全被接受时结论里不提这茬', async () => {
    callRequest.mockResolvedValue({
      ...CLEAN_RUN,
      events: [{ at: 2, command: 'ce OpenDoor', fired: true, accepted: true }]
    })

    const result = await run({ duration_seconds: 6 })

    expect(String(result.summary)).not.toContain('引擎不认')
  })
})

describe('拒绝与异常', () => {
  it('编辑器已在 Play 模式时把插件的拒绝带上来', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: 'The editor is already in Play/Simulate mode.'
    })

    const result = await run()

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('Play')
  })

  it('没连引擎时不发请求', async () => {
    getConnectionCount.mockReturnValue(0)

    const result = await run()

    expect(result.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('插件无响应时不当成成功', async () => {
    callRequest.mockResolvedValue(undefined)

    const result = await run()

    expect(result.success).toBe(false)
  })

  it('截图失败不影响试跑结论，但要说一声', async () => {
    callRequest.mockResolvedValue({
      ...CLEAN_RUN,
      screenshot_path: undefined,
      screenshot_error: 'RenderTarget 资源不可用'
    })

    const result = await run()

    expect(result.success).toBe(true)
    expect(result.screenshot_error).toContain('RenderTarget')
    expect(result).not.toHaveProperty('images')
  })

  /**
   * 「跑完了、没报错、画面却不对」这一类里最常见的一种。
   *
   * 环境整层挂在子关卡上，那一层游戏里不加载 —— 日志干干净净，截图一片黑。
   * 报告里不点名的话，模型看到的就是一份完全正常的报告，接下来会去翻材质
   * 和 bHidden，正是 2026-09-07 那次白走的两段路。
   */
  it('有子关卡没进游戏世界时当场点名', async () => {
    callRequest.mockResolvedValue({
      ...CLEAN_RUN,
      levels: {
        persistent: { package: '/Game/Studio/L_Studio', name: 'L_Studio', actor_count: 6 },
        streaming_level_count: 1,
        editor_only_levels: ['L_BaseEnvironment'],
        game_only_levels: []
      }
    })

    const result = await run()

    expect(result.success).toBe(true)
    const summary = String(result.summary)
    expect(summary).toContain('L_BaseEnvironment')
    expect(summary).toContain('游戏世界里不可见')
    // 「不可见」底下有两种病，报告里不能替它选药 —— 指向能分辨的那个字段
    expect(summary).toContain('mismatch_reason')
    expect(summary).toContain('ue_get_levels')
  })

  it('两边一致时不加这段噪音', async () => {
    callRequest.mockResolvedValue({
      ...CLEAN_RUN,
      levels: {
        persistent: { package: '/Game/Maps/Main', name: 'Main', actor_count: 6 },
        streaming_level_count: 2,
        editor_only_levels: [],
        game_only_levels: []
      }
    })

    expect(String((await run()).summary)).not.toContain('游戏世界里不可见')
  })

  /** 老插件不回 levels 时一个字都不加，不能编一句「关卡都加载了」 */
  it('老插件没有 levels 字段时不瞎猜', async () => {
    callRequest.mockResolvedValue(CLEAN_RUN)

    const result = await run()

    expect(result).not.toHaveProperty('levels')
    expect(String(result.summary)).not.toContain('子关卡')
  })
})

/**
 * 多帧采样：这个工具唯一能回答「过程中发生了什么」的东西。
 *
 * 测的重点还是「错了看不出来」的那几件事 —— 拼图拼错了仍然是一张
 * 看着很正常的图，少抓了两帧也照样首尾相接。
 */
describe('多帧采样', () => {
  let frameDir = ''

  /** 造几张真帧：拼图这条路要真读文件、真过 sharp，mock 掉就等于什么都没测 */
  const writeFrames = async (count: number): Promise<Array<{ at: number; path: string }>> => {
    const sharp = (await import('sharp')).default
    const out: Array<{ at: number; path: string }> = []
    for (let i = 0; i < count; i++) {
      const file = nodePath.join(frameDir, `pie-${i}.png`)
      const svg = Buffer.from(
        `<svg width="640" height="360"><rect width="640" height="360" fill="#2a4d69"/></svg>`
      )
      await sharp(svg).png().toFile(file)
      out.push({ at: i * 0.5, path: file })
    }
    return out
  }

  beforeAll(async () => {
    frameDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'ual-pie-'))
  })

  afterAll(async () => {
    await nodeFs.rm(frameDir, { recursive: true, force: true })
  })

  it('参数原样发给插件', async () => {
    callRequest.mockResolvedValue(CLEAN_RUN)

    await run({ frames: 9, frame_mode: 'window', frame_times: [1, 2] })

    const params = callRequest.mock.calls[0][1] as Record<string, unknown>
    expect(params.frames).toBe(9)
    expect(params.frame_mode).toBe('window')
    expect(params.frame_times).toEqual([1, 2])
  })

  /**
   * 多帧采样也是编辑器截图。少了这道，一个明确关掉的隐私开关
   * 就还剩一条「换个参数」绕得过去的路。
   */
  it('用户关掉编辑器截图时一帧都不发', async () => {
    callRequest.mockResolvedValue(CLEAN_RUN)

    await runWithEditorScreenshotScope(false, () => run({ frames: 9 }))

    const params = callRequest.mock.calls[0][1] as Record<string, unknown>
    expect(params.frames).toBeUndefined()
    expect(params.frame_mode).toBeUndefined()
  })

  it('抓到的帧拼成一张图，排在收尾那张前面', async () => {
    const frames = await writeFrames(4)
    callRequest.mockResolvedValue({ ...CLEAN_RUN, frames, frame_mode: 'scene' })

    const result = await run({ frames: 4 })

    // 拼图 + 收尾那张 = 两张，拼图在前：先看完整段过程，再看最后定格
    expect(result.images).toHaveLength(2)
    const summary = String(result.summary)
    expect(summary).toContain('时间轴拼图')
    expect(summary).toContain('从左到右、从上到下')
    // 每格多大必须说 —— 不说的话模型会把「看不清」当成「图上没有」
    expect(summary).toMatch(/单格只有 \d+×\d+ 像素/)
  })

  /** 场景那条路不画界面层，九格里一格 HUD 都没有比单张图更像「界面真没显示」 */
  it('scene 模式说清这些帧里没有界面层', async () => {
    const frames = await writeFrames(2)
    callRequest.mockResolvedValue({ ...CLEAN_RUN, frames, frame_mode: 'scene' })

    const summary = String((await run({ frames: 2 })).summary)

    expect(summary).toContain('不含 UMG 界面层')
    expect(summary).toContain('frame_mode="window"')
  })

  it('window 模式说清编辑器面板也在画面里', async () => {
    const frames = await writeFrames(2)
    callRequest.mockResolvedValue({ ...CLEAN_RUN, frames, frame_mode: 'window' })

    const summary = String((await run({ frames: 2, frame_mode: 'window' })).summary)

    expect(summary).toContain('HUD')
    expect(summary).toContain('面板')
  })

  /**
   * 少抓的那几格不会在拼图上留下任何痕迹：剩下的格子照样首尾相接，
   * 看着就是一条完整的时间轴。而漏掉的那一秒可能正是出事的那一秒。
   */
  it('插件少抓了几帧时在结论里点名', async () => {
    const frames = await writeFrames(2)
    callRequest.mockResolvedValue({
      ...CLEAN_RUN,
      frame_mode: 'scene',
      frames: [
        ...frames,
        { at: 1.5, error: 'PIE world is gone' },
        { at: 2, error: 'PIE world is gone' }
      ]
    })

    const summary = String((await run({ frames: 4 })).summary)

    expect(summary).toContain('有 2 帧没抓成')
    expect(summary).toContain('PIE world is gone')
    expect(summary).toContain('不完整')
  })

  /** 一张都读不回来时不能给空网格，也不能假装有图 */
  it('帧全都读不回来时不拼图', async () => {
    callRequest.mockResolvedValue({
      ...CLEAN_RUN,
      frame_mode: 'scene',
      frames: [{ at: 0, path: 'C:/nowhere/ghost.png' }]
    })

    const result = await run({ frames: 1 })

    // 只剩收尾那一张
    expect(result.images).toHaveLength(1)
    expect(String(result.summary)).not.toContain('时间轴拼图')
  })

  it('没开多帧采样时一个字都不加', async () => {
    callRequest.mockResolvedValue(CLEAN_RUN)

    const result = await run({})

    expect(result).not.toHaveProperty('frames')
    expect(String(result.summary)).not.toContain('时间轴拼图')
  })
})

/**
 * 帧数超过九格：多给几张图，而不是把格子掰小。
 */
describe('多帧采样超过一张图', () => {
  let bigDir = ''

  const writeBigFrames = async (count: number): Promise<Array<{ at: number; path: string }>> => {
    const sharp = (await import('sharp')).default
    const out: Array<{ at: number; path: string }> = []
    for (let i = 0; i < count; i++) {
      const file = nodePath.join(bigDir, `f${i}.png`)
      const svg = Buffer.from(
        `<svg width="640" height="360"><rect width="640" height="360" fill="#1f3a5f"/></svg>`
      )
      await sharp(svg).png().toFile(file)
      out.push({ at: i * 0.5, path: file })
    }
    return out
  }

  beforeAll(async () => {
    bigDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'ual-pie-big-'))
  })

  afterAll(async () => {
    await nodeFs.rm(bigDir, { recursive: true, force: true })
  })

  it('18 帧回两张拼图，加上收尾那张共三张图', async () => {
    const frames = await writeBigFrames(18)
    callRequest.mockResolvedValue({ ...CLEAN_RUN, frames, frame_mode: 'scene' })

    const result = await run({ frames: 18 })

    expect(result.images).toHaveLength(3)
    const summary = String(result.summary)
    expect(summary).toContain('2 张')
    // 编号跨图连着数，否则「第 3 格开始变黑」指不到具体哪一格
    expect(summary).toContain('连着数')
    expect(summary).toContain('第 10–18 格')
  })

  /**
   * 抓帧本身会卡住游戏。占比大到一定程度，报告里的掉帧和卡顿就不是游戏的毛病，
   * 而是这个工具自己的影子 —— 不说的话模型会去修一个它自己造成的问题。
   */
  it('采样占掉的时间太多时点出来', async () => {
    const frames = await writeBigFrames(9)
    callRequest.mockResolvedValue({
      ...CLEAN_RUN,
      frame_mode: 'scene',
      // 5 秒的跑，光抓帧就占了 1.8 秒
      frames: frames.map((frame) => ({ ...frame, capture_ms: 200 }))
    })

    const summary = String((await run({ frames: 9 })).summary)

    expect(summary).toContain('1800ms')
    expect(summary).toContain('不能算数')
  })

  it('开销很小的时候不加这句噪音', async () => {
    const frames = await writeBigFrames(9)
    callRequest.mockResolvedValue({
      ...CLEAN_RUN,
      frame_mode: 'scene',
      frames: frames.map((frame) => ({ ...frame, capture_ms: 20 }))
    })

    expect(String((await run({ frames: 9 })).summary)).not.toContain('不能算数')
  })
})

/**
 * 界面上那个卡片显示的是**磁盘上的文件**，不是进模型上下文那份 base64。
 *
 * 2026-09-17 真机上当场撞到：模型收到 4 张拼图、照着写了结论，用户界面上
 * 只有收尾那一张截图，于是问「好像没运行」。两边看的不是同一批画面时，
 * 用户没法复核模型说的话 —— 这比看不见更糟。
 */
describe('拼图要能在界面上看到', () => {
  let uiDir = ''

  beforeAll(async () => {
    uiDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'ual-pie-ui-'))
  })

  afterAll(async () => {
    await nodeFs.rm(uiDir, { recursive: true, force: true })
  })

  const makeFrames = async (count: number): Promise<Array<{ at: number; path: string }>> => {
    const sharp = (await import('sharp')).default
    const out: Array<{ at: number; path: string }> = []
    for (let i = 0; i < count; i++) {
      const file = nodePath.join(uiDir, `ui-${i}.png`)
      await sharp(
        Buffer.from(
          `<svg width="640" height="360"><rect width="640" height="360" fill="#333"/></svg>`
        )
      )
        .png()
        .toFile(file)
      out.push({ at: i * 0.5, path: file })
    }
    return out
  }

  it('拼图存进磁盘并按顺序进 image_paths，收尾那张排最后', async () => {
    const frames = await makeFrames(12)
    callRequest.mockResolvedValue({ ...CLEAN_RUN, frames, frame_mode: 'scene' })

    const result = await run({ frames: 12 })

    const paths = result.image_paths as string[]
    // 两张拼图 + 收尾那张
    expect(paths).toHaveLength(3)
    expect(paths[2]).toBe('C:/tmp/shot.png')
    // 存盘了才看得见，光有路径不算
    for (const file of paths.slice(0, 2)) {
      await expect(nodeFs.access(file)).resolves.toBeUndefined()
    }
  })

  it('没开多帧采样时不塞这个字段，走原来单张那条路', async () => {
    callRequest.mockResolvedValue(CLEAN_RUN)

    expect(await run({})).not.toHaveProperty('image_paths')
  })

  it('用户关掉编辑器截图时不落盘也不回路径', async () => {
    const frames = await makeFrames(2)
    callRequest.mockResolvedValue({ ...CLEAN_RUN, frames, frame_mode: 'scene' })

    const result = await runWithEditorScreenshotScope(false, () => run({ frames: 2 }))

    expect(result).not.toHaveProperty('image_paths')
  })
})
