import { describe, expect, it } from 'vitest'

import { summarizeMesh } from './summarize'
import type { MeshDescribeResponse } from './types'

/**
 * 这一层是网格工具里唯一能真正测的东西 —— 引擎那半边在 C++ 里。
 *
 * 重点测**判断**而不是**格式**：⚠️ 出现与否是产品行为
 * （用户看不到警告就不知道资产坏了），换行怎么排不是。
 */

const staticMesh = (over: Partial<MeshDescribeResponse> = {}): MeshDescribeResponse => ({
  path: '/Game/Meshes/SM_Rock',
  type: 'static',
  lods: [{ index: 0, triangles: 1200, vertices: 700, screen_size: 1 }],
  material_slots: [{ index: 0, slot_name: 'M_Rock', material: '/Game/M_Rock' }],
  collision: { primitives: 4, convex_hulls: 4, complexity: 'simple_and_complex', has_any: true },
  nanite: { enabled: false },
  lightmap: { coordinate_index: 1, lod0_uv_channels: 2, index_valid: true },
  bounds: { size: { x: 240, y: 180, z: 95 } },
  ...over
})

const skeletalMesh = (over: Partial<MeshDescribeResponse> = {}): MeshDescribeResponse => ({
  path: '/Game/Characters/SK_Hero',
  type: 'skeletal',
  lods: [{ index: 0, triangles: 32_000, vertices: 18_000, screen_size: 1 }],
  material_slots: [{ index: 0, slot_name: 'M_Body' }],
  skeleton: '/Game/Characters/SKEL_Hero',
  bones: { count: 87, root: 'root', max_depth: 9 },
  has_physics_asset: true,
  physics_asset: '/Game/Characters/PHYS_Hero',
  morph_targets: [],
  ...over
})

describe('summarizeMesh —— 基本信息', () => {
  it('静态网格报出路径与类型', () => {
    const text = summarizeMesh(staticMesh())
    expect(text).toContain('/Game/Meshes/SM_Rock')
    expect(text).toContain('静态网格')
  })

  it('骨骼网格报出路径与类型', () => {
    expect(summarizeMesh(skeletalMesh())).toContain('骨骼网格')
  })

  it('LOD 面数带千分位，方便一眼看出量级', () => {
    const text = summarizeMesh(staticMesh({ lods: [{ index: 0, triangles: 1_234_567 }] }))
    expect(text).toContain('1,234,567')
  })

  it('标出 LOD 是导入的还是生成的 —— 决定能不能覆盖', () => {
    const text = summarizeMesh(
      staticMesh({
        lods: [
          { index: 0, triangles: 1000, source: 'imported' },
          { index: 1, triangles: 500, source: 'generated' }
        ]
      })
    )
    expect(text).toContain('(导入)')
    expect(text).toContain('(生成)')
  })

  it('LOD 明细带上顶点/分段/UV —— details 只到界面，模型只看得到这段文本', () => {
    const text = summarizeMesh(
      staticMesh({
        lods: [{ index: 0, triangles: 1200, vertices: 700, sections: 3, uv_channels: 2 }]
      })
    )
    expect(text).toContain('700 顶点')
    // 分段数就是这一级 LOD 的 draw call 数
    expect(text).toContain('3 段')
    expect(text).toContain('2UV')
  })

  it('缺的 LOD 明细字段不占位，不写成「? 顶点」', () => {
    const text = summarizeMesh(staticMesh({ lods: [{ index: 0, triangles: 1200 }] }))
    expect(text).toContain('1,200 面')
    expect(text).not.toContain('顶点')
    expect(text).not.toContain('段')
  })

  it('材质槽带上资产路径 —— 否则答不了「现在挂的是什么材质」', () => {
    const text = summarizeMesh(staticMesh())
    expect(text).toContain('M_Rock→/Game/M_Rock')
  })

  it('空材质槽标成 (空) —— 那是网格显示成默认灰的直接原因', () => {
    const text = summarizeMesh(
      staticMesh({ material_slots: [{ index: 0, slot_name: 'Slot0', material: '' }] })
    )
    expect(text).toContain('Slot0→(空)')
  })

  it('类型未知时不谎报成静态网格', () => {
    expect(summarizeMesh({ path: '/Game/X' })).toContain('未知类型')
  })

  it('空响应不抛异常', () => {
    expect(() => summarizeMesh({})).not.toThrow()
  })
})

describe('summarizeMesh —— 没有碰撞（设计文档 §4.1）', () => {
  it('has_any 为 false 时报警告，并带上根因线索', () => {
    const text = summarizeMesh(
      staticMesh({ collision: { primitives: 0, has_any: false, complexity: 'default' } })
    )
    expect(text).toContain('⚠️')
    expect(text).toContain('没有任何碰撞')
    // 只说「没碰撞」没用 —— 要告诉他去哪儿找原因
    expect(text).toContain('UCX_')
  })

  it('有碰撞时不报警告', () => {
    expect(summarizeMesh(staticMesh())).not.toContain('没有任何碰撞')
  })
})

