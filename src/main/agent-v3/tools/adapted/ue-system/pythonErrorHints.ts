/**
 * Python 报错的补充指引。
 *
 * UE 的 `Cannot nativize 'X' as 'Y'` 只说转换失败，不说该传什么；「allowed Class type: 'Factory'」
 * 还会把人往「传类」的方向带（真机上 create_asset 传 Factory 类，实际要传实例）。
 * 每个这样的报错固定多赔 1-2 次往返，这里按报错文本认出常见几种，把可行动的写法补在后面。
 */

const NATIVIZE = /Cannot nativize '([^']+)' as '([^']+)'/g

/** 「传了 A 类型，引擎要 B 类型」的常见错配，按 (收到, 目标属性) 给可行动写法 */
function hintFor(received: string, target: string, text: string): string | null {
  // Factory 要实例：报错里目标类型是 Factory 且收到的是 XxxFactory 类
  if (
    /Factory/.test(received) &&
    (target === 'Factory' || /allowed Class type: 'Factory'/.test(text))
  ) {
    return `${received} 是类，create_asset / import 的 factory 参数要传**实例**：unreal.${received}()`
  }
  if (received === 'LinearColor') {
    return '该属性要 unreal.Color(r, g, b, a)（FColor，0-255 整数），不是 LinearColor（0-1 浮点）；反过来同理'
  }
  if (received === 'Color') {
    return '该属性要 unreal.LinearColor(r, g, b, a)（0-1 浮点），不是 Color（0-255 整数）'
  }
  return null
}

/**
 * 从 Python 报错文本里提取补充指引；认不出就返回空串。
 * 另外：create_asset 返回 None（重名，引擎拒绝覆写）的 AttributeError 也在这里认。
 *
 * @param script 脚本原文。`<ua-script>` 的回溯不带源码行，报错里只有
 *   `'NoneType' object has no attribute 'set_display_rate'`，看不到 create_asset ——
 *   只看报错的话这条提示在真机上一次都没触发过（2026-10-11）
 */
export function describePythonErrorHints(errorText: string | undefined, script?: string): string {
  if (!errorText) return ''
  const hints = new Set<string>()
  for (const m of errorText.matchAll(NATIVIZE)) {
    const hint = hintFor(m[1], m[2], errorText)
    if (hint) hints.add(hint)
  }
  if (
    /'NoneType' object has no attribute/.test(errorText) &&
    /create_asset/.test(`${errorText}\n${script ?? ''}`)
  ) {
    hints.add(
      'create_asset 返回 None：多半是同名资产已存在，引擎拒绝覆写（正被关卡或 Sequencer 引用时也删不掉）。' +
        '创建前先 unreal.EditorAssetLibrary.does_asset_exist(path)，已存在就 load_asset 接着改，' +
        '不要重试同名创建'
    )
  }
  if (hints.size === 0) return ''
  return '\n提示：\n- ' + [...hints].join('\n- ')
}

/**
 * 脚本跑的时候引擎替它答掉的弹窗。
 *
 * 插件跑脚本时开着无人值守，框不再卡住编辑器，而是直接取默认答案 —— 覆写已有资产
 * 答「否」。脚本拿到的只是一个 None，引擎问了什么、答了什么只有这几行说得清。
 * 成功的脚本也要带上：脚本可能把 None 吞掉了照样跑完。
 */
export function describeAutoAnsweredDialogs(dialogs: string[] | undefined): string {
  if (!dialogs || dialogs.length === 0) return ''
  return (
    '\n引擎弹出过以下对话框，已按默认答案自动关闭（对应操作多半没做成，先回读确认）：\n- ' +
    dialogs.join('\n- ')
  )
}
