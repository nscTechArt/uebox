/**
 * 团队工程的显示规则（界面方案第 2 节组件库）：时间、时长、在线、签出那一行、检查提示、通知文案。
 *
 * 全部是纯函数，传进翻译函数 `t`，不碰 vue-i18n 的实例 —— 这样单测能直接拿中文词表跑，
 * 界面上三处（网格悬停、详情、签出中）说的是同一句话。
 */
import type {
  Person,
  PersonRef,
  TeamCheck,
  TeamNotification,
  TeamSubmit
} from '@core/shared/teamProject'

export type Translate = (key: string, params?: Record<string, unknown>) => string

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 2.5 时间：今天「10:12」；昨天「昨天 17:12」；一周内「周四 17:12」；
 * 更早「9月25日」；不是今年「2025年9月25日」。
 */
export function formatTeamTime(at: number, now: number, t: Translate): string {
  const today = startOfDay(now)
  const d = new Date(at)
  if (at >= today) return hhmm(at)
  if (at >= today - DAY) return t('teamProject.time.yesterday', { time: hhmm(at) })
  if (at >= today - 6 * DAY)
    return t('teamProject.time.weekday', {
      day: t(`teamProject.time.days.${d.getDay()}`),
      time: hhmm(at)
    })
  if (d.getFullYear() === new Date(now).getFullYear())
    return t('teamProject.time.date', { m: d.getMonth() + 1, d: d.getDate() })
  return t('teamProject.time.fullDate', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
}

/** 动态的组标题：「今天」「昨天」「9月22日 周一」 */
export function dayGroupTitle(at: number, now: number, t: Translate): string {
  const today = startOfDay(now)
  if (at >= today) return t('teamProject.activity.today')
  if (at >= today - DAY) return t('teamProject.activity.yesterday')
  const d = new Date(at)
  const date =
    d.getFullYear() === new Date(now).getFullYear()
      ? t('teamProject.time.date', { m: d.getMonth() + 1, d: d.getDate() })
      : t('teamProject.time.fullDate', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
  return `${date} ${t(`teamProject.time.days.${d.getDay()}`)}`
}

export function dayKey(at: number): number {
  return startOfDay(at)
}

/** 2.3 时长只取最大单位：「40 分钟」「2 小时」「3 天」 */
export function formatDuration(ms: number, t: Translate): string {
  const safe = Math.max(0, ms)
  if (safe >= DAY) return t('teamProject.duration.days', { n: Math.floor(safe / DAY) })
  if (safe >= HOUR) return t('teamProject.duration.hours', { n: Math.floor(safe / HOUR) })
  return t('teamProject.duration.minutes', { n: Math.max(1, Math.floor(safe / MINUTE)) })
}

/** 2.3 在线：此刻在线「在线」；今天一次都没上线「今天没上线」；其余不写 */
export function onlineState(
  person: Pick<Person, 'online' | 'lastSeenAt'>,
  now: number
): 'online' | 'notToday' | null {
  if (person.online) return 'online'
  if (person.lastSeenAt === null || person.lastSeenAt < startOfDay(now)) return 'notToday'
  return null
}

/**
 * 2.3 「{人} 已签出（{时长}，{在线状态}）」；自己写「你已签出（3 天）」，不写在线。
 * `withOnline: false` 用在历史、动态（那里不写在线状态）。
 */
export function checkoutLine(
  holder: Pick<Person, 'id' | 'name' | 'online' | 'lastSeenAt'>,
  since: number,
  now: number,
  me: string | null,
  t: Translate,
  withOnline = true
): string {
  const duration = formatDuration(now - since, t)
  if (me && holder.id === me) return t('teamProject.person.youCheckedOut', { duration })
  const state = withOnline ? onlineState(holder, now) : null
  return state
    ? t('teamProject.person.checkedOutState', {
        who: holder.name,
        duration,
        state: t(`teamProject.person.${state}`)
      })
    : t('teamProject.person.checkedOut', { who: holder.name, duration })
}

/** 「签出中」组标题后面那一截：在线 / 今天没上线 / 不写 */
export function personState(person: Person, now: number, t: Translate): string | null {
  const state = onlineState(person, now)
  return state ? t(`teamProject.person.${state}`) : null
}

/** 工程内路径 → 资产名（不带扩展名） */
export function assetNameOf(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.(uasset|umap)$/i, '')
}

/**
 * 从外包的 UE 工程里拖进来的文件 → 工程内路径（「路径保持和参考里一致」）：
 * 从路径里最后一个 Content / Config / Source 段开始算；没有就只用文件名。和主进程同一条规则。
 */
export function projectRelativeOf(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/')
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (['content', 'config', 'source'].includes(parts[index].toLowerCase()))
      return parts.slice(index).join('/')
  }
  return parts[parts.length - 1]
}

