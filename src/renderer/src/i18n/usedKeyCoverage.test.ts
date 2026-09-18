import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

/**
 * 「代码里用到的 key 必须存在于两侧语言包」守卫。
 *
 * 2026-09 清点时这个缺口积累到了 623 个 key（25 个命名空间）—— vue-i18n
 * 缺 key 不报错，只是把 key 本身渲染给用户，所以一直没被发现，直到用户
 * 截图里出现 `assetFileList.deleteConfirm.title` 这样的弹窗。
 *
 * criticalPathCoverage.test.ts 守的是「两侧一致」（块对齐、占位符对齐），
 * 这里守的是「用与有对齐」：扫描渲染层所有 t('...') / $t('...') 字面量
 * key，逐个到两侧语言包里取值。动态拼接的 key（t(prefix + suffix)）
 * 扫不到，那是它的已知边界，不是不写这个测试的理由。
 */

/** 取嵌套 key，取不到返回 undefined */
function get(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, part) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined,
      obj
    )
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (/\.(vue|ts)$/.test(entry) && !/\.test\.|locales/.test(entry)) yield full
  }
}

/**
 * 「长得像 key」才算 key：小写字母开头的标识符 + 至少一个点。
 *
 * ## 为什么不是剥注释
 *
 * 这里一度写成「先剥掉注释再扫」，为的是躲开注释里**谈论** `t('...')` 写法的文字。
 * 那个做法把门禁扫瞎了：剥块注释的正则不认字符串，而 `ImagePanel.vue` 里有一句
 * 再普通不过的 `accept="image/[星]"` —— 那个「斜杠星」开了一个假注释，一路吃到
 * 下一个「星斜杠」，**246 行连同 21 个真 key 一起消失**。实测 3648 → 3622，
 * 丢 26 个，其中只有 2 个是本来想躲的误报。而「key 总数不得少于 3000」那条兜底
 * 在 3622 上，看不见 26 个的窟窿，也看不见 600 个的。
 *
 * （上面这段话本身不能写出真的「星斜杠」—— 写了就会把这个注释提前关掉，
 * 这正是同一个坑。）
 *
 * 收紧「什么算 key」比改写源码安全得多：本仓库的 key 一律是点分的
 * （`assistant.agentMode.resume`），而那两个误报恰好一个没有字母（`'...'`）、
 * 一个没有点（`'Word'`）。实测 3648 → 3646，排掉的正好是那两个。
 */
const KEY_CALL = /\bt\(\s*'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)'/g

describe('语言包 key 覆盖', () => {
  it('渲染层用到的每个 t()/\\$t() 字面量 key 在两侧语言包都存在', () => {
    const used = new Set<string>()
    const base = join(__dirname, '..')
    for (const file of walk(base)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(KEY_CALL)) used.add(m[1])
    }
    /*
     * 扫描本身失效时（正则失配、walk 走错目录）在这里暴露。
     *
     * 门槛贴着实际值设（当前 3646），不是留一大截余量的 3000 —— 上一版就是因为
     * 门槛离实际差 600，把 26 个 key 扫没了也照样绿。掉到 3600 以下说明有一整片
     * 文件没扫到，那本身就是要查的事。
     */
    expect(used.size).toBeGreaterThan(3600)

    const missZh = [...used].filter((k) => get(zhCN, k) === undefined)
    const missEn = [...used].filter((k) => get(enUS, k) === undefined)
    const report = [
      missZh.length ? `zh-CN 缺 ${missZh.length} 个：\n${missZh.join('\n')}` : '',
      missEn.length ? `en-US 缺 ${missEn.length} 个：\n${missEn.join('\n')}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    expect(report, report).toBe('')
  })
})
