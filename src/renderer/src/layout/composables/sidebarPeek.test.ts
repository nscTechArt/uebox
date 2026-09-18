import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope, type Ref } from 'vue'
import {
  hasVisibleSidebarFloatingOverlay,
  PEEK_CLOSE_DELAY,
  useSidebarPeek,
  type SidebarPeekController
} from './sidebarPeek'

function setup(options: { collapsed?: boolean; shouldStayOpen?: () => boolean } = {}): {
  collapsed: Ref<boolean>
  peek: SidebarPeekController
  scope: EffectScope
} {
  const collapsed = ref(options.collapsed ?? true)
  const scope = effectScope()
  const peek = scope.run(() =>
    useSidebarPeek({ collapsed: () => collapsed.value, shouldStayOpen: options.shouldStayOpen })
  )!
  return { collapsed, peek, scope }
}

describe('useSidebarPeek', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('自建下拉菜单打开时，侧栏把它当成仍在交互的浮层', () => {
    const dropdown = document.createElement('div')
    dropdown.className = 'app-dropdown'
    document.body.append(dropdown)

    expect(hasVisibleSidebarFloatingOverlay()).toBe(true)

    dropdown.style.display = 'none'
    expect(hasVisibleSidebarFloatingOverlay()).toBe(false)
  })

  it('弹窗关掉后只是父节点被藏起来，不该再算作浮层还开着', () => {
    // AppModal 开过一次就一直留在 body 里，关掉是 v-show 藏根节点；
    // 命中的 .app-modal__wrap 是它的孩子，自己永远是 display: flex
    const root = document.createElement('div')
    root.className = 'app-modal-root'
    const wrap = document.createElement('div')
    wrap.className = 'app-modal__wrap'
    wrap.style.display = 'flex'
    root.append(wrap)
    document.body.append(root)

    expect(hasVisibleSidebarFloatingOverlay()).toBe(true)

    root.style.display = 'none'
    expect(hasVisibleSidebarFloatingOverlay()).toBe(false)
  })

  it('浮出只在收起态生效', () => {
    const { peek } = setup({ collapsed: true })
    peek.open()
    expect(peek.peeking.value).toBe(true)

    const docked = setup({ collapsed: false })
    docked.peek.open()
    expect(docked.peek.peeking.value).toBe(false)
  })

  it('鼠标离开后延迟收回，中途回来则不收', () => {
    const { peek } = setup()
    peek.open()

    peek.scheduleClose()
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY - 1)
    expect(peek.peeking.value).toBe(true)

    // 差一毫秒时鼠标又回到面板上：这一次收回必须被取消
    peek.open()
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY * 3)
    expect(peek.peeking.value).toBe(true)

    peek.scheduleClose()
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY)
    expect(peek.peeking.value).toBe(false)
  })

  it('弹窗还开着时不收回，弹窗关掉后自己收回', () => {
    let modalOpen = true
    const { peek } = setup({ shouldStayOpen: () => modalOpen })
    peek.open()

    peek.scheduleClose()
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY * 5)
    expect(peek.peeking.value).toBe(true)

    // 不需要再动一次鼠标：下一轮轮询自己会把它收回去
    modalOpen = false
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY)
    expect(peek.peeking.value).toBe(false)
  })

  it('刚点完收起时，浏览器补发的 hover 不该把面板顶回来', () => {
    const { collapsed, peek } = setup({ collapsed: false })

    // 点「收起」：鼠标底下的按钮就地消失，浏览器会据此补一个 mouseenter
    collapsed.value = true
    peek.open()
    expect(peek.peeking.value).toBe(false)

    // 人真的动了鼠标，才重新认 hover
    window.dispatchEvent(new MouseEvent('mousemove'))
    peek.open()
    expect(peek.peeking.value).toBe(true)
  })

  it('钉住展开时立刻收掉浮层', () => {
    const { collapsed, peek } = setup()
    peek.open()

    collapsed.value = false
    expect(peek.peeking.value).toBe(false)
  })

  it('close 会清掉待执行的定时器', () => {
    const { peek } = setup()
    peek.open()
    peek.scheduleClose()
    peek.close()
    expect(peek.peeking.value).toBe(false)

    // 收回后又浮出，之前那个定时器不该把它再关一次
    peek.open()
    vi.advanceTimersByTime(PEEK_CLOSE_DELAY * 2)
    expect(peek.peeking.value).toBe(true)
  })

  it('作用域销毁后不再触发收回', () => {
    const { peek, scope } = setup()
    peek.open()
    peek.scheduleClose()
    scope.stop()

    vi.advanceTimersByTime(PEEK_CLOSE_DELAY * 2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
