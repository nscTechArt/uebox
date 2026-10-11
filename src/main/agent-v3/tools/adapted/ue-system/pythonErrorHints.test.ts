import { describe, expect, it } from 'vitest'
import { describeAutoAnsweredDialogs, describePythonErrorHints } from './pythonErrorHints'

describe('describeAutoAnsweredDialogs', () => {
  it('把自动答掉的弹窗原样列给模型', () => {
    const text = describeAutoAnsweredDialogs([
      'result: No, title: 消息, text: An object [SQ_Chase] of class [LevelSequence] already exists'
    ])
    expect(text).toContain('自动关闭')
    expect(text).toContain('SQ_Chase')
  })

  it('没有弹窗不加任何东西', () => {
    expect(describeAutoAnsweredDialogs(undefined)).toBe('')
    expect(describeAutoAnsweredDialogs([])).toBe('')
  })
})

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

  it('回溯不带源码行时，看脚本里有没有 create_asset', () => {
    const err =
      'File "<ua-script>", line 81, in <module>\n' +
      "AttributeError: 'NoneType' object has no attribute 'set_display_rate'"
    expect(describePythonErrorHints(err)).toBe('')
    expect(
      describePythonErrorHints(
        err,
        "seq = at.create_asset('SQ_Chase', '/Game/Cinematics', None, f)"
      )
    ).toContain('load_asset')
  })

  it('认不出的报错不加任何东西', () => {
    expect(describePythonErrorHints('NameError: x')).toBe('')
    expect(describePythonErrorHints(undefined)).toBe('')
  })
})
