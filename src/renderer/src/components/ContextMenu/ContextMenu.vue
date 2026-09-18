<template>
  <teleport to="body">
    <AppDropdown
      v-model:open="visible"
      :trigger="[]"
      placement="bottomLeft"
      :overlay-style="{ zIndex: 100000 }"
    >
      <div
        class="context-menu-target"
        :style="{
          position: 'fixed',
          left: position.x + 'px',
          top: position.y + 'px',
          width: '1px',
          height: '1px',
          pointerEvents: 'none',
          zIndex: 9999
        }"
      />
      <template #overlay>
        <AppMenu class="context-menu" :style="menuStyle" @click="handleMenuClick">
          <template v-for="(item, index) in menuItems" :key="item.key || index">
            <AppMenuDivider v-if="item.type === 'divider'" />
            <AppMenuItem
              v-else
              :key="item.key"
              :item-key="item.key"
              :class="[item.className, { 'danger-item': item.danger }]"
              :disabled="item.disabled"
              :style="getItemStyle(item)"
            >
              <template v-if="item.icon" #icon>
                <component :is="item.icon" />
              </template>
              <span class="menu-item-content">
                <span class="menu-item-label">{{ item.label }}</span>
                <span v-if="item.shortcut" class="menu-item-shortcut">{{
                  formatShortcut(item.shortcut)
                }}</span>
              </span>
            </AppMenuItem>
          </template>
        </AppMenu>
      </template>
    </AppDropdown>
  </teleport>
</template>

<script setup lang="ts">
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuDivider from '@renderer/components/AppMenuDivider.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import { ref, reactive, computed, onMounted, onUnmounted, readonly } from 'vue'
import { useContextMenuManager } from '@renderer/hooks/useContextMenuManager'
import type { MenuItem } from './types'
import { acceleratorKeyLabels } from '@renderer/utils/accelerator'

function formatShortcut(shortcut: string): string {
  return acceleratorKeyLabels(shortcut, window.api?.platform ?? 'win32').join('+')
}

/**
 * 上下文菜单项定义
 * 注意：分隔线项（type: 'divider'）不需要提供 key，因此将 key 设为可选。
 */

interface Props {
  menuItems: MenuItem[]
  backgroundColor?: string
  textColor?: string
  borderColor?: string
  hoverBackgroundColor?: string
  hoverTextColor?: string
}

interface Emits {
  (e: 'click', key: string, item: MenuItem): void
  (e: 'visible-change', visible: boolean): void
}

const props = withDefaults(defineProps<Props>(), {
  backgroundColor: 'var(--color-bg-page)',
  textColor: 'var(--color-text-primary)',
  borderColor: 'var(--color-border-subtle)',
  hoverBackgroundColor: 'var(--color-accent-bg-hover)',
  hoverTextColor: 'var(--color-accent-solid-hover)'
})

const emit = defineEmits<Emits>()

// 使用全局ContextMenu管理器
const { menuId, registerMenu, unregisterMenu, showMenu, hideMenu } = useContextMenuManager()

const visible = ref(false)
const position = reactive({ x: 0, y: 0 })

// 获取弹出容器
// 菜单样式
const menuStyle = computed(() => ({
  backgroundColor: props.backgroundColor,
  color: props.textColor,
  borderColor: props.borderColor
}))

// 获取菜单项样式
const getItemStyle = (item: MenuItem) => {
  const style: any = {}
  if (item.backgroundColor) {
    style.backgroundColor = item.backgroundColor
  }
  if (item.textColor) {
    style.color = item.textColor
  }
  return style
}

// 显示菜单
const show = (x: number, y: number) => {
  // 通知全局管理器显示此菜单（会自动隐藏其他菜单）
  showMenu()

  // 如果菜单已经显示，立即隐藏并重新显示
  if (visible.value) {
    visible.value = false
  }

  // 使用 setTimeout 确保位置更新和显示的时序
  setTimeout(() => {
    // 添加水平偏移量，避免菜单与触发元素重叠
    position.x = x + 8
    position.y = y
    visible.value = true
    emit('visible-change', true)
  }, 10)
}

