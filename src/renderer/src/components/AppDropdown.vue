<script setup lang="ts">
/**
 * 下拉浮层。接替 ant-design-vue 的 `<a-dropdown>`（19 处）。
 *
 * 浮层里装的几乎都是 [AppMenu.vue]，但这里不假设 —— overlay 插槽放什么都行。
 *
 * ## 和 [AppTooltip.vue] 共用同一套定位
 *
 * 同样得挂到 `<body>`（否则被祖先的 `overflow: hidden` 剪掉）、同样用
 * `@floating-ui/dom` 算位置和贴边翻面。区别在于交互：tooltip 是悬停即走，
 * 这里要处理「点外面关掉」「Esc 关掉并把焦点还给触发器」「方向键进菜单」。
 *
 * ## 关掉时焦点要还给触发器
 *
 * 不还的话焦点落回 `<body>`，键盘用户点开一个菜单又关掉，就得从页头重新 Tab。
 * 和 AppModal 是同一条道理。
 */
import { computed, onBeforeUnmount, ref, watch, type CSSProperties } from 'vue'
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  type VirtualElement
} from '@floating-ui/dom'

type Trigger = 'click' | 'hover' | 'contextmenu'

interface Props {
  /** 触发方式。`[]` 表示只受 `open` 控制，自己在外面开关 */
  trigger?: Trigger[]
  placement?:
    | 'bottom'
    | 'bottomLeft'
    | 'bottomRight'
    | 'top'
    | 'topLeft'
    | 'topRight'
    | 'rightStart'
  /** 受控打开状态。不传就由组件自己管 */
  open?: boolean
  /** 右键菜单等场景直接以视口坐标为锚点，不再跟随触发元素 */
  anchorPoint?: { x: number; y: number }
  disabled?: boolean
  /** 加在浮层容器上的样式 */
  overlayStyle?: CSSProperties
}

const props = withDefaults(defineProps<Props>(), {
  trigger: () => ['click'],
  placement: 'bottomLeft',
  open: undefined,
  anchorPoint: undefined,
  disabled: false,
  overlayStyle: undefined
})

const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const triggerRef = ref<HTMLElement | null>(null)
const floatingRef = ref<HTMLElement | null>(null)
const innerOpen = ref(false)
const position = ref({ x: 0, y: 0 })

/** 传了 open 就是受控，否则自己管 */
const isControlled = computed(() => props.open !== undefined)
const visible = computed(() => (isControlled.value ? Boolean(props.open) : innerOpen.value))

/** antd 的 bottomLeft/bottomRight 在 floating-ui 里叫 bottom-start / bottom-end */
const floatingPlacement = computed(() => {
  const map: Record<string, string> = {
    bottom: 'bottom',
    bottomLeft: 'bottom-start',
    bottomRight: 'bottom-end',
    top: 'top',
    topLeft: 'top-start',
    topRight: 'top-end',
    rightStart: 'right-start'
  }
  return map[props.placement] ?? 'bottom-start'
})

let stopAutoUpdate: (() => void) | null = null
let previouslyFocused: HTMLElement | null = null
let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null

function anchor(): HTMLElement | null {
  let el = triggerRef.value

  // AppDropdown / AppTooltip 的触发壳都是 display: contents，本身没有可测量的盒子。
  // 两者嵌套时只拆一层会把 Tooltip 壳交给 floating-ui，坐标就会退回窗口左上角。
  while (
    el &&
    (el.classList.contains('app-dropdown-trigger') || el.classList.contains('app-tooltip-trigger'))
  ) {
    const child = el.firstElementChild as HTMLElement | null
    if (!child) break
    el = child
  }

  return el
}

/**
 * 触发器已经不生成盒子了 —— 量出来会是 0×0 @ (0, 0)。
 *
 * 行尾那种「hover 才出现的 …」按钮是 `display: none` 起步的
 * （NoteSourcePanel 的 `.more-btn`）。菜单开着的时候鼠标一移开，触发器就没了盒子，
 * autoUpdate 的 ResizeObserver 立刻拿这个零矩形重算一次 ——
 * 菜单当场从按钮底下跳到**窗口左上角**，还带着 z-index 盖住那一片。
 *
 * 遇到这种情况就不算了，保持上一次算出来的位置：菜单停在原地总比跳到角落强。
 *
 * `checkVisibility()` 是 Chrome 105+ 的方法，测试环境（happy-dom）没有实现；
 * 拿不到就当可见，行为和以前一致。
 */
function anchorLostItsBox(el: HTMLElement | null): boolean {
  return typeof el?.checkVisibility === 'function' && !el.checkVisibility()
}

function positioningAnchor(): HTMLElement | VirtualElement | null {
  const point = props.anchorPoint
  if (!point) return anchor()

  const contextElement = anchor() ?? undefined
  return {
    contextElement,
    getBoundingClientRect: () => ({
      x: point.x,
      y: point.y,
      top: point.y,
      right: point.x,
      bottom: point.y,
      left: point.x,
      width: 0,
      height: 0
    })
  }
}

