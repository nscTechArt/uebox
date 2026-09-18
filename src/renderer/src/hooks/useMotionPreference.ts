/**
 * 动效开关：跟随系统 / 强制开 / 强制关。
 *
 * ## 为什么需要一个手动档
 *
 * 样式表里到处写着 `@media (prefers-reduced-motion: reduce)`，那条媒体查询
 * 只认系统设置。两种人被它漏掉：
 *
 *   1. 系统里没开、但就是不想看动画的人（远程桌面、老机器、投屏演示）；
 *   2. 系统里误开了、却想看动画的人 —— 有些 Windows 的「性能优化」会顺手
 *      把它打开，用户根本不知道是自己关掉了盒子的动效。
 *
 * ## 为什么落在 `<html data-motion>` 上而不是各处 media query
 *
 * 判定收在一处：JS 把三档解析成两种结果（full / reduced）写在根元素上，
 * 样式表只要认一个属性选择器。三档各自去写媒体查询组合的话，
 * 「强制开」那一档必须去否定一条 media query，而那是 CSS 里最容易写错的东西。
 *
 * 已有的 `prefers-reduced-motion` 块不用动 —— 系统档下两者会同时命中，
 * 结果一致；`components.css` 里那条属性选择器负责另外两档。
 *
 * ## 为什么不进 Pinia
 *
 * 和主题同一个道理：要在 Vue 起来之前就生效，否则首帧会带着动画闪一下。
 * 同步读 localStorage、立刻写根元素，`main.ts` 里调一次。
 */

import { ref, computed, watch, type ComputedRef, type Ref } from 'vue'

export type MotionPreference = 'system' | 'full' | 'reduced'

/** 解析之后只有两种：动效照常、动效收掉 */
export type ResolvedMotion = 'full' | 'reduced'

const STORAGE_KEY = 'app-motion'

function loadPreference(): MotionPreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'full' || saved === 'reduced' || saved === 'system') return saved
  } catch {
    // 隐私模式之类读不到 localStorage 的环境。按跟随系统走
  }
  return 'system'
}

const preference = ref<MotionPreference>(loadPreference())

/** 系统此刻要不要减少动效。matchMedia 拿不到（老环境、测试里）时按「不减少」 */
function systemPrefersReduced(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

const systemReduced = ref(systemPrefersReduced())

/**
 * 系统设置是会变的（用户在系统里改一下，不重启应用）。
 * 只在跟随档下才影响结果，但监听一直挂着 —— 切回跟随档时它得已经是新值。
 */
try {
  window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', (event) => {
    systemReduced.value = event.matches
  })
} catch {
  // 同上，拿不到就算了
}

const resolvedMotion = computed<ResolvedMotion>(() => {
  if (preference.value === 'full') return 'full'
  if (preference.value === 'reduced') return 'reduced'
  return systemReduced.value ? 'reduced' : 'full'
})

/**
 * 多窗口共用一份 localStorage（主窗口、MiniChat、Spotlight）。
 * 在一个窗口里改了，别的窗口要跟着变 —— 否则同一个应用两种脾气。
 */
window.addEventListener('storage', (event) => {
  if (event.key === null || event.key === STORAGE_KEY) preference.value = loadPreference()
})

function applyMotion(mode: ResolvedMotion): void {
  document.documentElement.setAttribute('data-motion', mode)
}

watch(resolvedMotion, (mode) => applyMotion(mode), { immediate: false })

export interface UseMotionPreferenceReturn {
  /** 用户选的那一档（三态），可写 */
  motionPreference: Ref<MotionPreference>
  /** 实际生效的两态 */
  resolvedMotion: ComputedRef<ResolvedMotion>
  setMotionPreference: (next: MotionPreference) => void
}

export function useMotionPreference(): UseMotionPreferenceReturn {
  return {
    motionPreference: preference,
    resolvedMotion,
    setMotionPreference(next: MotionPreference): void {
      preference.value = next
      try {
        localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // 存不下就只在这一次会话里生效，不该因此报错
      }
    }
  }
}

/**
 * 应用启动时调一次，把属性写上去。
 *
 * 必须在挂载 Vue 应用之前 —— 晚一步，首帧就会带着动画闪一下，
 * 而「减少动效」的用户看到的正是他想避开的那个东西。
 */
export function initMotionPreference(): void {
  applyMotion(resolvedMotion.value)
}