// 隐藏菜单
const hide = () => {
  visible.value = false
  hideMenu() // 通知全局管理器此菜单已隐藏
  emit('visible-change', false)
}

// 处理菜单点击
const handleMenuClick = ({ key }: { key: string }) => {
  const item = props.menuItems.find((item) => item.key === key)
  if (item) {
    emit('click', key, item)
  }
  hide()
}

/**
 * 点击外部区域关闭菜单。
 *
 * 判断「在不在菜单里」认的是浮层的类名。迁到 AppDropdown 之后浮层是
 * `.app-dropdown` 而不是 `.app-dropdown` —— 名字没跟着改的话这个判断恒为
 * 「在外面」，于是**点菜单项本身也会先把菜单关掉**，表现就是右键菜单点了没反应。
 */
const handleClickOutside = (event: MouseEvent) => {
  const target = event.target as HTMLElement
  if (!target.closest('.app-dropdown') && !target.closest('.context-menu-target')) {
    hide()
  }
}

// 处理右键事件，确保新右键时隐藏当前菜单
const handleGlobalRightClick = (event: MouseEvent) => {
  // 延迟处理，让组件内部的右键事件先执行
  setTimeout(() => {
    // 检查右键点击是否在菜单内部
    const target = event.target as HTMLElement
    if (target.closest('.app-dropdown') || target.closest('.context-menu-target')) {
      return
    }

    // 如果右键点击在菜单外部且菜单已显示，隐藏菜单
    if (visible.value) {
      hide()
    }
  }, 0)
}

// 生命周期钩子
onMounted(() => {
  // 注册菜单实例到全局管理器
  registerMenu({ hide })

  document.addEventListener('click', handleClickOutside)
  document.addEventListener('contextmenu', handleGlobalRightClick)
})

onUnmounted(() => {
  // 从全局管理器注销菜单实例
  unregisterMenu()

  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('contextmenu', handleGlobalRightClick)
})

// 暴露方法
defineExpose({
  show,
  hide,
  visible: readonly(visible),
  menuId: readonly(menuId)
})
</script>

<style lang="less" scoped>
.context-menu-target {
  /* 保持目标点在最高层级，辅助浮层定位 */
  z-index: 10000;
}

.context-menu {
  min-width: 220px;
  border-radius: 10px;
  box-shadow: 0 12px 32px -4px var(--shadow-color);
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface) !important;
  padding: 6px !important;
  overflow: hidden;

  :deep(.app-menu-item) {
    height: auto;
    line-height: normal;
    padding: 8px 12px;
    margin: 2px 0;
    border-radius: 6px;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    color: var(--color-text-primary);
    background: transparent !important;

    &:hover:not(.app-menu-item--disabled) {
      background: var(--color-bg-surface-hover) !important;
      color: var(--color-text-primary) !important;
      transform: translateX(2px);
    }

    &.app-menu-item--selected {
      background: var(--color-bg-selected) !important;
      color: var(--color-text-selected);
    }

    &.danger-item {
      color: var(--color-danger-text);
      svg {
        color: var(--color-danger-text);
      }
      &:hover:not(.app-menu-item--disabled) {
        background: var(--color-danger-bg) !important;
        color: var(--color-danger-text);
      }
    }

    svg {
      margin-right: 12px;
      font-size: 14px;
      opacity: 0.9;
    }
  }

  .menu-item-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    gap: 24px;
  }
  .menu-item-label {
    flex: 1;
    font-size: 13px;
    font-weight: 500;
  }

  .menu-item-shortcut {
    font-size: 11px;
    opacity: 0.45;
    padding-right: 4px;
    font-family: var(--font-mono, monospace);
  }
  :deep(.app-menu-divider) {
    margin: 6px 0;
    background: var(--color-bg-surface-hover);
  }
}
</style>
