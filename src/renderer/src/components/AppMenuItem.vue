<script setup lang="ts">
/**
 * 菜单项。接替 ant-design-vue 的 `<a-menu-item>`（58 处）。
 *
 * ## 为什么要 `item-key` 而不是直接用 `key`
 *
 * antd 的 Menu 是去翻子节点的 vnode 把 `key` 读出来的。`key` 在 Vue 里是
 * 保留属性，组件内部拿不到 —— 所以这里显式收一个 `item-key`。
 * 迁移时两个都留着：`key` 归 Vue 做列表 diff，`item-key` 归菜单认身份。
 *
 * 点击时往上抛一个自定义事件，由 [AppMenu.vue] 接住转成 `{ key }`，
 * 和 `<a-menu @click>` 的回调形状一致，调用点不用改。
 */
import { computed, inject } from 'vue'

import { MENU_SELECTED_KEYS } from './AppMenu.keys'

interface Props {
  itemKey?: string | number
  disabled?: boolean
  /** 危险动作（删除之类），文字转红 */
  danger?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  itemKey: undefined,
  disabled: false,
  danger: false
})

const emit = defineEmits<{ (e: 'click', event: MouseEvent | KeyboardEvent): void }>()

const selectedKeys = inject(MENU_SELECTED_KEYS, undefined)
const selected = computed(
  () => props.itemKey !== undefined && Boolean(selectedKeys?.value.includes(String(props.itemKey)))
)

function activate(event: MouseEvent | KeyboardEvent): void {
  if (props.disabled) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  emit('click', event)
  if (props.itemKey !== undefined) {
    // 冒泡给 AppMenu，让它发出和 a-menu 一样的 { key }
    ;(event.currentTarget as HTMLElement).dispatchEvent(
      new CustomEvent('app-menu-item-activate', {
        detail: { key: String(props.itemKey) },
        bubbles: true
      })
    )
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  activate(event)
}
</script>

<template>
  <li
    class="app-menu-item"
    :class="{
      'app-menu-item--disabled': disabled,
      'app-menu-item--danger': danger,
      'app-menu-item--selected': selected
    }"
    role="menuitem"
    :aria-current="selected ? 'true' : undefined"
    :tabindex="disabled ? -1 : 0"
    :aria-disabled="disabled ? 'true' : undefined"
    @click="activate"
    @keydown="onKeydown"
  >
    <!-- a-menu-item 有 #icon 插槽，共享右键菜单（ContextMenu.vue）一直在用它。
         漏掉的话菜单项前面的图标会静静消失，不报任何错。 -->
    <span v-if="$slots.icon" class="app-menu-item__icon">
      <slot name="icon" />
    </span>
    <slot />
  </li>
</template>

<style scoped>
.app-menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-xs);
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
  outline: none;
}

/* 鼠标悬停和键盘聚焦长一个样 —— 两种操作方式看到的「当前这一项」应该一致 */
.app-menu-item:hover,
.app-menu-item:focus-visible {
  background: var(--color-bg-surface-hover);
}

.app-menu-item--danger {
  color: var(--color-danger-text);
}

.app-menu-item--danger:hover,
.app-menu-item--danger:focus-visible {
  background: var(--color-danger-bg);
}

.app-menu-item--disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

.app-menu-item--disabled:hover {
  background: transparent;
}

/* 选中不能只靠底色：底色和悬停态太像，鼠标划过去就分不清哪个是「当前这档」了。
   再给一条左侧竖线，移开鼠标也看得出来 */
.app-menu-item--selected {
  background: var(--color-bg-selected);
  color: var(--color-text-selected);
  box-shadow: inset 2px 0 0 var(--color-accent-solid);
}

.app-menu-item__icon {
  flex: none;
  display: inline-flex;
  align-items: center;
}

.app-menu-item__icon :deep(svg) {
  display: block;
  width: 16px;
  height: 16px;
}
</style>
