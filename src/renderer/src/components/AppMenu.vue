<script setup lang="ts">
/**
 * 菜单容器。接替 ant-design-vue 的 `<a-menu>`（18 处，全部在 dropdown 的浮层里）。
 *
 * 侧边栏那个导航菜单**不是**这个 —— 它用的是 antd 的 `<Menu>` 组件
 * （内联展开、子菜单、选中态），是另一批的事。
 *
 * ## 键盘导航按 DOM 查，不做登记表
 *
 * 按下方向键时现查一遍 `[role="menuitem"]`，而不是让每个 item 在挂载时
 * 往容器里登记自己。登记表要处理 v-for 重排、v-if 增删、以及登记顺序
 * 和 DOM 顺序不一致的情况 —— 那几个坑都不值得踩，DOM 本身就是唯一真相。
 *
 * 支持 ↑↓ 移动、Home/End 跳两端、Enter/Space 触发、Esc 交给外面的 dropdown 关闭。
 */
import { computed, provide, ref } from 'vue'

import { MENU_SELECTED_KEYS } from './AppMenu.keys'

interface Props {
  /** 当前选中的项。排序菜单这类「当前是哪一档」要靠它把选中项标出来 */
  selectedKeys?: (string | number)[]
}

const props = withDefaults(defineProps<Props>(), { selectedKeys: () => [] })

/**
 * 选中状态用 provide 往下传，而不是让 AppMenu 去改子节点的 vnode。
 * 改 vnode 那条路（antd 的做法）碰到 v-for / v-if / 再包一层就失灵。
 */
provide(
  MENU_SELECTED_KEYS,
  computed(() => props.selectedKeys.map(String))
)

const emit = defineEmits<{
  /** 和 a-menu 保持一致：回调拿到的是 `{ key }`，迁移时调用点不用改 */
  (e: 'click', info: { key: string }): void
}>()

const menuRef = ref<HTMLElement | null>(null)

function items(): HTMLElement[] {
  const root = menuRef.value
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
    (el) => el.getAttribute('aria-disabled') !== 'true'
  )
}

function move(step: number): void {
  const list = items()
  if (list.length === 0) return
  const current = list.indexOf(document.activeElement as HTMLElement)
  // 还没聚在任何一项上时，↓ 从第一项开始、↑ 从最后一项开始
  const next =
    current === -1 ? (step > 0 ? 0 : list.length - 1) : (current + step + list.length) % list.length
  list[next]?.focus()
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      break
    case 'Home':
      event.preventDefault()
      items()[0]?.focus()
      break
    case 'End': {
      event.preventDefault()
      const list = items()
      list[list.length - 1]?.focus()
      break
    }
    default:
      break
  }
}

/** 子项点击时冒泡上来的自定义事件，转成和 a-menu 一样的 `{ key }` */
function onItemActivate(event: Event): void {
  const key = (event as CustomEvent<{ key: string }>).detail?.key
  if (key !== undefined) emit('click', { key })
}

/** 打开时让容器先拿到焦点，方向键才有地方接 */
function focusFirst(): void {
  items()[0]?.focus()
}

defineExpose({ focusFirst })
</script>

<template>
  <ul
    ref="menuRef"
    class="app-menu"
    role="menu"
    tabindex="-1"
    @keydown="onKeydown"
    @app-menu-item-activate="onItemActivate"
  >
    <slot />
  </ul>
</template>

<style scoped>
.app-menu {
  min-width: 160px;
  margin: 0;
  padding: var(--space-1);
  list-style: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-menu);
  outline: none;
}
</style>
