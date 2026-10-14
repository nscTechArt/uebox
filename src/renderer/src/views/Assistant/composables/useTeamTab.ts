import { computed, reactive, watch, type ComputedRef, type Ref } from 'vue'

/**
 * 右侧面板里的「团队任务」页签，按对话各记各的。
 *
 * 面板里还有审查和网页两类页签，谁在前面这样定：
 *   - 用户点了团队任务（摘要行或页签），它就在前面，直到用户点别的页签；
 *   - 新打开一次审查（点了「查看改动」）是用户刚做的动作，让审查到前面；
 *   - 没人被点过时，只剩它一个就显示它。
 *
 * 状态放在模块里而不是组件里：页面按完整地址缓存，切走再切回来（地址带的参数
 * 不完全一样）会拿到一个新的页面实例，记在组件里的话页签就自己没了。
 */
const sessions = reactive(new Map<string, { active: boolean }>())

export function useTeamTab(
  sid: Readonly<Ref<string>>,
  hasTeam: Readonly<Ref<boolean>>,
  review: Readonly<Ref<object | undefined>>,
  browserOpen: Readonly<Ref<boolean>>
): {
  open: ComputedRef<boolean>
  active: ComputedRef<boolean>
  show: () => void
  /** 用户点了别的页签 */
  blur: () => void
  close: () => void
} {
  // 团队模式结束了，页签跟着消失（状态留着无妨，下次开团队再点摘要行才会出来）
  const state = computed(() => (hasTeam.value ? sessions.get(sid.value) : undefined))
  const open = computed(() => !!state.value)
  const active = computed(
    () => !!state.value && (state.value.active || (!browserOpen.value && !review.value))
  )

  watch([sid, review], ([id, next], [previousId, previous]) => {
    if (id !== previousId || !next || next === previous) return
    const current = sessions.get(id)
    if (current) current.active = false
  })

  return {
    open,
    active,
    show: () => sessions.set(sid.value, { active: true }),
    blur: () => {
      const current = sessions.get(sid.value)
      if (current) current.active = false
    },
    close: () => sessions.delete(sid.value)
  }
}
