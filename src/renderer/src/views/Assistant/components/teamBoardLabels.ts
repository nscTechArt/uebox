/**
 * 「团队任务」面板和办公室共用的人话：工具名翻成动作、队员状态一句话、相对时间。
 *
 * 工具名的译法复用对话里步骤列表那一份（`resolveToolLabel`），两处说同一句话；
 * 那份里没有的工具，按动作大类说一个笼统的（「查看工程内容」），不把 snake_case 端给用户。
 */

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { PRODUCER } from '@core/shared/agentTeam'

import { resolveToolLabel } from './agentStepLabels'
import { toolKind } from './teamOffice/officeActivity'
import { shortTarget, type MemberStatus } from './teamBoardView'

// ── 会自己走的「几分钟前」 ───────────────────────────────────────────────

const now = ref(Date.now())
let users = 0
let timer: ReturnType<typeof setInterval> | null = null

/** 「17 分钟前」要自己往前走：所有用到的组件共用一个每 30 秒走一下的时钟 */
function useNow(): void {
  onMounted(() => {
    users++
    now.value = Date.now()
    timer ??= setInterval(() => (now.value = Date.now()), 30_000)
  })
  onBeforeUnmount(() => {
    users--
    if (users <= 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  })
}

export interface TeamLabels {
  /** 每 30 秒走一下的「现在」。时间轴、「刚交回」这类要跟着时间变的用它 */
  now: Ref<number>
  ago: (at: number) => string
  /** 悬停看的精确时刻 */
  exact: (at: number) => string
  who: (name: string) => string
  toolVerb: (tool: string) => string
  statusText: (status: MemberStatus) => string
}

export function useTeamLabels(): TeamLabels {
  const { t, te } = useI18n()
  useNow()

  const ago = (at: number): string => {
    const minutes = Math.round((now.value - at) / 60_000)
    if (minutes < 1) return t('assistant.teamBoard.ago.justNow')
    if (minutes < 60) return t('assistant.teamBoard.ago.minutes', { n: minutes })
    const hours = Math.round(minutes / 60)
    if (hours < 48) return t('assistant.teamBoard.ago.hours', { n: hours })
    return t('assistant.teamBoard.ago.days', { n: Math.round(hours / 24) })
  }

  const exact = (at: number): string => {
    const d = new Date(at)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const who = (name: string): string =>
    name === PRODUCER ? t('assistant.teamBoard.producer') : name

  const toolVerb = (tool: string): string => {
    const label = resolveToolLabel(tool, t, te)
    const known = label !== tool && label !== t('assistant.agentProcess.unknownTool')
    return known ? label : t(`assistant.teamBoard.kindVerb.${toolKind(tool)}`)
  }

  const statusText = (status: MemberStatus): string => {
    const key = 'assistant.teamBoard.statusLine'
    switch (status.kind) {
      case 'stopped':
        return t(`${key}.stopped`, { reason: status.reason })
      case 'blocked':
        return t(`${key}.blocked`, { reason: status.reason })
      case 'tool': {
        const target = shortTarget(status.target)
        const verb = toolVerb(status.tool)
        return target ? t(`${key}.toolAt`, { verb, target }) : t(`${key}.tool`, { verb })
      }
      case 'delivered':
        return t(`${key}.delivered`, { title: status.title })
      default:
        return t(`${key}.${status.kind}`)
    }
  }

  return { now, ago, exact, who, toolVerb, statusText }
}