/** 路径所在的文件夹（工程内路径） */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash >= 0 ? path.slice(0, slash) : ''
}

/** `__ExternalActors__` 下的 Actor 文件合成「L_North · 东区地形 4 块」这种一行（方案 4.4） */
export function ofpaGroups<T extends { path: string; ofpa: { map: string } | null }>(
  items: T[]
): Array<{ map: string | null; items: T[] }> {
  const out: Array<{ map: string | null; items: T[] }> = []
  const byMap = new Map<string, { map: string; items: T[] }>()
  for (const item of items) {
    if (item.ofpa?.map) {
      let group = byMap.get(item.ofpa.map)
      if (!group) {
        group = { map: item.ofpa.map, items: [] }
        byMap.set(item.ofpa.map, group)
        out.push(group)
      }
      group.items.push(item)
    } else {
      out.push({ map: null, items: [item] })
    }
  }
  return out
}

/** 人名列表：「李娜、王磊」；群组照写名字 */
export function peopleText(people: Array<PersonRef | { group: string }>, sep = '、'): string {
  return people.map((p) => ('group' in p ? p.group : p.name)).join(sep)
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

export function formatSize(bytes: number): string {
  return humanBytes(Math.max(0, bytes))
}

/**
 * 检查结果 → 一句提示（2.12 / 3.8）：「T_Rock_07_D 是 8192，上限 4096（王磊定的）。」
 */
export function checkText(check: TeamCheck, t: Translate): string {
  const name = assetNameOf(check.path)
  const setBy = check.setBy ? t('teamProject.check.setBy', { who: check.setBy.name }) : ''
  switch (check.rule) {
    case 'name-prefix':
      return t('teamProject.check.namePrefix', { name, prefix: String(check.value ?? '') })
    case 'texture-power-of-two':
      return t('teamProject.check.powerOfTwo', { name })
    case 'texture-max-size':
      return t('teamProject.check.maxSize', {
        name,
        value: String(check.value ?? ''),
        max: String((check.params as { max?: number }).max ?? 4096),
        setBy
      })
    case 'no-broken-references': {
      const refs = Array.isArray(check.value) ? (check.value as string[]) : []
      return t('teamProject.check.brokenRefs', {
        refs: refs.map((ref) => ref.split('/').pop()).join(t('teamProject.nameSep'))
      })
    }
    case 'file-max-size':
      return t('teamProject.check.fileSize', {
        name,
        max: formatSize(Number((check.params as { maxBytes?: number }).maxBytes ?? 2 * 1024 ** 3))
      })
    default:
      return name
  }
}

/** 等通过的那一行：「等管理员通过」/「等 李娜、王磊 通过」 */
export function waitingText(submit: Pick<TeamSubmit, 'waitingFor'>, t: Translate): string | null {
  const waiting = submit.waitingFor
  if (!waiting) return null
  if (waiting.kind === 'admins' || waiting.people.length === 0)
    return t('teamProject.card.waitingAdmins')
  return t('teamProject.card.waitingPeople', {
    people: peopleText(waiting.people, t('teamProject.nameSep'))
  })
}

/** 改动计数「新增 3 · 修改 12 · 删除 1」，为 0 的不写 */
export function countsText(
  counts: { added: number; modified: number; deleted: number },
  t: Translate
): string {
  const parts: string[] = []
  if (counts.added) parts.push(t('teamProject.card.added', { n: counts.added }))
  if (counts.modified) parts.push(t('teamProject.card.modified', { n: counts.modified }))
  if (counts.deleted) parts.push(t('teamProject.card.deleted', { n: counts.deleted }))
  return parts.join(' · ')
}

/** 一批路径的简短描述：一个文件写名字；多个写「SK_Hero 等 3 个」 */
export function pathsLabel(paths: string[], t: Translate): string {
  if (paths.length === 0) return ''
  const first = assetNameOf(paths[0])
  return paths.length === 1 ? first : t('teamProject.pathsMore', { name: first, n: paths.length })
}

export interface TrayText {
  body: string
  /** 带一个动作的通知（2.15）：点通知就是做这件事 */
  action?: 'open-inbox' | 'open-submit' | 'open-project' | 'open-activity' | null
}

/**
 * 服务端通知 → 托盘文案（界面方案 4.14、2.16、3.6、3.8、3.12）。
 * 回 null 的不弹（只刷新界面，比如发参考只点红点）。
 */
export function notificationText(notification: TeamNotification, t: Translate): TrayText | null {
  const data = notification.data ?? {}
  const ask = data.ask as
    | {
        from?: PersonRef
        to?: PersonRef
        paths?: string[]
        answer?: { kind?: string; eta?: string | null } | null
      }
    | undefined
  const submit = data.submit as Partial<TeamSubmit> | undefined
  switch (notification.kind) {
    case 'ask.received':
      return {
        body: t('teamProject.notify.askReceived', {
          who: ask?.from?.name ?? '',
          name: pathsLabel(ask?.paths ?? [], t)
        }),
        action: 'open-project'
      }
    case 'ask.answered': {
      const who = ask?.to?.name ?? ''
      const name = pathsLabel(ask?.paths ?? [], t)
      const kind = ask?.answer?.kind
      if (kind === 'submitted') return { body: t('teamProject.notify.askSubmitted', { who, name }) }
      if (kind === 'released') return { body: t('teamProject.notify.askReleased', { who, name }) }
      const eta = ask?.answer?.eta ? t(`teamProject.notify.eta.${ask.answer.eta}`) : ''
      return { body: t('teamProject.notify.askStill', { who, eta }) }
    }
    case 'ask.escalated':
    case 'submit.pending':
    case 'delivery.submitted':
      return { body: t('teamProject.notify.inbox', { n: 1 }), action: 'open-inbox' }
    case 'checkout.taken-back': {
      const by = (data.by as PersonRef | undefined)?.name ?? ''
      const name = pathsLabel((data.paths as string[] | undefined) ?? [], t)
      const reason = typeof data.reason === 'string' ? data.reason.trim() : ''
      return {
        body: reason
          ? t('teamProject.notify.takenBackReason', { who: by, name, reason })
          : t('teamProject.notify.takenBack', { who: by, name })
      }
    }
    case 'checkout.assigned':
      return {
        body: t('teamProject.notify.assigned', {
          name: pathsLabel((data.paths as string[] | undefined) ?? [], t)
        })
      }
    case 'submit.approved':
      return { body: t('teamProject.notify.approved', { n: submit?.number ?? '' }) }
    case 'submit.rejected':
      return {
        body: t('teamProject.notify.rejected', {
          n: submit?.number ?? '',
          who: submit?.rejected?.by?.name ?? '',
          reason: submit?.rejected?.reason ?? ''
        })
      }
    case 'submit.conflict':
      return { body: t('teamProject.notify.conflict', { n: submit?.number ?? '' }) }
    case 'freeze.started': {
      const freeze = data.freeze as { note?: string } | undefined
      return { body: t('teamProject.notify.freezeStarted', { note: freeze?.note ?? '' }) }
    }
    case 'freeze.ended':
      return { body: t('teamProject.notify.freezeEnded') }
    case 'bisect.done': {
      const bisect = data.bisect as
        | { result?: { number?: number }; current?: { author?: PersonRef; message?: string } }
        | undefined
      const n = bisect?.result?.number
      if (typeof n !== 'number') return null
      return { body: t('teamProject.notify.bisectDone', { n }), action: 'open-submit' }
    }
    case 'delivery.decided': {
      const delivery = data.delivery as
        | { n?: number; counts?: { approved?: number; rejected?: number } }
        | undefined
      return {
        body: t('teamProject.notify.deliveryDecided', {
          n: delivery?.n ?? '',
          a: delivery?.counts?.approved ?? 0,
          r: delivery?.counts?.rejected ?? 0
        })
      }
    }
    default:
      return null
  }
}
