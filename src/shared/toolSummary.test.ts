import { describe, expect, it } from 'vitest'
import { toolSummary } from './toolSummary'

describe('工具说明压成一句话', () => {
  it('只取第一句，后面讲怎么用的全丢掉', () => {
    expect(
      toolSummary(
        '为已存在的蓝图资产添加新的组件。【功能说明】： - 向指定蓝图添加新组件 - 支持设置组件的变换（位置、旋转、缩放）'
      )
    ).toBe('为已存在的蓝图资产添加新的组件')
  })

  it('英文说明同样只取第一句', () => {
    expect(
      toolSummary(
        'Compile a Blueprint and optionally save it. Use this after meaningful Blueprint graph changes.'
      )
    ).toBe('Compile a Blueprint and optionally save it')
  })

  it('小数点和工具名里的点不当句末', () => {
    expect(toolSummary('把强度调到 0.3 再看一眼。后面还有话')).toBe('把强度调到 0.3 再看一眼')
  })

  it('Markdown 只是给模型的排版，界面上不显示星号和反引号', () => {
    expect(toolSummary('这是**唯一一个**的蓝图写图工具，用 `blueprint_apply_graph`。')).toBe(
      '这是唯一一个的蓝图写图工具，用 blueprint_apply_graph'
    )
  })

  it('以【功能说明】这种小标题开头时跳过它', () => {
    expect(toolSummary('【功能说明】：删掉一个节点。别的话')).toBe('删掉一个节点')
  })

  it('第一句还是太长就截断，界面只有一行', () => {
    expect(toolSummary('一'.repeat(80))).toBe(`${'一'.repeat(47)}…`)
  })

  it('取不到就返回空串 —— 编一句比不写更糟', () => {
    expect(toolSummary('')).toBe('')
    expect(toolSummary('\n\n')).toBe('')
  })

  it('没有句末标记就用整行', () => {
    expect(toolSummary('列出当前工程里的所有关卡')).toBe('列出当前工程里的所有关卡')
  })
})
