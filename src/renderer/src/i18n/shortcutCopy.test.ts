/**
 * 每个内置快捷键在两侧语言包里都要有名字。
 *
 * 红灯用例：把界面切成 English，打开设置 → 快捷键，表里孤零零一行中文
 * 「进入截图模式」—— 其余四行都是英文。
 *
 * 根因不在渲染层：那边写得是对的（查 `profile.shortcuts.action.<action_key>`，
 * 查不到才退回数据库里的 `description`）。是语言包漏了
 * `app.screenshot_mode` 这一条，于是那一行掉进了兜底，而兜底是中文。
 *
 * 这类漏配查不出来，因为**界面照常显示**：不报错、不空白，只是那一行永远
 * 不跟着语言变。所以只能靠一道门禁盯着。
 *
 * 放在渲染层而不是 `main/sqliteDataBase/models/` 旁边：语言包属于这一侧，
 * 从 main 那边 import 它会撞上 tsconfig 的工程边界（TS6307）。默认行那份源码
 * 是按路径读的，放哪边都一样。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import enUS from './locales/en-US'
import zhCN from './locales/zh-CN'

/**
 * 从 `shortcut.ts` 源码里抠出内置的 action_key。
 *
 * 不 import 那个模块：它一进来就要 better-sqlite3，而这条用例跟数据库无关。
 */
function builtinActionKeys(): string[] {
  const source = readFileSync(resolve('src/main/sqliteDataBase/models/shortcut.ts'), 'utf8')
  return [...source.matchAll(/action_key:\s*'([^']+)'/g)].map((hit) => hit[1])
}

function get(pack: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], pack)
}

describe('内置快捷键的文案', () => {
  it('至少认出那几条内置快捷键（正则失配时在这里暴露）', () => {
    expect(builtinActionKeys().length).toBeGreaterThanOrEqual(5)
  })

  it('每个 action_key 在中英两侧都有名字', () => {
    const missing: string[] = []
    for (const key of builtinActionKeys()) {
      const path = `profile.shortcuts.action.${key}`
      if (typeof get(zhCN, path) !== 'string') missing.push(`zh-CN ${path}`)
      if (typeof get(enUS, path) !== 'string') missing.push(`en-US ${path}`)
    }
    expect(missing.join('\n'), missing.join('\n')).toBe('')
  })

  /*
   * 数据库里的 `description` 是兜底，不是显示文案 —— 它会落进库、之后不再更新，
   * 翻它等于把首次启动时的语言永久冻在库里。上面那条过了，这里就永远走不到。
   */
  it('英文包里这几条不许混中文', () => {
    const chinese = builtinActionKeys().filter((key) => {
      const value = get(enUS, `profile.shortcuts.action.${key}`)
      return typeof value === 'string' && /[一-鿿]/.test(value)
    })
    expect(chinese).toEqual([])
  })
})
