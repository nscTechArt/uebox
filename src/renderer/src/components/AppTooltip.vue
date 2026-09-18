<script setup lang="ts">
/**
 * 提示气泡。接替 ant-design-vue 的 `<a-tooltip>`（54 处）。
 *
 * ## 为什么不能只用 CSS
 *
 * 提示气泡必须挂到 `<body>` 上。侧边栏、列表、卡片这些容器几乎都有
 * `overflow: hidden`，气泡留在原地会被直接剪掉一半。挂出去之后位置就得自己算，
 * 还要处理「贴着屏幕边缘时翻到另一侧」——这块用 `@floating-ui/dom`，
 * 不自己写：它是 Radix / HeadlessUI / reka-ui 底下同一个东西，边缘情况
 * （嵌套滚动容器、有 transform 的祖先、窗口缩放）比手写靠谱得多。
 *
 * ## 长相照搬现状
 *
 * 底色 `--color-bg-raised`、文字 `--color-text-primary` —— 和原来在
 * `useTheme.ts` 的 `components.Tooltip` 里给 antd 的那两个值一致。
 * 那里有一条注释值得留意：文字色**必须**跟着底色一起给，
 * 只改底色的话浅色主题下会白底白字，气泡变成一个空白方块。
 *
 * ## 触发器不包盒子
 *
 * 外层 `<span>` 是 `display: contents` —— 它不生成布局盒，套上去不会把
 * 原来的 flex/grid 排版挤歪。事件照样从子元素冒泡上来，定位则用它的
 * 第一个子元素当锚点。
 */
import { computed, onBeforeUnmount, ref, useId, useSlots, watch } from 'vue'
import {
  autoUpdate,
  computePosition,
  flip,
  offset as offsetMiddleware,
  shift
} from '@floating-ui/dom'

interface Props {
  /** 气泡里的文字。为空且没有 #title 插槽时，整个气泡不出现（和 a-tooltip 一致） */
  title?: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
  /** 悬停多久才弹，单位秒。默认 0.1，和 antd 一样 */
  mouseEnterDelay?: number
  /** 加在气泡上的额外 class，用于个别位置微调 */
  overlayClassName?: string
  /**
   * 沿主轴推开多少像素，默认 8。
   * antd 那边是 `:align="{ offset: [x, y] }"`，只有一处在用（侧边栏工程标题的
   * 提示要躲开行尾的操作按钮）。这里收成一个数，语义更直白。
   */
  offset?: number
}

const props = withDefaults(defineProps<Props>(), {
  title: '',
  placement: 'top',
  mouseEnterDelay: 0.1,
  overlayClassName: undefined,
  offset: 8
})

const triggerRef = ref<HTMLElement | null>(null)
const floatingRef = ref<HTMLElement | null>(null)
const visible = ref(false)
const position = ref({ x: 0, y: 0 })
const tooltipId = `app-tooltip-${useId()}`

const slots = useSlots()
/** 富文本内容走 #title 插槽，纯文字走 title 属性，两个都空就不弹 */
const hasContent = computed(() => Boolean(slots.title) || props.title.trim() !== '')

let showTimer: ReturnType<typeof setTimeout> | null = null
let stopAutoUpdate: (() => void) | null = null

/** 定位锚点是被包住的那个元素本身，不是 display:contents 的壳 */
function anchor(): HTMLElement | null {
  const el = triggerRef.value
  return (el?.firstElementChild as HTMLElement | null) ?? el
}

async function place(): Promise<void> {
  const reference = anchor()
  const floating = floatingRef.value
  if (!reference || !floating) return

  const { x, y } = await computePosition(reference, floating, {
    placement: props.placement,
    middleware: [
      offsetMiddleware(props.offset),
      // 贴边就翻到对面，翻不了就沿着边推回来，留 8px 不贴死屏幕
      flip(),
      shift({ padding: 8 })
    ]
  })
  position.value = { x, y }
}

function clearTimer(): void {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = null
  }
}

function open(): void {
  if (!hasContent.value) return
  clearTimer()
  showTimer = setTimeout(
    () => {
      visible.value = true
    },
    Math.max(0, props.mouseEnterDelay) * 1000
  )
}

function close(): void {
  clearTimer()
  visible.value = false
}

// 键盘用户按 Esc 要能把气泡赶走，否则它会一直挡着下面的内容
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close()
}

watch(visible, async (shown) => {
  stopAutoUpdate?.()
  stopAutoUpdate = null

  const reference = anchor()
  if (!shown || !reference) {
    reference?.removeAttribute('aria-describedby')
    return
  }

  // 读屏软件靠这个把气泡念成目标元素的说明
  reference.setAttribute('aria-describedby', tooltipId)
  await place()
  // 页面滚动、窗口缩放、祖先容器变化时跟着重算
  if (floatingRef.value) {
    stopAutoUpdate = autoUpdate(reference, floatingRef.value, place)
  }
})

onBeforeUnmount(() => {
  clearTimer()
  stopAutoUpdate?.()
  anchor()?.removeAttribute('aria-describedby')
})
</script>

<template>
  <span
    ref="triggerRef"
    class="app-tooltip-trigger"
    @mouseenter="open"
    @mouseleave="close"
    @focusin="open"
    @focusout="close"
    @keydown="onKeydown"
  >
    <slot />
  </span>

  <Teleport to="body">
    <div
      v-if="visible && hasContent"
      :id="tooltipId"
      ref="floatingRef"
      role="tooltip"
      :class="['app-tooltip', overlayClassName]"
      :style="{ transform: `translate(${position.x}px, ${position.y}px)` }"
    >
      <slot name="title">{{ title }}</slot>
    </div>
  </Teleport>
</template>

<style scoped>
/* display: contents —— 不生成布局盒，套上去不会把原来的排版挤歪 */
.app-tooltip-trigger {
  display: contents;
}
</style>

<style>
/*
 * 气泡挂在 <body> 上，拿不到 scoped 的 data-v 属性，所以这段必须是全局的。
 * 类名带 app- 前缀，不会和别处撞。
 */
.app-tooltip {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1070;
  max-width: 280px;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  /* 文字色必须跟底色一起给：只改一半的话浅色主题下就是白底白字 */
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  line-height: 1.5;
  box-shadow: var(--shadow-pop);
  border: 1px solid var(--color-border-subtle);
  /* 气泡不接鼠标事件，否则它盖住目标时会立刻触发 mouseleave，一闪一闪 */
  pointer-events: none;
  word-break: break-word;
}
</style>
