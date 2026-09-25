/**
 * @vitest-environment node
 *
 * RVT 五项体检的判据。每一项没对上时引擎都不报错，所以这张表漏判一项，
 * 用户那边就是「配好了但黑一块」而没人说得出原因。
 */

import { describe, expect, it } from 'vitest'

import { diagnoseRvt, PROJECT_VT_OFF } from './rvtHealth'
import type { LandscapeInfo, RvtAssignment } from './types'

const color = (overrides: Partial<RvtAssignment> = {}): RvtAssignment => ({
  asset: '/Game/RVT/Color',
  material_type: 'BaseColor_Normal_Specular',
  kind: 'color',
  on_landscape_actor: true,
  proxies_with: 4,
  proxies_total: 4,
  volumes: [{ label: 'V', covers_xy: true, covers_z: true }],
  ...overrides
})

const height = (overrides: Partial<RvtAssignment> = {}): RvtAssignment =>
  color({ asset: '/Game/RVT/Height', material_type: 'WorldHeight', kind: 'height', ...overrides })

function land(
  assigned: RvtAssignment[],
  pins: Partial<Record<string, boolean>> = {}
): LandscapeInfo {
  return {
    label: 'L',
    name: 'L',
    path: 'L',
    location: { x: 0, y: 0, z: 0 },
    scale: { x: 100, y: 100, z: 100 },
    quad_size_m: 1,
    heightmap_range_m: 512,
    quads_per_section: 63,
    sections_per_component: 2,
    component_size_quads: 126,
    streaming_proxies_loaded: 4,
    material: '/Game/M',
    rvt: {
      material_output: {
        material: '/Game/M',
        found: true,
        searched: 'graph_and_functions',
        functions_searched: 0,
        pins: {
          base_color: true,
          normal: true,
          roughness: true,
          specular: true,
          world_height: true,
          ...pins
        }
      },
      assigned
    }
  }
}

const on = { project_virtual_texturing: true }

describe('diagnoseRvt', () => {
  it('五项都对上时没有问题', () => {
    expect(diagnoseRvt(on, land([color(), height()]))).toEqual([
      { kind: 'color', asset: '/Game/RVT/Color', problems: [] },
      { kind: 'height', asset: '/Game/RVT/Height', problems: [] }
    ])
  })

  it('项目开关没开，每一类都带上这一条', () => {
    const result = diagnoseRvt({ project_virtual_texturing: false }, land([color(), height()]))
    expect(result.every((d) => d.problems[0] === PROJECT_VT_OFF)).toBe(true)
  })

  it('不指定类别时只查已经挂着的；指定了而没挂就报缺', () => {
    expect(diagnoseRvt(on, land([]))).toEqual([])
    expect(diagnoseRvt(on, land([color()]), ['height'])).toEqual([
      { kind: 'height', problems: ['地形没往任何高度 RVT 里画'] }
    ])
  })

  it('只有部分代理往里画', () => {
    const [d] = diagnoseRvt(on, land([color({ proxies_with: 3 })]))
    expect(d.problems).toEqual(['只有 3/4 块地形往这张 RVT 里画，其余区域是空的'])
  })

  it('没有体积 / 体积没罩住水平范围', () => {
    expect(diagnoseRvt(on, land([color({ volumes: [] })]))[0].problems).toEqual([
      '场景里没有指向这张 RVT 的 RVT 体积，RVT 是空的'
    ])
    expect(
      diagnoseRvt(
        on,
        land([color({ volumes: [{ label: 'V', covers_xy: false, covers_z: true }] })])
      )[0].problems
    ).toEqual(['RVT 体积没罩住整块地形，罩不到的地方会发黑'])
  })

  it('竖直方向没罩住只对高度 RVT 算问题', () => {
    const volumes = [{ label: 'V', covers_xy: true, covers_z: false }]
    expect(diagnoseRvt(on, land([color({ volumes })]))[0].problems).toEqual([])
    expect(diagnoseRvt(on, land([height({ volumes })]))[0].problems).toEqual([
      'RVT 体积没罩住地形的全部高度，超出去的高度会被截断'
    ])
  })

  it('材质引脚按类别查：颜色看 BaseColor，高度看 WorldHeight', () => {
    const [c, h] = diagnoseRvt(
      on,
      land([color(), height()], { base_color: false, world_height: false })
    )
    expect(c.problems).toEqual([expect.stringContaining('BaseColor 引脚没接')])
    expect(h.problems).toEqual([expect.stringContaining('WorldHeight 引脚没接')])
  })

  it('材质里没找到输出节点时说清楚搜了哪里、没搜哪里', () => {
    const l = land([color()])
    l.rvt!.material_output = {
      material: '/Game/M',
      found: false,
      searched: 'graph_and_functions',
      functions_searched: 5
    }
    const [d] = diagnoseRvt(on, l)
    expect(d.problems[0]).toContain('搜了材质图和 5 个材质函数，材质图层里的没搜')
  })

  it('地形没挂材质', () => {
    const l = land([color()])
    l.rvt!.material_output = { material: '', found: false, searched: 'no_material' }
    expect(diagnoseRvt(on, l)[0].problems).toEqual(['地形没挂材质，没有东西写进 RVT'])
  })
})
