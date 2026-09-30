// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseGenericCsv } from './insightsCsv'
import {
  diffThread,
  frameStats,
  gameThreadSpikes,
  isWaitTimer,
  missingColumns,
  subtractGpuRows,
  summarizeThread,
  toTimerRows,
  type TimerRow
} from './insightsBreakdown'

/**
 * 行取自一份真实 trace（UE 5.5，47 MB，898 帧）按线程导出的计时器统计，原样照抄。
 * GPU 那几行在三份导出里一字不差 —— 这正是要减掉的东西。
 */
const HEADER = 'Name,Count,Incl,I.Min,I.Max,I.Avg,I.Med,Excl,E.Min,E.Max,E.Avg,E.Med'
const GPU_ROWS = [
  'DistanceFields,1328,0.374714,0.000000,0.084453,0.000282,0.000000,0.374714,0.000000,0.084453,0.000282,0.000000',
  'NaniteVisBuffer,1328,0.594501,0.000007,0.004516,0.000448,0.000098,0.594501,0.000007,0.004516,0.000448,0.000098',
  'ShadowDepths,664,3.638228,0.000380,0.021604,0.005479,0.005740,3.618157,0.000370,0.021468,0.005449,0.005698',
  'Unaccounted -  Frame: 72844,1,0.063173,0.063173,0.063173,0.063173,0.063173,0.008938,0.008938,0.008938,0.008938,0.008938'
]
const GAME_ROWS = [
  ...GPU_ROWS,
  'FEngineLoop::Tick,898,50.913304,0.011642,10.328254,0.056696,0.011642,0.007274,0.000005,0.000024,0.000008,0.000008',
  'Frame,898,50.900838,0.011631,10.328239,0.056682,0.011631,5.078338,0.000227,0.280242,0.005655,0.000227',
  'WaitForTasks,4855,0.648200,0.000001,0.420979,0.000134,0.000001,0.648200,0.000001,0.420979,0.000134,0.000001',
  'WaitUntilTasksComplete,7086,16.597561,0.000000,0.455060,0.002342,0.000000,2.538694,0.000000,0.040485,0.000358,0.000000',
  'CreatePhysicsShapesAndActors,4767,8.826502,0.000001,2.579510,0.001852,0.000001,8.680754,0.000001,2.562932,0.001821,0.000001',
  'UCharacterMovementComponent_TickComponent,1008,6.633365,0.004260,0.069897,0.006581,0.004260,6.633202,0.004260,0.069897,0.006581,0.004260'
]
const RENDER_ROWS = [
  ...GPU_ROWS,
  'WaitForTasks,27655,43.677685,0.000001,0.045352,0.001579,0.000001,43.677685,0.000001,0.045352,0.001579,0.000001',
  'FDeferredShadingSceneRenderer_Render,658,3.308867,0.001025,0.062424,0.005029,0.004746,0.000743,0.000000,0.000005,0.000001,0.000001',
  // 渲染线程自己也有一个叫 ShadowDepths 的计时器 —— 同名不同数，不能被当成 GPU 行减掉
  'ShadowDepths,658,1.090498,0.000254,0.029888,0.001657,0.000853,0.004232,0.000002,0.000064,0.000006,0.000006',
  'Frame 72844,1,10.386686,10.386686,10.386686,10.386686,10.386686,0.019343,0.019343,0.019343,0.019343,0.019343'
]

const rows = (lines: string[]): TimerRow[] =>
  toTimerRows(parseGenericCsv([HEADER, ...lines].join('\n'))!)

const gpu = rows(GPU_ROWS)
const game = subtractGpuRows(rows(GAME_ROWS), gpu)
const render = subtractGpuRows(rows(RENDER_ROWS), gpu)

describe('subtractGpuRows', () => {
  it('减掉引擎硬塞进 CPU 线程导出的 GPU 行', () => {
    expect(game.map((r) => r.name)).not.toContain('DistanceFields')
    expect(game.map((r) => r.name)).not.toContain('NaniteVisBuffer')
  })

  it('同名但次数、耗时不同的 CPU 计时器留下', () => {
    const shadow = render.filter((r) => r.name === 'ShadowDepths')
    expect(shadow).toHaveLength(1)
    expect(shadow[0]!.count).toBe(658)
  })
})

describe('frameStats', () => {
  it('从游戏线程的 Frame 计时器读帧数和帧耗时', () => {
    expect(frameStats(game)).toEqual({
      frames: 898,
      avg_ms: 56.68,
      median_ms: 11.63,
      max_ms: 10328.24
    })
  })

  it('没有 Frame 时给 null，不编帧数', () => {
    expect(frameStats(gpu)).toBeNull()
  })
})

