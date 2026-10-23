import { computed, reactive, watch, type ComputedRef, type Ref } from 'vue'

/** 团队日志里点开的一份交付，在右侧面板占一个页签 */
export interface TeamReportTab {
  /** 活的 id */
  id: string
  title: string
}

interface TeamTabState {
  /** 「团队任务」页签开着 */
  board: boolean
  reports: TeamReportTab[]
  /** 团队这几个页签在面板最前面 */
  active: boolean
  /** 前面的是哪份交付；null 是团队任务本身 */
  current: string | null
}

/**
 * 右侧面板里的「团队任务」页签，以及从它的日志里点开的交付页签，按对话各记各的。
 *
 * 面板里还有审查和网页两类页签，谁在前面这样定：
 *   - 用户点了团队任务（摘要行或页签）或一份交付，它就在前面，直到用户点别的页签；
 *   - 新打开一次审查（点了「查看改动」）是用户刚做的动作，让审查到前面；
 *   - 没人被点过时，只剩团队这几个页签就显示它们。
 *
 * 状态放在模块里而不是组件里：页面按完整地址缓存，切走再切回来（地址带的参数
 * 不完全一样）会拿到一个新的页面实例，记在组件里的话页签就自己没了。
 */
const sessions = reactive(new Map<string, TeamTabState>())

export function useTeamTab(
  sid: Readonly<Ref<string>>,
  hasTeam: Readonly<Ref<boolean>>,
  review: Readonly<Ref<object | undefined>>,
  browserOpen: Readonly<Ref<boolean>>
): {
  /** 「团队任务」页签开着 */
  open: ComputedRef<boolean>
  /** 「团队任务」页签在前面 */
  active: ComputedRef<boolean>
  reports: ComputedRef<TeamReportTab[]>
  /** 在前面的那份交付 */
  activeReport: ComputedRef<string | null>
  show: () => void
  /** 打开一份交付；已经开着就切过去 */
  openReport: (report: TeamReportTab) => void
  closeReport: (id: string) => void
  /** 用户点了别的页签 */
  blur: () => void
  close: () => void
} {
  // 团队模式结束了，页签跟着消失（状态留着无妨，下次开团队再点摘要行才会出来）
  const state = computed(() => (hasTeam.value ? sessions.get(sid.value) : undefined))
  const front = computed(
    () => !!state.value && (state.value.active || (!browserOpen.value && !review.value))
  )
  const activeReport = computed(() => {
    const s = state.value
    if (!s || !front.value) return null
    const picked = s.reports.find((r) => r.id === s.current)
    // 团队任务关了、选中的那份也关了：落到最后一份上，别让面板空着
    return picked?.id ?? (s.board ? null : (s.reports.at(-1)?.id ?? null))
  })

  watch([sid, review], ([id, next], [previousId, previous]) => {
    if (id !== previousId || !next || next === previous) return
    const current = sessions.get(id)
    if (current) current.active = false
  })

  function ensure(): TeamTabState {
    let s = sessions.get(sid.value)
    if (!s) {
      s = { board: false, reports: [], active: true, current: null }
      sessions.set(sid.value, s)
    }
    return s
  }
  function dropIfEmpty(s: TeamTabState): void {
    if (!s.board && !s.reports.length) sessions.delete(sid.value)
  }

  return {
    open: computed(() => !!state.value?.board),
    active: computed(() => front.value && !!state.value?.board && activeReport.value === null),
    reports: computed(() => state.value?.reports ?? []),
    activeReport,
    show: () => Object.assign(ensure(), { board: true, active: true, current: null }),
    openReport: (report) => {
      const s = ensure()
      if (!s.reports.some((r) => r.id === report.id)) s.reports.push(report)
      s.active = true
      s.current = report.id
    },
    closeReport: (id) => {
      const s = sessions.get(sid.value)
      if (!s) return
      s.reports = s.reports.filter((r) => r.id !== id)
      if (s.current === id) s.current = null
      dropIfEmpty(s)
    },
    blur: () => {
      const current = sessions.get(sid.value)
      if (current) current.active = false
    },
    close: () => {
      const s = sessions.get(sid.value)
      if (!s) return
      s.board = false
      dropIfEmpty(s)
    }
  }
}