describe('summarizeMesh —— 光照贴图 UV（设计文档 §4.2）', () => {
  it('通道索引越界时报警告，并点明提高分辨率修不好', () => {
    const text = summarizeMesh(
      staticMesh({ lightmap: { coordinate_index: 3, lod0_uv_channels: 2, index_valid: false } })
    )
    expect(text).toContain('⚠️')
    expect(text).toContain('指向不存在的 UV 通道')
    // 用户最容易走的弯路就是去调分辨率
    expect(text).toContain('分辨率')
  })

  it('索引有效时不报警告', () => {
    expect(summarizeMesh(staticMesh())).not.toContain('指向不存在的 UV 通道')
  })
})

describe('summarizeMesh —— LOD 屏占比必须递减', () => {
  it('递减时不报警告', () => {
    const text = summarizeMesh(
      staticMesh({
        lods: [
          { index: 0, triangles: 1000, screen_size: 1 },
          { index: 1, triangles: 500, screen_size: 0.4 },
          { index: 2, triangles: 200, screen_size: 0.1 }
        ]
      })
    )
    expect(text).not.toContain('不是逐级递减')
  })

  it('不递减时报警告', () => {
    const text = summarizeMesh(
      staticMesh({
        lods: [
          { index: 0, triangles: 1000, screen_size: 0.3 },
          { index: 1, triangles: 500, screen_size: 0.6 }
        ]
      })
    )
    expect(text).toContain('⚠️')
    expect(text).toContain('不是逐级递减')
  })

  it('相等也算不递减 —— 那一级永远不显示', () => {
    const text = summarizeMesh(
      staticMesh({
        lods: [
          { index: 0, triangles: 1000, screen_size: 0.5 },
          { index: 1, triangles: 500, screen_size: 0.5 }
        ]
      })
    )
    expect(text).toContain('不是逐级递减')
  })

  it('只有一级 LOD 时不判断递减', () => {
    expect(summarizeMesh(staticMesh())).not.toContain('不是逐级递减')
  })

  it('缺 screen_size 时不误报', () => {
    const text = summarizeMesh(
      staticMesh({
        lods: [
          { index: 0, triangles: 1000 },
          { index: 1, triangles: 500 }
        ]
      })
    )
    expect(text).not.toContain('不是逐级递减')
  })
})

describe('summarizeMesh —— Nanite 只陈述不下结论（设计文档 §4.4）', () => {
  const dense = staticMesh({
    lods: [{ index: 0, triangles: 80_000, screen_size: 1 }],
    nanite: { enabled: false }
  })

  it('单级高面数且 Nanite 关闭时提示', () => {
    expect(summarizeMesh(dense)).toContain('远处渲染没有任何降级')
  })

  it('不说「应该开 Nanite」—— 社区有实证反对无脑开启', () => {
    const text = summarizeMesh(dense)
    expect(text).not.toContain('应该开')
    expect(text).toContain('不一定是问题')
  })

  it('Nanite 已开时不提示', () => {
    const text = summarizeMesh(
      staticMesh({
        lods: [{ index: 0, triangles: 80_000 }],
        nanite: { enabled: true }
      })
    )
    expect(text).not.toContain('远处渲染没有任何降级')
  })

  it('面数低时不提示', () => {
    expect(summarizeMesh(staticMesh())).not.toContain('远处渲染没有任何降级')
  })

  it('已有多级 LOD 时不提示', () => {
    const text = summarizeMesh(
      staticMesh({
        lods: [
          { index: 0, triangles: 80_000, screen_size: 1 },
          { index: 1, triangles: 20_000, screen_size: 0.3 }
        ],
        nanite: { enabled: false }
      })
    )
    expect(text).not.toContain('远处渲染没有任何降级')
  })
})

describe('summarizeMesh —— 骨骼网格缺物理资产（设计文档 §4.5）', () => {
  it('没有物理资产时报警告', () => {
    const text = summarizeMesh(skeletalMesh({ has_physics_asset: false, physics_asset: '' }))
    expect(text).toContain('⚠️')
    expect(text).toContain('没有物理资产')
  })

  it('警告里说明 Per Poly Collision 不能替代', () => {
    const text = summarizeMesh(skeletalMesh({ has_physics_asset: false }))
    expect(text).toContain('Per Poly Collision')
  })

  it('有物理资产时不报警告', () => {
    expect(summarizeMesh(skeletalMesh())).not.toContain('没有物理资产')
  })
})

