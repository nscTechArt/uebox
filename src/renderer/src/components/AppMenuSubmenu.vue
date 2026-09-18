<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'

const open = ref(false)
const opensLeft = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const popupRef = ref<HTMLElement | null>(null)

async function show(): Promise<void> {
  open.value = true
  await nextTick()

  const root = rootRef.value
  const popup = popupRef.value
  if (!root || !popup) return

  const rootRect = root.getBoundingClientRect()
  const popupWidth = popup.getBoundingClientRect().width
  const roomOnRight = window.innerWidth - rootRect.right
  const roomOnLeft = rootRect.left
  opensLeft.value = roomOnRight < popupWidth + 8 && roomOnLeft > roomOnRight
}

function hide(): void {
  open.value = false
}

function toggle(): void {
  if (open.value) hide()
  else void show()
}

async function focusFirstItem(): Promise<void> {
  await show()
  popupRef.value?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    event.stopPropagation()
    void focusFirstItem()
  } else if (event.key === 'ArrowLeft' || event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    hide()
  }
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (!next || !rootRef.value?.contains(next)) hide()
}

onBeforeUnmount(hide)
</script>

<template>
  <li
    ref="rootRef"
    class="app-menu-submenu"
    :class="{ 'app-menu-submenu--open': open, 'app-menu-submenu--left': opensLeft }"
    role="none"
    @mouseenter="show"
    @mouseleave="hide"
    @focusout="onFocusOut"
  >
    <div
      class="app-menu-submenu__trigger"
      role="menuitem"
      aria-haspopup="menu"
      :aria-expanded="open"
      tabindex="0"
      @click.stop="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="app-menu-submenu__title"><slot name="title" /></span>
      <span class="app-menu-submenu__arrow" aria-hidden="true" />
    </div>

    <ul v-if="open" ref="popupRef" class="app-menu-submenu__popup" role="menu">
      <slot />
    </ul>
  </li>
</template>

<style scoped>
.app-menu-submenu {
  position: relative;
}

.app-menu-submenu__trigger {
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

.app-menu-submenu__trigger:hover,
.app-menu-submenu__trigger:focus-visible,
.app-menu-submenu--open > .app-menu-submenu__trigger {
  background: var(--color-bg-surface-hover);
}

.app-menu-submenu__title {
  flex: 1;
  min-width: 0;
}

.app-menu-submenu__arrow {
  flex: none;
  width: 7px;
  height: 7px;
  margin-inline: var(--space-1);
  border-top: 1.5px solid currentcolor;
  border-right: 1.5px solid currentcolor;
  transform: rotate(45deg);
}

.app-menu-submenu__popup {
  position: absolute;
  top: calc(0px - var(--space-1));
  left: calc(100% + var(--space-1));
  z-index: 1;
  min-width: 160px;
  margin: 0;
  padding: var(--space-1);
  list-style: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-menu);
}

.app-menu-submenu--left > .app-menu-submenu__trigger .app-menu-submenu__arrow {
  transform: rotate(-135deg);
}

.app-menu-submenu--left > .app-menu-submenu__popup {
  right: calc(100% + var(--space-1));
  left: auto;
}
</style>
