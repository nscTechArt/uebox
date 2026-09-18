/**
 * @vitest-environment node
 *
 * 控件类型不许再被枚举挡住。
 *
 * 这两个工具原来一个只认 12 种、一个只认 4 种，而插件认 24 种具名 + 任意
 * UWidget 子类 —— 滚动列表、输入框、网格布局全都点不到。这里守的就是
 * 「工具不比引擎窄」：加回枚举会让这些用例再次消失，而且是静默消失。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../services', () => ({
  serviceManager: { getWebSocketService: () => ({ getConnectionCount: () => 0 }) }
}))
vi.mock('../../../core/projectTargetContext', () => ({ getTargetConnectionId: () => undefined }))

import { addChildTool } from './addChild'
import { createWidgetTool } from './createWidget'
import { KNOWN_WIDGET_TYPES } from './widgetTypes'

const parse = (schema: unknown, value: Record<string, unknown>): { success: boolean } =>
  (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(value)

describe('control_type / root_type 的开放程度', () => {
  it('插件表里的每一种都通得过 —— 包括原来被枚举挡掉的那些', () => {
    const schema = addChildTool().inputSchema
    for (const type of KNOWN_WIDGET_TYPES) {
      const r = parse(schema, { path: '/Game/UI/WBP_A', parent_name: 'root', control_type: type })
      expect(r.success, `${type} 应该被接受`).toBe(true)
    }
  })

  it('滚动列表和输入框这几个是重灾区，单独盯着', () => {
    const schema = addChildTool().inputSchema
    for (const type of ['ScrollBox', 'EditableTextBox', 'ComboBoxString', 'GridPanel']) {
      expect(
        parse(schema, { path: '/Game/UI/WBP_A', parent_name: 'root', control_type: type }).success
      ).toBe(true)
    }
  })

  it('工程自己写的控件类名也放行 —— 插件会去引擎里动态查', () => {
    const schema = addChildTool().inputSchema
    expect(
      parse(schema, {
        path: '/Game/UI/WBP_A',
        parent_name: 'root',
        control_type: 'MyProjectHealthBar'
      }).success
    ).toBe(true)
  })

  it('空字符串还是要挡 —— 那不是类型名，是漏填', () => {
    const schema = addChildTool().inputSchema
    expect(
      parse(schema, { path: '/Game/UI/WBP_A', parent_name: 'root', control_type: '' }).success
    ).toBe(false)
  })

  it('根控件同样不限于四种容器', () => {
    const schema = createWidgetTool().inputSchema
    for (const type of ['CanvasPanel', 'ScrollBox', 'GridPanel', 'UniformGridPanel']) {
      expect(parse(schema, { name: 'WBP_A', root_type: type }).success).toBe(true)
    }
  })
})