describe('summarizeMesh —— 骨骼网格朝向', () => {
  it('认出朝向时把补偿角报进正文，并说清 yaw 该怎么填', () => {
    const text = summarizeMesh(
      skeletalMesh({
        facing: { known: true, from_bones: 'foot_l / foot_r', yaw_offset: -90 }
      })
    )
    expect(text).toContain('朝向')
    expect(text).toContain('-90.0°')
    expect(text).toContain('foot_l / foot_r')
    // 偏移是负的，要让人去加回来
    expect(text).toContain('+ 90.0')
  })

  it('认不出来就说认不出来，不给一个猜出来的角度', () => {
    const text = summarizeMesh(
      skeletalMesh({ facing: { known: false, reason: 'no left/right bone pair recognized' } })
    )
    expect(text).toContain('认不出来')
    expect(text).toContain('截图')
    expect(text).not.toContain('偏离网格 +X 轴')
  })

  it('老插件不回 facing 时整段不出现', () => {
    expect(summarizeMesh(skeletalMesh())).not.toContain('朝向')
  })
})

describe('summarizeMesh —— 骨骼与 Morph 的上下文控制', () => {
  it('骨骼只给摘要，不列出每一根', () => {
    const text = summarizeMesh(skeletalMesh())
    expect(text).toContain('87 根')
    expect(text).toContain('root')
    expect(text).toContain('最深 9 层')
  })

  it('Morph Target 超过 8 个时截断并说明还有多少', () => {
    const names = Array.from({ length: 20 }, (_, i) => `Morph_${i}`)
    const text = summarizeMesh(skeletalMesh({ morph_targets: names }))
    expect(text).toContain('20 个')
    expect(text).toContain('还有 12 个')
    expect(text).not.toContain('Morph_19')
  })

  it('没有 Morph Target 时整行不出现', () => {
    expect(summarizeMesh(skeletalMesh())).not.toContain('Morph Target')
  })
})

describe('summarizeMesh —— Socket', () => {
  it('包围盒明确为资产空间并保留厘米尺寸', () => {
    const text = summarizeMesh(staticMesh({ bounds: { size: { x: 100, y: 200, z: 300 } } }))
    expect(text).toContain('asset 资产空间')
    expect(text).toContain('100.0 × 200.0 × 300.0 厘米')
  })
  it('骨骼网格的 Socket 带上挂点骨骼', () => {
    const text = summarizeMesh(skeletalMesh({ sockets: [{ name: 'weapon_r', bone: 'hand_r' }] }))
    expect(text).toContain('weapon_r@hand_r')
  })

  it('静态网格的 Socket 只有名字', () => {
    const text = summarizeMesh(staticMesh({ sockets: [{ name: 'FX_Top' }] }))
    expect(text).toContain('FX_Top')
  })
})

/**
 * 原点在哪。
 *
 * 这一段是 实测反馈的直接对策：拼一套模块化集装箱地堡时，
 * 「原点相对几何体在哪」拿不到，只能先假设居中拼一版，截图发现天花板悬在墙外，
 * 再逐个 focus 反推 —— 而 focus 会把用户的镜头飞走。
 * size 答不了这个问题，min/max 才答得了。
 */
describe('summarizeMesh —— 原点', () => {
  it('原点贴底面：说「Z 贴负端」并给出摆放含义', () => {
    const text = summarizeMesh(
      staticMesh({
        bounds: {
          size: { x: 300, y: 300, z: 400 },
          min: { x: -150, y: -150, z: 0 },
          max: { x: 150, y: 150, z: 400 }
        }
      })
    )

    expect(text).toContain('X 居中')
    expect(text).toContain('Y 居中')
    expect(text).toContain('Z 贴负端（几何体向 +Z 展开）')
    expect(text).toContain('z=0')
  })

  it('原点在角点：三个轴都向正方向展开', () => {
    const text = summarizeMesh(
      staticMesh({
        bounds: {
          size: { x: 400, y: 400, z: 300 },
          min: { x: 0, y: 0, z: 0 },
          max: { x: 400, y: 400, z: 300 }
        }
      })
    )

    expect(text).toContain('X 贴负端（几何体向 +X 展开）')
    expect(text).toContain('Y 贴负端（几何体向 +Y 展开）')
  })

  it('墙这类向 -Y 展开的：说的是「贴正端」，不是居中', () => {
    const text = summarizeMesh(
      staticMesh({
        bounds: {
          size: { x: 400, y: 20, z: 300 },
          min: { x: -200, y: -20, z: 0 },
          max: { x: 200, y: 0, z: 300 }
        }
      })
    )

    expect(text).toContain('Y 贴正端（几何体向 -Y 展开）')
  })

  it('原点整个偏在几何体外面时，照实报两个角点，不硬套三种模式', () => {
    const text = summarizeMesh(
      staticMesh({
        bounds: {
          size: { x: 100, y: 100, z: 100 },
          min: { x: 500, y: -150, z: 0 },
          max: { x: 600, y: -50, z: 100 }
        }
      })
    )

    expect(text).toContain('X 偏移（min 500.0 / max 600.0）')
  })

  it('老插件只回 size 时整段不出现 —— 不猜原点在哪', () => {
    const text = summarizeMesh(staticMesh({ bounds: { size: { x: 240, y: 180, z: 95 } } }))

    expect(text).not.toContain('原点')
    // 尺寸那一行照旧
    expect(text).toContain('asset 资产空间')
  })
})
