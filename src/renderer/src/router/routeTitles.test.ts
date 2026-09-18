/**
 * 窗口标题必须是 i18n key，不能是字面量。
 *
 * 红灯用例：MiniChat 小窗的 `meta.title` 写着「AI 助手」四个字。而
 * `router/index.ts` 是拿 meta.title 去 `t()` 的 —— 查不到就原样返回，
 * 于是英文用户的小窗标题栏上挂着一句中文。另外两个独立窗口
 * （录屏选区、快速录制）反过来：写死英文，中文用户看到 "Select Region"。
 *
 * 这类错查不出来，因为**代码照常工作**：t() 不报错，标题也显示了，
 * 只是永远不跟着语言变。所以只能靠一道门禁盯着。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import enUS from '@renderer/i18n/locales/en-US'
import zhCN from '@renderer/i18n/locales/zh-CN'

/**
 * 允许写字面量的例外，每一条都要有理由。
 *
 * - 语言门：用户**还没选语言**，此刻 i18n 用的是猜出来的默认值。
 *   翻译它等于用一个他没选过的语言去问他要用哪种语言。
 * - Spotlight：产品名，两种语言下都叫这个。
 */
const LITERAL_ALLOWED = new Set(['Choose your language', 'Spotlight'])

function get(pack: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], pack)
}

/** 从路由源码里抠出所有 `title: '...'`。不 import 路由是为了绕开它那一大堆异步组件 */
function routeTitles(file: string): string[] {
  const source = readFileSync(resolve(file), 'utf8')
  return [...source.matchAll(/^\s*title:\s*'([^']+)'/gm)].map((hit) => hit[1])
}

/** 所有定义路由的文件。新增一个就加进来 —— 漏掉的那个文件就是下一次出错的地方 */
const FILES = [
  'src/renderer/src/router/modules/index.ts',
  'src/renderer/src/router/modules/mainRoutes.ts',
  'src/renderer/src/router/modules/systemRoutes.ts'
]

describe('路由标题', () => {
  it('每个标题要么是两侧都配好的 i18n key，要么在白名单里', () => {
    const offenders: string[] = []
    for (const file of FILES) {
      for (const title of routeTitles(file)) {
        if (LITERAL_ALLOWED.has(title)) continue
        const zh = get(zhCN, title)
        const en = get(enUS, title)
        if (typeof zh !== 'string' || typeof en !== 'string') {
          offenders.push(`${file}: ${title}`)
        }
      }
    }
    expect(offenders.join('\n'), offenders.join('\n')).toBe('')
  })

  it('白名单本身不许长 —— 每加一条都要在这里写清理由', () => {
    expect(LITERAL_ALLOWED.size).toBeLessThanOrEqual(2)
  })
})
