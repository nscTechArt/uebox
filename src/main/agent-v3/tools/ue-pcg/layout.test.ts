import { describe, expect, it } from 'vitest'

import { layoutPcgNodes } from './layout'

/**
 * 排版「跑通了」和「排对了」是两回事：ELK 永远会返回一组坐标，
 * 哪怕方向是反的、哪怕全叠在一起。所以这里断言的是**几何关系**。
 */
describe('layoutPcgNodes', () => {
  const ORIGIN = { x: 0, y: 0 }

  it('上游排在下游左边 —— PCG 图从左往右读', async () => {
    const positions = await layoutPcgNodes(
      [
        { node_id: 'Input', output_pins: ['Out'] },
        { node_id: 'Sampler', input_pins: ['In'], output_pins: ['Out'] },
        { node_id: 'Output', input_pins: ['In'] }
      ],
      [
        { from_node: 'Input', to_node: 'Sampler' },
        { from_node: 'Sampler', to_node: 'Output' }
      ],
      'Input',
      ORIGIN
    )

    const byId = new Map(positions.map((p) => [p.node_id, p]))
    expect(byId.get('Input')!.x).toBeLessThan(byId.get('Sampler')!.x)
    expect(byId.get('Sampler')!.x).toBeLessThan(byId.get('Output')!.x)
  })

  it('锚点排完钉回原位，整张图跟着平移', async () => {
    const anchor = { x: -800, y: 1500 }
    const positions = await layoutPcgNodes(
      [
        { node_id: 'Input', output_pins: ['Out'] },
        { node_id: 'Spawner', input_pins: ['In'] }
      ],
      [{ from_node: 'Input', to_node: 'Spawner' }],
      'Input',
      anchor
    )

    const input = positions.find((p) => p.node_id === 'Input')!
    // 不钉回原位的话整张图会跳到别处，用户还得自己找回来
    expect(input.x).toBe(anchor.x)
    expect(input.y).toBe(anchor.y)
  })

  it('同一层的节点不重叠', async () => {
    const positions = await layoutPcgNodes(
      [{ node_id: 'Input' }, { node_id: 'a' }, { node_id: 'b' }, { node_id: 'c' }],
      [
        { from_node: 'Input', to_node: 'a' },
        { from_node: 'Input', to_node: 'b' },
        { from_node: 'Input', to_node: 'c' }
      ],
      'Input',
      ORIGIN
    )

    const seen = new Set(positions.map((p) => `${p.x},${p.y}`))
    expect(seen.size).toBe(positions.length)
  })

  it('指向图外节点的连线被丢掉，而不是让 ELK 抛异常', async () => {
    const positions = await layoutPcgNodes(
      [{ node_id: 'a' }],
      [{ from_node: 'a', to_node: 'ghost' }],
      'a',
      ORIGIN
    )

    expect(positions).toHaveLength(1)
    expect(positions[0].node_id).toBe('a')
  })

  it('引脚多的节点被排得更高，避免压到下面的节点', async () => {
    const positions = await layoutPcgNodes(
      [
        { node_id: 'Input', output_pins: ['Out'] },
        { node_id: 'many', input_pins: ['A', 'B', 'C', 'D', 'E', 'F'] },
        { node_id: 'few', input_pins: ['In'] }
      ],
      [
        { from_node: 'Input', to_node: 'many' },
        { from_node: 'Input', to_node: 'few' }
      ],
      'Input',
      ORIGIN
    )

    const byId = new Map(positions.map((p) => [p.node_id, p]))
    // 高节点占的纵向空间更大，两个同层节点的间距必须超过默认节点高度
    const gap = Math.abs(byId.get('many')!.y - byId.get('few')!.y)
    expect(gap).toBeGreaterThan(90)
  })

  it('空图直接返回空数组', async () => {
    expect(await layoutPcgNodes([], [], 'Input', ORIGIN)).toEqual([])
  })

  it('锚点不在图里也不失败，只是不做平移', async () => {
    const positions = await layoutPcgNodes([{ node_id: 'a' }], [], 'nope', { x: 500, y: 500 })

    // 排出来仍然是对的，比直接失败强
    expect(positions).toHaveLength(1)
    expect(Number.isFinite(positions[0].x)).toBe(true)
  })
})
