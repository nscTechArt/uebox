import { describe, expect, it } from 'vitest'
import { describePythonErrorHints } from './pythonErrorHints'

describe('describePythonErrorHints', () => {
  it('Factory 传了类 —— 提示传实例', () => {
    const err =
      "TypeError: NativizeProperty: Cannot nativize 'LevelSequenceFactoryNew' as 'Factory' (ObjectProperty)\n" +
      "TypeError: NativizeObject: Cannot nativize 'LevelSequenceFactoryNew' as 'Object' (allowed Class type: 'Factory')"
    expect(describePythonErrorHints(err)).toContain('unreal.LevelSequenceFactoryNew()')
  })

  it('LinearColor 被拒 —— 提示改 unreal.Color', () => {
    const err = "Cannot nativize 'LinearColor' as 'LightColor' (StructProperty)"
    expect(describePythonErrorHints(err)).toContain('unreal.Color')
  })

  it('create_asset 返回 None 的 AttributeError —— 点明覆写框', () => {
    const err =
      "at.create_asset('SQ', '/Game/C', unreal.LevelSequence, f)\nAttributeError: 'NoneType' object has no attribute 'set_display_rate'"
    expect(describePythonErrorHints(err)).toContain('does_asset_exist')
  })

  it('认不出的报错不加任何东西', () => {
    expect(describePythonErrorHints('NameError: x')).toBe('')
    expect(describePythonErrorHints(undefined)).toBe('')
  })
})
