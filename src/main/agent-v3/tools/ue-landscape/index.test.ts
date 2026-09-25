/**
 * @vitest-environment node
 *
 * 地形工具集。
 *
 * 引擎侧（新建地形、挂 RVT、算体积边界）要一个真编辑器，这里测不到。
 * 这里钉住这一层自己保证的事：
 *   1. 工具注册了，风险等级对（两个写工具标错会让 auto-edit 档静默改关卡）
 *   2. 参数按约定的字段名传到 RPC，schema 挡掉插件那边会拒的请求
 *   3. 回执跟着引擎走：尺寸报读回的实际值，不回显请求（AGENTS.md §5 第 14 条）
 *   4. 部分失败第一句不说成功；全部失败抛错
 *   5. 配置写好了但五项体检没过时，明说「还不会有效果」
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import { landscapeTools } from './index'
import type { LandscapeInfo, RvtSetupResult } from './types'

interface AgentResult {
  content: Array<{ type: string; text?: string }>
  details?: unknown
}

type Executable = {
  name: string
  unrealBox: { namespace: string; risk: string }
  execute: (id: string, input: unknown) => Promise<AgentResult>
}

const byName = (name: string): Executable => {
  const found = (landscapeTools() as unknown as Executable[]).find((t) => t.name === name)
  if (!found) throw new Error(`工具未注册：${name}`)
  return found
}

const textOf = (result: AgentResult): string =>
  result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')

const lastCall = (): { method: string; params: Record<string, unknown> } => {
  const [method, params] = callRequest.mock.calls.at(-1) as [string, Record<string, unknown>]
  return { method, params }
}

/** 一块 1008 米见方、已经挂好颜色 RVT、一切正常的地形 */
function landscape(overrides: Partial<LandscapeInfo> = {}): LandscapeInfo {
  return {
    label: 'Landscape',
    name: 'Landscape_0',
    path: '/Game/Maps/Test.Test:PersistentLevel.Landscape_0',
    location: { x: -50400, y: -50400, z: 0 },
    scale: { x: 100, y: 100, z: 100 },
    quad_size_m: 1,
    heightmap_range_m: 512,
    quads_per_section: 63,
    sections_per_component: 2,
    component_size_quads: 126,
    loaded_extent: { resolution: { x: 1009, y: 1009 }, component_count: { x: 8, y: 8 } },
    streaming_proxies_loaded: 0,
    bounds: { min: { x: -50400, y: -50400, z: -1 }, max: { x: 50400, y: 50400, z: 1 } },
    size_m: { x: 1008, y: 1008, z: 0.02 },
    material: '/Game/M_Ground.M_Ground',
    rvt: {
      material_output: {
        material: '/Game/M_Ground.M_Ground',
        found: true,
        searched: 'graph_and_functions',
        functions_searched: 2,
        pins: {
          base_color: true,
          normal: true,
          roughness: true,
          specular: false,
          world_height: true
        }
      },
      assigned: [
        {
          asset: '/Game/Landscape/RVT/RVT_Landscape_Color',
          material_type: 'BaseColor_Normal_Specular',
          kind: 'color',
          on_landscape_actor: true,
          proxies_with: 1,
          proxies_total: 1,
          volumes: [{ label: 'RVTVolume_Landscape_Color', covers_xy: true, covers_z: true }]
        }
      ]
    },
    ...overrides
  }
}

const level = {
  world_partition: false,
  level_package: '/Game/Maps/Test',
  project_virtual_texturing: true
}

const okColor: RvtSetupResult = {
  kind: 'color',
  ok: true,
  asset_path: '/Game/Landscape/RVT/RVT_Landscape_Color',
  asset_created: true,
  material_type: 'BaseColor_Normal_Specular',
  on_landscape_actor: true,
  proxies_with: 1,
  proxies_total: 1,
  volume: { label: 'RVTVolume_Landscape_Color', created: true, covers_xy: true, covers_z: true }
}

beforeEach(() => {
  callRequest.mockReset()
  getConnectionCount.mockReturnValue(1)
})

