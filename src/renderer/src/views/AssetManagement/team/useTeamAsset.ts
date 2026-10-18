/**
 * 团队工程里一个资产（按工程内路径）的那几件事：谁签出了、最后谁改的、问他改完没、收回、发给外包。
 *
 * 网格（悬停两行、右键菜单）、详情的「历史」段、签出中都走这里，说的是同一句话、做的是同一件事
 * （方案 2.2、2.16、4.5）。组件里不写团队的判断，只调这里。
 */
import type { PersonRef, TeamHistory } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import i18n from '@renderer/i18n'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { message } from '@renderer/utils/messageManager'
import type { MenuItem } from '@renderer/components/ContextMenu'
import { reactive } from 'vue'
import { checkoutLine, formatDuration, formatTeamTime, type Translate } from './teamFormat'
import { openTeamDialog } from './teamDialogs'

const t = ((key: string, params?: Record<string, unknown>) =>
  i18n.global.t(key, params ?? {})) as Translate

/** 最后一次改动（「小王 · 昨天 18:20 改过」），按库、按路径缓存；悬停时才去取 */
const lastChange = reactive(new Map<string, { author: PersonRef; at: number } | null>())
const loading = new Set<string>()

/** 30 分钟内问过的（「已问过（10 分钟前）」）：UE 和盒子共用服务端的状态，这里只是本页的缓存 */
const askedAt = reactive(new Map<string, { at: number; askId: string }>())

export function pathOfFile(file: unknown): string | null {
  const row = file as { catalogPath?: unknown; path?: unknown } | null
  if (!row) return null
  if (typeof row.catalogPath === 'string') return row.catalogPath
  return null
}

export interface TeamAssetActions {
  prefetch(path: string | null): Promise<void>
  cardTitle(base: string, path: string | null): string
  askedLabel(path: string): string | null
  askIdOf(path: string): string | null
  refreshAsked(paths: string[]): Promise<void>
  ask(paths: string[]): Promise<void>
  escalate(path: string): Promise<void>
  takeBack(paths: string[]): Promise<void>
  menuItems(path: string | null): MenuItem[]
  handleMenu(key: string, paths: string[]): Promise<boolean>
}

