import { describe, expect, it, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { autoUpdate, computePosition } from '@floating-ui/dom'

import AppDropdown from './AppDropdown.vue'

// 定位交给 @floating-ui/dom；这里测的是开关时机、点外面、键盘，不是算得准不准
vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
  autoUpdate: vi.fn(() => vi.fn()),
  offset: vi.fn(),
  flip: vi.fn(),
  shift: vi.fn()
}))

/**
 * 挂过的 wrapper 都记下来，afterEach 里逐个 unmount。
 *
 * 不能图省事用 `document.body.innerHTML = ''` —— 那只是把 DOM 抹了，组件还活着，
 * 下一个用例里它一旦重新渲染就会去 patch 一段已经不存在的 DOM，
 * 报 `insertBefore of null`，而且错会记在**下一个**用例头上。
 */
const mounted: VueWrapper[] = []

function mountDropdown(props: Record<string, unknown> = {}): VueWrapper {
  const wrapper = mount(AppDropdown, {
    props,
    slots: {
      default: '<button class="trigger">菜单</button>',
      overlay: '<div class="overlay">内容</div>'
    }
  }) as VueWrapper
  mounted.push(wrapper)
  return wrapper
}

const overlay = (): Element | null => document.querySelector('.overlay')

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
})

describe('AppDropdown', () => {
  it('浮层挂载后再定位，不会停在页面左上角', async () => {
    vi.mocked(computePosition).mockResolvedValueOnce({
      x: 320,
      y: 72,
      placement: 'bottom-end',
      strategy: 'absolute',
      middlewareData: {}
    })
    const wrapper = mountDropdown({ placement: 'bottomRight' })

    await wrapper.get('.app-dropdown-trigger').trigger('click')
    await vi.waitFor(() => {
      expect(computePosition).toHaveBeenCalled()
      expect(document.querySelector<HTMLElement>('.app-dropdown')?.style.transform).toBe(
        'translate(320px, 72px)'
      )
    })
  })

  it('触发器外面套着 Tooltip 时，定位到真正按钮而不是透明壳', async () => {
    vi.mocked(computePosition).mockClear()
    const wrapper = mount(AppDropdown, {
      slots: {
        default:
          '<span class="app-tooltip-trigger"><button class="nested-trigger">菜单</button></span>',
        overlay: '<div class="overlay">内容</div>'
      }
    }) as VueWrapper
    mounted.push(wrapper)

    await wrapper.get('.nested-trigger').trigger('click')
    await vi.waitFor(() => expect(computePosition).toHaveBeenCalled())

    expect(vi.mocked(computePosition).mock.calls.at(-1)?.[0]).toBe(
      wrapper.get('.nested-trigger').element
    )
  })

  it('坐标锚点把菜单定位在鼠标右侧', async () => {
    vi.mocked(computePosition).mockClear()
    const wrapper = mountDropdown({
      open: false,
      trigger: [],
      anchorPoint: { x: 240, y: 96 },
      placement: 'rightStart'
    })

    await wrapper.setProps({ open: true })
    await vi.waitFor(() => expect(computePosition).toHaveBeenCalled())

    const [reference, , options] = vi.mocked(computePosition).mock.calls.at(-1)!
    expect(reference.getBoundingClientRect()).toMatchObject({
      x: 240,
      y: 96,
      width: 0,
      height: 0
    })
    expect(options?.placement).toBe('right-start')
    expect(wrapper.find('.trigger').exists()).toBe(true)
  })

  it('默认点击触发：点一下开，再点一下关', async () => {
    const wrapper = mountDropdown()
    expect(overlay()).toBeNull()

    await wrapper.get('.app-dropdown-trigger').trigger('click')
    expect(overlay()).not.toBeNull()

    await wrapper.get('.app-dropdown-trigger').trigger('click')
    expect(overlay()).toBeNull()
  })

  it('子触发器阻止冒泡时仍能打开', async () => {
    const wrapper = mount(AppDropdown, {
      slots: {
        default: '<button class="trigger" @click.stop>菜单</button>',
        overlay: '<div class="overlay">内容</div>'
      }
    }) as VueWrapper
    mounted.push(wrapper)

    await wrapper.get('.trigger').trigger('click')

    expect(overlay()).not.toBeNull()
  })

  it('trigger=[] 时点击不开，只受 open 控制', async () => {
    const wrapper = mountDropdown({ trigger: [], open: false })

    await wrapper.get('.app-dropdown-trigger').trigger('click')
    expect(overlay()).toBeNull()

    await wrapper.setProps({ open: true })
    expect(overlay()).not.toBeNull()
  })

  it('contextmenu 触发时右键打开并挡掉系统菜单', async () => {
    const wrapper = mountDropdown({ trigger: ['contextmenu'] })

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    const prevented = vi.spyOn(event, 'preventDefault')
    wrapper.get('.app-dropdown-trigger').element.dispatchEvent(event)
    await wrapper.vm.$nextTick()

    expect(prevented).toHaveBeenCalled()
    expect(overlay()).not.toBeNull()
  })

  it('hover 触发时，从按钮移进浮层不会在半路消失', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountDropdown({ trigger: ['hover'] })

      await wrapper.get('.app-dropdown-trigger').trigger('mouseenter')
      expect(overlay()).not.toBeNull()

      await wrapper.get('.app-dropdown-trigger').trigger('mouseleave')
      document
        .querySelector('.app-dropdown')
        ?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
      vi.runAllTimers()
      await wrapper.vm.$nextTick()

      expect(overlay()).not.toBeNull()

      document
        .querySelector('.app-dropdown')
        ?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
      vi.runAllTimers()
      await wrapper.vm.$nextTick()

      expect(overlay()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // 不关的话点了页面别处菜单还杵在那儿
  it('点到浮层和触发器以外的地方就关掉', async () => {
    const wrapper = mountDropdown()
    await wrapper.get('.app-dropdown-trigger').trigger('click')
    expect(overlay()).not.toBeNull()

    document.documentElement.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(overlay()).toBeNull()
  })

  it('点浮层内部不会把它关掉', async () => {
    const wrapper = mountDropdown()
    await wrapper.get('.app-dropdown-trigger').trigger('click')

    overlay()?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(overlay()).not.toBeNull()
  })

  it('Esc 关掉', async () => {
    const wrapper = mountDropdown()
    await wrapper.get('.app-dropdown-trigger').trigger('click')

    await wrapper.get('.app-dropdown-trigger').trigger('keydown', { key: 'Escape' })

    expect(overlay()).toBeNull()
  })

  // 键盘用户不用先 Tab 进浮层才能操作
  it('关着的时候按 ↓ 直接打开', async () => {
    const wrapper = mountDropdown()

    await wrapper.get('.app-dropdown-trigger').trigger('keydown', { key: 'ArrowDown' })

    expect(overlay()).not.toBeNull()
  })

  /**
   * 这条是回归用的：全仓有 9 处触发器写着 `@click.stop`（它们不想让点击冒到
   * 外面的行选中逻辑上去）。a-dropdown 是把 onClick 克隆进子节点 vnode，
   * 不受 .stop 影响；我们在外面包一层监听，如果走冒泡阶段，
   * 子节点一 .stop 菜单就再也打不开 —— 用户看到的是「按钮点了没反应」。
   */
  it('子节点 @click.stop 也照样能打开（监听走捕获阶段）', async () => {
    const wrapper = mount(AppDropdown, {
      slots: {
        default: '<button class="trigger" @click.stop>菜单</button>',
        overlay: '<div class="overlay">内容</div>'
      }
    }) as VueWrapper
    mounted.push(wrapper)

    await wrapper.get('.trigger').trigger('click')

    expect(overlay()).not.toBeNull()
  })

  /**
   * 回归：浮层是 v-if 创建的，默认的 pre watcher 在 DOM 挂载**之前**跑，
   * 那时 floatingRef 还是 null —— computePosition 根本不会被调用，
   * 浮层就永远停在 translate(0, 0)，也就是窗口左上角。
   *
   * 表现非常误导：菜单其实开了，只是跑到了屏幕左上角，
   * 而且它带 z-index 会盖住那一块的其他按钮 —— 用户看到的是
   * 「右键没反应，而且旁边的按钮也点不动了」。
   */
  it('打开后真的算过位置，不是停在 (0, 0)', async () => {
    const { computePosition } = await import('@floating-ui/dom')
    const wrapper = mountDropdown()

    await wrapper.get('.app-dropdown-trigger').trigger('click')
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    // 浮层挂上之后才可能测量 —— 没调过就说明 watcher 跑早了
    expect(computePosition).toHaveBeenCalled()
  })

  /**
   * 回归：菜单开着的时候触发器被藏起来了。
   *
   * 知识库来源那一行的「…」按钮是 `display: none` 起步、整行 hover 才出现的。
   * 用户点开菜单、鼠标往菜单上一移，这一行就不 hover 了 —— 按钮没了盒子，
   * autoUpdate 立刻拿这个 0×0 矩形重算一次，菜单**从按钮底下跳到窗口左上角**。
   */
  it('触发器被藏起来后不重新定位，菜单留在原地', async () => {
    vi.mocked(computePosition).mockClear()
    vi.mocked(autoUpdate).mockClear()
    vi.mocked(computePosition).mockResolvedValueOnce({
      x: 320,
      y: 72,
      placement: 'bottom-start',
      strategy: 'absolute',
      middlewareData: {}
    })
    const wrapper = mountDropdown()

    await wrapper.get('.app-dropdown-trigger').trigger('click')
    await vi.waitFor(() => expect(autoUpdate).toHaveBeenCalled())
    const floating = document.querySelector<HTMLElement>('.app-dropdown')
    expect(floating?.style.transform).toBe('translate(320px, 72px)')

    // happy-dom 没有 checkVisibility，这里按 display: none 之后的真实返回值补上
    const trigger = wrapper.get('.trigger').element as HTMLElement
    trigger.checkVisibility = (): boolean => false

    // autoUpdate 的第三个参数就是组件的 place()
    vi.mocked(autoUpdate).mock.calls.at(-1)?.[2]()
    await wrapper.vm.$nextTick()

    expect(computePosition).toHaveBeenCalledTimes(1)
    expect(floating?.style.transform).toBe('translate(320px, 72px)')
  })

  it('disabled 时打不开', async () => {
    const wrapper = mountDropdown({ disabled: true })

    await wrapper.get('.app-dropdown-trigger').trigger('click')

    expect(overlay()).toBeNull()
  })

  it('受控模式下自己不改状态，只往外发 update:open', async () => {
    const wrapper = mountDropdown({ open: false })

    await wrapper.get('.app-dropdown-trigger').trigger('click')

    expect(wrapper.emitted('update:open')).toEqual([[true]])
    // 外面没把 open 改成 true，浮层就不该出现
    expect(overlay()).toBeNull()
  })
})