async function place(): Promise<void> {
  const reference = positioningAnchor()
  const floating = floatingRef.value
  if (!reference || !floating) return
  // 坐标锚点本来就是 0×0，只有跟着元素走的时候才需要这道保险
  if (!props.anchorPoint && anchorLostItsBox(anchor())) return
  const { x, y } = await computePosition(reference, floating, {
    placement: floatingPlacement.value as never,
    middleware: [offset(4), flip(), shift({ padding: 8 })]
  })
  position.value = { x, y }
}

function setOpen(next: boolean): void {
  if (props.disabled && next) return
  if (!isControlled.value) innerOpen.value = next
  emit('update:open', next)
}

function clearHoverCloseTimer(): void {
  if (!hoverCloseTimer) return
  clearTimeout(hoverCloseTimer)
  hoverCloseTimer = null
}

function scheduleHoverClose(): void {
  if (!props.trigger.includes('hover')) return
  clearHoverCloseTimer()
  hoverCloseTimer = setTimeout(() => {
    hoverCloseTimer = null
    close()
  }, 100)
}

function toggle(): void {
  setOpen(!visible.value)
}

function close(): void {
  clearHoverCloseTimer()
  setOpen(false)
}

function onTriggerClick(): void {
  if (props.trigger.includes('click')) toggle()
}

function onTriggerContextmenu(event: MouseEvent): void {
  if (!props.trigger.includes('contextmenu')) return
  event.preventDefault()
  setOpen(true)
}

function onTriggerEnter(): void {
  if (!props.trigger.includes('hover')) return
  clearHoverCloseTimer()
  setOpen(true)
}

function onTriggerLeave(): void {
  scheduleHoverClose()
}

function onFloatingEnter(): void {
  clearHoverCloseTimer()
}

function onFloatingLeave(): void {
  scheduleHoverClose()
}

/** 点到浮层和触发器以外的地方就关掉 */
function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node
  if (floatingRef.value?.contains(target) || triggerRef.value?.contains(target)) return
  close()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    close()
    return
  }
  // 从触发器按 ↓ 直接进菜单第一项，键盘用户不用先 Tab 进去
  if (event.key === 'ArrowDown' && !visible.value) {
    event.preventDefault()
    setOpen(true)
  }
}

watch(
  visible,
  async (shown) => {
    stopAutoUpdate?.()
    stopAutoUpdate = null
    document.removeEventListener('pointerdown', onDocumentPointerDown, true)

    if (!shown) {
      previouslyFocused?.focus?.()
      previouslyFocused = null
      return
    }

    previouslyFocused = document.activeElement as HTMLElement | null
    await place()
    const reference = positioningAnchor()
    if (reference && floatingRef.value) {
      stopAutoUpdate = autoUpdate(reference, floatingRef.value, place)
    }
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
  },
  // 浮层由 v-if 创建：默认的 pre watcher 会在 DOM 挂载前执行，floatingRef 还是 null，
  // 定位直接跳过后就永远停在 (0, 0)。post 保证 Teleport 里的浮层已经可以测量。
  { flush: 'post' }
)

onBeforeUnmount(() => {
  clearHoverCloseTimer()
  stopAutoUpdate?.()
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
})
</script>

<template>
  <!--
    click / contextmenu 走**捕获**阶段。
    a-dropdown 是把自己的 onClick 克隆进子节点的 vnode 里，所以子节点自己写
    `@click.stop` 也不影响它。我们是在外面包一层监听 —— 子节点一 `.stop`，
    冒泡阶段的事件根本到不了这里，菜单就再也打不开了
    （全仓有 9 处触发器写了 @click.stop）。捕获阶段在目标自己的处理器之前跑，
    `.stop` 拦不住。
  -->
  <span
    ref="triggerRef"
    class="app-dropdown-trigger"
    @click.capture="onTriggerClick"
    @contextmenu.capture="onTriggerContextmenu"
    @mouseenter="onTriggerEnter"
    @mouseleave="onTriggerLeave"
    @keydown="onKeydown"
  >
    <slot />
  </span>

  <Teleport to="body">
    <div
      v-if="visible"
      ref="floatingRef"
      class="app-dropdown"
      :style="{ transform: `translate(${position.x}px, ${position.y}px)`, ...overlayStyle }"
      @mouseenter="onFloatingEnter"
      @mouseleave="onFloatingLeave"
      @keydown="onKeydown"
      @click="close"
    >
      <slot name="overlay" />
    </div>
  </Teleport>
</template>

<style scoped>
/* display: contents —— 不生成布局盒，套上去不会把原来的排版挤歪 */
.app-dropdown-trigger {
  display: contents;
}
</style>

<style>
/* 浮层挂在 <body> 上，拿不到 scoped 的 data-v 属性，这段必须是全局的 */
.app-dropdown {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1050;
}
</style>