describe('summarizeThread', () => {
  it('游戏线程：按自身耗时排，等待和帧外壳不进排行', () => {
    const s = summarizeThread(game, 898, 10)
    expect(s.top.map((t) => t.name)).toEqual([
      'CreatePhysicsShapesAndActors',
      'UCharacterMovementComponent_TickComponent'
    ])
    expect(s.top[0]).toMatchObject({ excl_total_ms: 8680.75, excl_per_frame_ms: 9.67 })
    expect(s.wait_total_ms).toBe(3186.89)
  })

  it('渲染线程：43 秒的 WaitForTasks 只进等待合计，不当成瓶颈', () => {
    const s = summarizeThread(render, 898, 10)
    expect(s.top.map((t) => t.name)).not.toContain('WaitForTasks')
    expect(s.top.map((t) => t.name)).not.toContain('Frame 72844')
    expect(s.wait_total_ms).toBe(43677.69)
  })

  it('GPU：去掉每帧一行的 Unaccounted', () => {
    const s = summarizeThread(gpu, 898, 10)
    expect(s.top.map((t) => t.name)).toEqual(['ShadowDepths', 'NaniteVisBuffer', 'DistanceFields'])
  })

  it('没有帧数时不摊每帧', () => {
    expect(summarizeThread(gpu, null, 1).top[0]!.excl_per_frame_ms).toBeNull()
  })
})

describe('gameThreadSpikes', () => {
  it('按单次最长的自身耗时排', () => {
    const spikes = gameThreadSpikes(game, 898, 5)
    expect(spikes[0]).toMatchObject({ name: 'CreatePhysicsShapesAndActors', excl_max_ms: 2562.93 })
  })
})

describe('isWaitTimer', () => {
  it.each([
    'WaitForTasks',
    'WaitUntilTasksComplete',
    'GameThreadWaitForTask',
    'FTaskBase::WaitImpl_StateChangeEvent_WaitFor'
  ])('%s 是等待', (name) => expect(isWaitTimer(name)).toBe(true))
  it.each([
    'UWorld::Tick',
    // 说出了在等什么的「等待」是卡顿原因，要留在排行里
    'FShaderCompilingManager::BlockOnShaderMapCompletion',
    'UWorld::BlockTillLevelStreamingCompleted',
    'WaitForGatherDynamicMeshElements',
    'UAssetRegistryImpl::WaitForCompletion'
  ])('%s 不算', (name) => expect(isWaitTimer(name)).toBe(false))
})

describe('missingColumns', () => {
  it('报出缺了哪几列', () => {
    expect(missingColumns(parseGenericCsv('Name,Total\nA,1')!)).toEqual([
      'Count',
      'Incl',
      'Excl',
      'E.Max'
    ])
  })
})

describe('diffThread', () => {
  const row = (name: string, exclSeconds: number): TimerRow => ({
    name,
    count: 1,
    incl: exclSeconds,
    excl: exclSeconds,
    exclMax: exclSeconds,
    inclAvg: null,
    inclMed: null,
    inclMax: null
  })

  it('按每帧对齐：录制时长不同也能比', () => {
    // 基准 100 帧里 Physics 共 1 秒 = 10 ms/帧；当前 200 帧里共 3 秒 = 15 ms/帧
    const d = diffThread([row('Physics', 1)], [row('Physics', 3)], 100, 200, 10)
    expect(d.regressions).toEqual([
      {
        name: 'Physics',
        baseline_per_frame_ms: 10,
        current_per_frame_ms: 15,
        delta_per_frame_ms: 5
      }
    ])
    expect(d.improvements).toEqual([])
  })

  it('新冒出来的计时器算变慢，消失的算变快', () => {
    const d = diffThread([row('Old', 1)], [row('New', 1)], 100, 100, 10)
    expect(d.regressions.map((x) => x.name)).toEqual(['New'])
    expect(d.improvements.map((x) => x.name)).toEqual(['Old'])
  })

  it('小于 0.05 ms/帧的变化不报；等待类不参与', () => {
    const d = diffThread(
      [row('Tiny', 1), row('WaitForTasks', 1)],
      [row('Tiny', 1.004), row('WaitForTasks', 9)],
      100,
      100,
      10
    )
    expect(d.regressions).toEqual([])
  })
})