export function useTeamAsset(): TeamAssetActions {
  const teamStore = useTeamStore()

  function cacheKey(path: string): string {
    return `${teamStore.key ?? ''}|${path}`
  }

  async function prefetch(path: string | null): Promise<void> {
    const key = teamStore.key
    if (!key || !path || teamStore.isOutsourcer) return
    const id = cacheKey(path)
    if (lastChange.has(id) || loading.has(id)) return
    loading.add(id)
    try {
      const history: TeamHistory | null = await teamAPI.history(key, path).catch(() => null)
      const first = history?.items[0]
      lastChange.set(id, first ? { author: first.author, at: first.at } : null)
    } finally {
      loading.delete(id)
    }
  }

  /** 网格悬停：在现有内容后追加两行（方案 4.5） */
  function cardTitle(base: string, path: string | null): string {
    if (!path || !teamStore.isTeam) return base
    const now = Date.now()
    const lines = [base]
    const change = lastChange.get(cacheKey(path))
    if (change)
      lines.push(
        t('teamProject.grid.edited', {
          who: change.author.name,
          time: formatTeamTime(change.at, now, t)
        })
      )
    const checkout = teamStore.checkoutOf(path)
    if (checkout) lines.push(checkoutLine(checkout.holder, checkout.since, now, teamStore.me, t))
    return lines.join('\n')
  }

  function askedLabel(path: string): string | null {
    const asked = askedAt.get(cacheKey(path))
    if (!asked || Date.now() - asked.at > 30 * 60_000) return null
    return t('teamProject.ask.askedRecently', { ago: formatDuration(Date.now() - asked.at, t) })
  }

  function askIdOf(path: string): string | null {
    return askedAt.get(cacheKey(path))?.askId ?? null
  }

  async function refreshAsked(paths: string[]): Promise<void> {
    const key = teamStore.key
    if (!key || paths.length === 0) return
    const result = await teamAPI.asked(key, paths).catch(() => null)
    for (const item of result?.items ?? [])
      askedAt.set(cacheKey(item.path), { at: item.askedAt, askId: item.ask.id })
  }

  /** 问他改完没（方案 2.16）：在线「他回了会告诉你」；今天没上线「他今天没上线」 */
  async function ask(paths: string[]): Promise<void> {
    const key = teamStore.key
    const first = paths[0]
    const holder = first ? teamStore.checkoutOf(first)?.holder : null
    if (!key || !holder) return
    const result = await teamAPI.ask(key, paths)
    if (!result.success) {
      if (result.errorCode === 'asked-recently') {
        await refreshAsked(paths)
        message.info(askedLabel(first) ?? t('teamProject.ask.askedRecently', { ago: '' }))
      } else message.error(t('teamProject.dialogs.failed'))
      return
    }
    for (const path of paths)
      askedAt.set(cacheKey(path), { at: Date.now(), askId: result.data?.ask.id ?? '' })
    message.success(
      result.data?.holderOnline
        ? t('teamProject.ask.askedOnline', { who: holder.name })
        : t('teamProject.ask.askedOffline', { who: holder.name })
    )
  }

  /** 请管理员收回（2 小时没回，或他今天没上线） */
  async function escalate(path: string): Promise<void> {
    const key = teamStore.key
    const askId = askIdOf(path)
    if (!key || !askId) return
    const result = await teamAPI.escalate(key, askId)
    if (!result.success) {
      message.error(t('teamProject.dialogs.failed'))
      return
    }
    const admins = (result.data?.ask.escalated?.admins ?? [])
      .map((a) => a.name)
      .join(t('teamProject.nameSep'))
    message.success(t('teamProject.ask.escalated', { admins }))
  }

  async function takeBack(paths: string[]): Promise<void> {
    const holder = paths[0] ? teamStore.checkoutOf(paths[0])?.holder : null
    if (!holder) return
    await openTeamDialog({
      kind: 'takeBack',
      holder: { id: holder.id, name: holder.name },
      paths,
      count: paths.length
    })
  }

  /** 网格右键按需加的三项（方案 4.5） */
  function menuItems(path: string | null): MenuItem[] {
    if (!path || !teamStore.isTeam || teamStore.isOutsourcer) return []
    const items: MenuItem[] = []
    const checkout = teamStore.checkoutOf(path)
    if (checkout && checkout.holder.id !== teamStore.me) {
      const asked = askedLabel(path)
      items.push({
        key: 'team-ask',
        label: asked ?? t('teamProject.history.askDone'),
        disabled: Boolean(asked)
      })
      if (teamStore.isAdmin)
        items.push({ key: 'team-take-back', label: t('teamProject.history.takeBack') })
    }
    for (const company of teamStore.outsourceCompanies)
      items.push({
        key: `team-send:${company.id}`,
        label: `${t('teamProject.outsource.sendTo')} ▸ ${company.name}`
      })
    if (items.length > 0) items.unshift({ key: 'team-divider', type: 'divider' })
    return items
  }

  /** 处理了就回 true */
  async function handleMenu(key: string, paths: string[]): Promise<boolean> {
    if (key === 'team-ask') {
      await ask(paths)
      return true
    }
    if (key === 'team-take-back') {
      await takeBack(paths)
      return true
    }
    if (key.startsWith('team-send:')) {
      const company = teamStore.outsourceCompanies.find((c) => c.id === key.slice(10))
      if (company)
        await openTeamDialog({
          kind: 'sendReference',
          company: { id: company.id, name: company.name },
          paths
        })
      return true
    }
    return false
  }

  return {
    prefetch,
    cardTitle,
    askedLabel,
    askIdOf,
    refreshAsked,
    ask,
    escalate,
    takeBack,
    menuItems,
    handleMenu
  }
}