describe('注册', () => {
  it('三个工具都在 ue.landscape 下，写工具标 mutating，列表标 safe', () => {
    const risks = Object.fromEntries(
      (landscapeTools() as unknown as Executable[]).map((t) => [t.name, t.unrealBox.risk])
    )
    expect(risks).toEqual({
      landscape_create: 'mutating',
      landscape_setup_rvt: 'mutating',
      landscape_list: 'safe'
    })
    for (const tool of landscapeTools() as unknown as Executable[]) {
      expect(tool.unrealBox.namespace).toBe('ue.landscape')
    }
  })
})

describe('landscape_create', () => {
  it('参数按插件认的字段名传过去', async () => {
    callRequest.mockResolvedValueOnce({
      ...level,
      landscape: landscape(),
      undoable: true,
      requested: { size_x_m: 1000, size_y_m: 1000, quad_size_m: 1, height_range_m: 512 },
      failed_count: 0
    })
    await byName('landscape_create').execute('t', {
      size_x_m: 1000,
      location: { x: 100, y: 200 },
      material: '/Game/M_Ground',
      rvt: { color: true, height: { asset_path: '/Game/RVT/H' } }
    })
    const { method, params } = lastCall()
    expect(method).toBe('landscape.create')
    expect(params).toMatchObject({
      size_x_m: 1000,
      location: { x: 100, y: 200, z: 0 },
      material: '/Game/M_Ground',
      rvt: { color: true, height: { asset_path: '/Game/RVT/H' } }
    })
  })

  it('尺寸报引擎读回的实际值，并说出和请求的差别', async () => {
    callRequest.mockResolvedValueOnce({
      ...level,
      landscape: landscape(),
      undoable: true,
      requested: { size_x_m: 1000, size_y_m: 1000, quad_size_m: 1, height_range_m: 512 },
      failed_count: 0
    })
    const text = textOf(await byName('landscape_create').execute('t', { size_x_m: 1000 }))
    expect(text).toContain('要的是 1,000 × 1,000 米，实际 1,008 × 1,008 米')
    expect(text).toContain('分辨率 1,009 × 1,009，8 × 8 块')
    expect(text.startsWith('地形已建好')).toBe(true)
  })

  it('请求的材质读回来是空的就明说', async () => {
    callRequest.mockResolvedValueOnce({
      ...level,
      landscape: landscape({ material: '' }),
      undoable: true,
      requested: {
        size_x_m: 1000,
        quad_size_m: 1,
        height_range_m: 512,
        material: '/Game/M_Ground'
      },
      failed_count: 0
    })
    const text = textOf(
      await byName('landscape_create').execute('t', { size_x_m: 1000, material: '/Game/M_Ground' })
    )
    expect(text).toContain('请求的材质 /Game/M_Ground 读回来是空的')
  })

  it('高度图被重采样时说出原图和实际尺寸', async () => {
    callRequest.mockResolvedValueOnce({
      ...level,
      landscape: landscape(),
      undoable: true,
      heightmap: {
        path: 'D:/maps/valley.png',
        source_resolution: { x: 1024, y: 1024 },
        resolution: { x: 1009, y: 1009 },
        resampled: true,
        candidate_resolutions: 1
      },
      requested: { quad_size_m: 1, height_range_m: 300 },
      failed_count: 0
    })
    const text = textOf(
      await byName('landscape_create').execute('t', {
        heightmap_path: 'D:/maps/valley.png',
        height_range_m: 300
      })
    )
    expect(text).toContain('原图 1024 × 1024，已重采样到 1009 × 1009')
  })

  it('既没尺寸也没高度图、或者超出每边格数上限时，在发 RPC 之前就拒绝', async () => {
    await expect(byName('landscape_create').execute('t', {})).rejects.toThrow()
    await expect(byName('landscape_create').execute('t', { size_x_m: 9000 })).rejects.toThrow(
      /8,160/
    )
    // 格子放大一倍就放得下
    callRequest.mockResolvedValueOnce({
      ...level,
      landscape: landscape(),
      undoable: true,
      requested: { size_x_m: 9000, quad_size_m: 2, height_range_m: 512 },
      failed_count: 0
    })
    await byName('landscape_create').execute('t', { size_x_m: 9000, quad_size_m: 2 })
    expect(callRequest).toHaveBeenCalledTimes(1)
  })

  it('地形建好但 RVT 一项失败：第一句是部分完成，失败原因跟在后面', async () => {
    callRequest.mockResolvedValueOnce({
      ...level,
      landscape: landscape(),
      undoable: true,
      requested: { size_x_m: 1000, quad_size_m: 1, height_range_m: 512 },
      rvt_results: [
        okColor,
        { kind: 'height', ok: false, error: 'spawning its RuntimeVirtualTextureVolume failed' }
      ],
      failed_count: 1
    })
    const text = textOf(
      await byName('landscape_create').execute('t', {
        size_x_m: 1000,
        rvt: { color: true, height: true }
      })
    )
    expect(text.split('\n')[0]).toBe('⚠️ 部分完成：1 项 RVT 成功 / 1 项 RVT 失败。')
    expect(text).toContain('- 高度 RVT：spawning its RuntimeVirtualTextureVolume failed')
    // 失败的那一类只在失败清单里出现一次，不再被体检换个说法报第二遍
    expect(text).not.toContain('地形没往任何高度 RVT 里画')
  })
})

