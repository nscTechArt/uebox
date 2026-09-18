import { getCurrentScope, onScopeDispose, ref, watch, type Ref } from 'vue'

/**
 * 侧边栏「收起后悬停浮出」的状态机。
 *
 * 收起态下侧边栏完全不占位（不再留一条窄轨道）：鼠标悬停标签栏那枚开关，
 * 面板以浮层滑出盖在内容上；鼠标离开，延迟一小段再收回去。
 *
 * 延迟不是装饰。从开关挪到面板上、或者点开右键菜单和重命名弹窗时，
 * mouseleave 都会先触发一次，立刻收回会让人根本点不中。
 */

/** 鼠标离开后到真正收回之间的缓冲（毫秒） */
export const PEEK_CLOSE_DELAY = 220

/**
 * 这些浮层都 Teleport 到 body。侧栏处于临时浮出态时，鼠标移进它们不能把
 * 侧栏收回，否则持有菜单状态的 ChatSessionList 会被一起卸载。
 */
export const SIDEBAR_FLOATING_OVERLAY_SELECTOR =
  '.app-modal__wrap, .app-dropdown, .ant-dropdown, .ant-popover, .context-menu'

/**
 * 必须一路往上问到根。
 *
 * 关键在 `display`：祖先是 `display: none` 时，后代自己的 computed display 仍然是
 * 它声明的那个值（flex/block），并不会变成 none。AppModal 就踩在这上面 —— 它开过一次
 * 之后根节点一直留在 body 里，用 `v-show` 藏起来，而选择器命中的 `.app-modal__wrap`
 * 是它的孩子，单看自己永远是 `display: flex`。只看一层的话，全程都会被当成「弹窗还开着」。
 */
function isElementVisible(node: Element): boolean {
  for (let el: Element | null = node; el; el = el.parentElement) {
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false
    }
  }
  return true
}

export function hasVisibleSidebarFloatingOverlay(root: ParentNode = document): boolean {
  return Array.from(root.querySelectorAll(SIDEBAR_FLOATING_OVERLAY_SELECTOR)).some(isElementVisible)
}

export interface SidebarPeekOptions {
  /** 侧边栏是否处于收起状态。只有收起时才存在「浮出」这回事 */
  collapsed: () => boolean
  /** 鼠标离开后延迟多久收回 */
  closeDelay?: number
  /**
   * 收回前的最后一道保险。
   *
   * 弹窗、右键菜单渲染在 body 上而不在面板里，鼠标移过去等于离开了面板；
   * 鼠标还停在面板上时 mouseleave 也可能因为快速移动而漏发。
   * 返回 true 就再等一轮，所以它同时是防抖也是自愈。
   */
  shouldStayOpen?: () => boolean
}

export interface SidebarPeekController {
  /** 浮层是否正在显示 */
  peeking: Ref<boolean>
  /** 鼠标进入感应条或面板 */
  open: () => void
  /** 鼠标离开，延迟收回 */
  scheduleClose: () => void
  /** 立刻收回（导航、Esc、钉住侧边栏时用） */
  close: () => void
}

export function useSidebarPeek(options: SidebarPeekOptions): SidebarPeekController {
  const { collapsed, closeDelay = PEEK_CLOSE_DELAY, shouldStayOpen } = options
  const peeking = ref(false)
  let closeTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 收起/展开刚切换完的那一下，先不认 hover。
   *
   * 点「收起」时，鼠标底下的按钮和面板会在原地消失或挪位，浏览器会据此补一个
   * mouseenter —— 人根本没动鼠标，面板却会立刻又浮出来闪一下。
   * 所以切换后先解除武装，等到真的有一次 mousemove 再重新认。
   */
  let hoverArmed = true
  let stopArmListener: (() => void) | null = null

  const clearArmListener = (): void => {
    stopArmListener?.()
    stopArmListener = null
  }

  const disarmHoverUntilMouseMoves = (): void => {
    clearArmListener()
    if (typeof window === 'undefined') return
    hoverArmed = false
    const onMove = (): void => {
      hoverArmed = true
      clearArmListener()
    }
    window.addEventListener('mousemove', onMove)
    stopArmListener = () => window.removeEventListener('mousemove', onMove)
  }

  const cancelClose = (): void => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
  }

  const open = (): void => {
    cancelClose()
    // 已经钉住展开时没有浮层，别留下一个「浮出中」的脏状态
    if (hoverArmed && collapsed()) peeking.value = true
  }

  const close = (): void => {
    cancelClose()
    peeking.value = false
  }

  const scheduleClose = (): void => {
    cancelClose()
    const tick = (): void => {
      if (shouldStayOpen?.()) {
        closeTimer = setTimeout(tick, closeDelay)
        return
      }
      closeTimer = null
      peeking.value = false
    }
    closeTimer = setTimeout(tick, closeDelay)
  }

  // 钉住展开的一瞬间，浮层就没有意义了；收起的那一下也不能被补发的 hover 顶回来
  watch(
    collapsed,
    () => {
      close()
      disarmHoverUntilMouseMoves()
    },
    { flush: 'sync' }
  )

  if (getCurrentScope()) {
    onScopeDispose(() => {
      cancelClose()
      clearArmListener()
    })
  }

  return { peeking, open, scheduleClose, close }
}
