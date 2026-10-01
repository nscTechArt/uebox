/**
 * 执行前提醒：上帝工具的脚本在跑之前就看得见，里面用了已验证的错误写法就先拦一次。
 *
 * ## 为什么值得
 *
 * 报错后再挂经验，是事后补救；而研究显示正确的经验摆在眼前，模型也只有一半时候照做。
 * Python 脚本、控制台命令的全文在执行前就在参数里 —— 用了 `.is_hidden` 这种在本版本
 * 已经确认不存在的写法，没必要真跑一遍、等引擎报错、再绕回来。
 *
 * ## 为什么只拦一次
 *
 * 规则是死的，场景是活的：`.is_hidden` 在 Character 上不存在，换个类也许就有。
 * 拦下时说清楚「确定没问题就原样再发一次」，同一段脚本第二次发来直接放行。
 * 放行后真跑成功了，说明这次拦错了 —— 那条经验从已验证降回试用，不再拦（`runtime.ts`）。
 *
 * ## 只用已验证的
 *
 * 试用中的经验还没证明自己，拿它拦路的代价比挂在报错后面大得多。
 */

import { createHash } from 'crypto'

import type { LayeredEntry } from './recall'

/** 一段脚本 / 命令的指纹，用来认「同一段又发了一次」 */
export function codeDigest(code: string): string {
  return createHash('sha1').update(code).digest('hex').slice(0, 16)
}

/** 上帝工具参数里那段代码。没有（比如跑的是 skill 自带脚本）回 undefined */
export function codeOf(tool: string, args: unknown): string | undefined {
  const a = args as { script?: unknown; command?: unknown } | undefined
  if (tool === 'ue_run_python_script' && typeof a?.script === 'string') return a.script
  if (tool === 'ue_run_console_command' && typeof a?.command === 'string') return a.command
  return undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 错误写法 → 在代码里找它的正则。
 *
 * 结尾补单词边界：`.is_hidden` 不能命中 `.is_hidden_ed()`。不分大小写：报错归一化成了
 * 小写，从报错推出来的写法也是小写，而脚本里写的是 `unreal.LevelEditorPlaySettings`。
 */
export function avoidPattern(avoid: string): RegExp {
  const tail = /\w$/.test(avoid) ? '\\b' : ''
  return new RegExp(`${escapeRegExp(avoid)}${tail}`, 'i')
}

/** 代码里用到了哪些已验证的错误写法 */
export function findAvoided(
  code: string,
  entries: LayeredEntry[],
  engine: string | undefined
): LayeredEntry[] {
  return entries.filter(
    (entry) =>
      entry.status === 'proven' &&
      !!entry.avoid &&
      !(engine && entry.notFor?.includes(engine)) &&
      avoidPattern(entry.avoid).test(code)
  )
}

/** 拦下时交给模型的那段话。写成对模型的指示：怎么改、以及确定没问题时怎么放行 */
export function formatPrecheck(entries: LayeredEntry[], engine: string | undefined): string {
  const lines = entries.map((entry) => {
    const versions = entry.engines?.length ? entry.engines.join(', ') : entry.verified?.engine
    return (
      `- \`${entry.avoid}\`: ${entry.advice}` +
      ` (it failed before with "${entry.errorPattern}"${versions ? ` on UE ${versions}` : ''})`
    )
  })
  return (
    '[Experience check — not executed] This code uses something that is known to fail' +
    (engine ? ` on UE ${engine}` : '') +
    ':\n' +
    lines.join('\n') +
    '\nFix it and send again. If you are sure it is fine here, send the exact same code again and it will run.'
  )
}
