/**
 * 团队工程的文案门禁（界面方案 0.4「禁用词」只有这一张表）：
 * 盒子里团队相关的界面不出现版本控制术语、旧说法和运维词。IT 的网页后台不在这里。
 *
 * 另外钉住中英两份词表的团队段同形 —— 缺一个 key，英文界面就会露出 key 本身。
 */
import { describe, expect, it } from 'vitest'
import zhCN from '@renderer/i18n/locales/zh-CN'
import enUS from '@renderer/i18n/locales/en-US'

/** 方案 0.4 的禁用词（大小写不敏感）；「锁」只禁作名词和「上锁」，这里全禁 —— 团队界面里本来就不该有锁 */
const BANNED = [
  'workspace',
  '工作区',
  '工作副本',
  'stream',
  '流',
  'changelist',
  '变更列表',
  'depot',
  '仓库',
  'shelve',
  '搁置',
  'reconcile',
  'resolve',
  'mine',
  'theirs',
  'rebase',
  'cherry-pick',
  '克隆',
  '推送',
  '拉取',
  '哈希',
  'hash',
  'revision',
  '修订',
  '锁',
  '上锁',
  '签入',
  '服务器',
  '地址',
  '端口',
  '证书',
  '令牌',
  '密钥',
  'Lore'
]

function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]]
  if (!node || typeof node !== 'object') return []
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    leaves(value, prefix ? `${prefix}.${key}` : key)
  )
}

describe('team copy', () => {
  const zh = leaves((zhCN as unknown as Record<string, unknown>).teamProject, 'teamProject')
  const en = leaves((enUS as unknown as Record<string, unknown>).teamProject, 'teamProject')

  it('uses none of the banned words', () => {
    const hits: string[] = []
    for (const [key, text] of zh) {
      for (const word of BANNED) {
        if (text.toLowerCase().includes(word.toLowerCase()))
          hits.push(`${key}: 「${word}」 in 「${text}」`)
      }
      // 「IP」按词匹配（不误伤别的英文词）
      if (/\bIP\b/.test(text)) hits.push(`${key}: 「IP」 in 「${text}」`)
    }
    expect(hits).toEqual([])
  })

  it('the switcher badge and states for team libraries use employee words too', () => {
    const catalog = (zhCN as unknown as { catalogLibrary: { switcher: Record<string, unknown> } })
      .catalogLibrary.switcher
    expect(catalog.badge).toBe('团队')
    expect((catalog.state as Record<string, string>).offline).toBe('无法连接团队')
  })

  it('has the same keys in both languages', () => {
    expect(en.map(([key]) => key).sort()).toEqual(zh.map(([key]) => key).sort())
  })

  it('keeps the design’s exact wording for the words people learn', () => {
    const get = (key: string): string | undefined => zh.find(([k]) => k === key)?.[1]
    expect(get('teamProject.shortcuts.activity')).toBe('动态')
    expect(get('teamProject.shortcuts.checkouts')).toBe('签出中')
    expect(get('teamProject.shortcuts.inbox')).toBe('等你处理')
    expect(get('teamProject.history.title')).toBe('历史')
    expect(get('teamProject.banner.notLocal')).toBe('这个工程还不在你电脑上。')
    expect(get('teamProject.join.cardTitle')).toBe('加入团队')
    expect(get('teamProject.folder.whoCanSubmit')).toBe('谁能提交')
    expect(get('teamProject.compare.bisect')).toBe('找出是哪次提交弄坏的')
  })
})
