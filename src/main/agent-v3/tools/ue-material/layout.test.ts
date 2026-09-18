import { describe, expect, it } from 'vitest'

import { layoutMaterialNodes } from './layout'

/**
 * 排版这件事「跑通了」和「排对了」是两回事：ELK 永远会返回一组坐标，
 * 哪怕方向是反的、哪怕全叠在一起。所以这里断言的是**几何关系**，
 * 不是「有没有抛异常」。
 */
describe('layoutMaterialNodes', () => {
  const ROOT = { x: 0, y: 0 }

  it('数据流上游排在下游左边 —— 材质图从右往左读', async () => {
    const positions = await layoutMaterialNodes(
      [
        { node_id: 'tex', class: 'MaterialExpressionTextureSample' },
        { node_id: 'mul', class: 'MaterialExpressionMultiply' }
      ],
      [
        { from_node: 'tex', to_node: 'mul' },
        { from_node: 'mul', to_node: 'Material' }
      ],
      ROOT
    )

    const byId = new Map(positions.map((p) => [p.node_id, p]))
    // tex → mul → Material，所以 x 必须依次增大，主节点在最右
    expect(byId.get('tex')!.x).toBeLessThan(byId.get('mul')!.x)
    expect(byId.get('mul')!.x).toBeLessThan(ROOT.x)
  })

  it('主节点原地不动，表达式全排到它左边', async () => {
    const anchor = { x: 1200, y: -340 }
    const positions = await layoutMaterialNodes(
      [{ node_id: 'c', class: 'MaterialExpressionConstant3Vector' }],
      [{ from_node: 'c', to_node: 'Material' }],
      anchor
    )

    // 锚点跟着主节点走 —— 不做平移的话整张图会跳到别处，用户还得自己找回来
    expect(positions[0].x).toBeLessThan(anchor.x)
    expect(Math.abs(positions[0].y - anchor.y)).toBeLessThan(500)
  })

  it('同一层的节点不重叠', async () => {
    const positions = await layoutMaterialNodes(
      [
        { node_id: 'a', class: 'MaterialExpressionConstant' },
        { node_id: 'b', class: 'MaterialExpressionConstant' },
        { node_id: 'c', class: 'MaterialExpressionConstant' }
      ],
      [
        { from_node: 'a', to_node: 'Material' },
        { from_node: 'b', to_node: 'Material' },
        { from_node: 'c', to_node: 'Material' }
      ],
      ROOT
    )

    const seen = new Set(positions.map((p) => `${p.x},${p.y}`))
    expect(seen.size).toBe(3)
  })

  it('指向图外的连线不会让整个排版炸掉', async () => {
    // get_graph 和 set_node_positions 之间图被改过时会出现这种情况。
    // ELK 遇到未知端点会直接抛 —— 过滤掉比让整个工具失败强
    const positions = await layoutMaterialNodes(
      [{ node_id: 'a', class: 'MaterialExpressionConstant' }],
      [
        { from_node: 'a', to_node: 'Material' },
        { from_node: 'ghost', to_node: 'Material' }
      ],
      ROOT
    )
    expect(positions).toHaveLength(1)
  })

  it('空图直接返回空，不去调 ELK', async () => {
    expect(await layoutMaterialNodes([], [], ROOT)).toEqual([])
  })
})