describe('landscape_setup_rvt', () => {
  it('color / height 至少要一个', async () => {
    await expect(byName('landscape_setup_rvt').execute('t', {})).rejects.toThrow()
    await expect(byName('landscape_setup_rvt').execute('t', { color: false })).rejects.toThrow()
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('全部没配成按错误抛', async () => {
    callRequest.mockResolvedValueOnce({
      ...level,
      landscape: landscape(),
      rvt_results: [{ kind: 'color', ok: false, error: 'not a runtime virtual texture' }],
      failed_count: 1
    })
    await expect(byName('landscape_setup_rvt').execute('t', { color: true })).rejects.toThrow(
      /一项都没配成[\s\S]*not a runtime virtual texture/
    )
  })

  it('插件那三步做完了，但项目开关和材质节点没对上：说还不会有效果', async () => {
    const land = landscape()
    land.rvt!.material_output = {
      material: '/Game/M_Ground.M_Ground',
      found: false,
      searched: 'graph_and_functions',
      functions_searched: 3
    }
    callRequest.mockResolvedValueOnce({
      ...level,
      project_virtual_texturing: false,
      landscape: land,
      rvt_results: [okColor],
      failed_count: 0
    })
    const text = textOf(await byName('landscape_setup_rvt').execute('t', { color: true }))
    expect(text).toContain('RVT 现在还不会有效果')
    expect(text).toContain('项目没开虚拟纹理支持')
    expect(text).toContain('没找到 Runtime Virtual Texture Output 节点')
    expect(text).not.toContain('五项检查都对上了')
    expect(lastCall()).toMatchObject({ method: 'landscape.setup_rvt', params: { color: true } })
  })

  it('五项都对上时才说对上了', async () => {
    callRequest.mockResolvedValueOnce({
      ...level,
      landscape: landscape(),
      rvt_results: [okColor],
      failed_count: 0
    })
    const text = textOf(await byName('landscape_setup_rvt').execute('t', { color: true }))
    expect(text).toContain('五项检查都对上了')
    expect(text).not.toContain('⚠️')
  })
})

describe('landscape_list', () => {
  it('没有地形时指路 landscape_create', async () => {
    callRequest.mockResolvedValueOnce({ ...level, landscapes: [] })
    const text = textOf(await byName('landscape_list').execute('t', {}))
    expect(text).toContain('关卡里没有地形')
    expect(text).toContain('landscape_create')
  })

  it('没挂 RVT 不算毛病；挂了就逐项体检', async () => {
    callRequest.mockResolvedValueOnce({
      ...level,
      landscapes: [
        landscape({
          label: 'Bare',
          rvt: {
            material_output: { material: '', found: false, searched: 'no_material' },
            assigned: []
          }
        }),
        landscape({ label: 'WithRvt' })
      ]
    })
    const text = textOf(await byName('landscape_list').execute('t', {}))
    expect(text).toContain('地形「Bare」')
    expect(text).toContain('RVT：没挂')
    expect(text).toContain('✅ 颜色 RVT /Game/Landscape/RVT/RVT_Landscape_Color：五项都对上了')
  })
})
