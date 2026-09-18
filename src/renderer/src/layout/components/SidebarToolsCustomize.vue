<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppModal from '@renderer/components/AppModal.vue'
import { PhDotsSixVertical } from '@phosphor-icons/vue'
import { useI18n } from 'vue-i18n'
import type { MenuItem } from '@renderer/common/routeUtils'
import type { SidebarToolsPrefs } from '../composables/sidebarTools'

interface Props {
  open: boolean
  /** 全部可选工具，按侧边栏当前显示顺序传入 */
  items: MenuItem[]
  /** 常驻显示的工具 key */
  pinnedKeys: string[]
}

interface Emits {
  (e: 'update:open', open: boolean): void
  (e: 'save', prefs: SidebarToolsPrefs): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()
const { t } = useI18n()

// 草稿：打开时从侧边栏当前状态拷一份，「完成」才提交，关窗即丢弃
const draftOrder = ref<string[]>([])
const draftPinned = ref<string[]>([])

watch(
  () => props.open,
  (open) => {
    if (!open) return
    draftOrder.value = props.items.map((i) => i.key)
    draftPinned.value = [...props.pinnedKeys]
  },
  { immediate: true }
)

const orderedItems = computed(() =>
  draftOrder.value
    .map((key) => props.items.find((i) => i.key === key))
    .filter((item): item is MenuItem => Boolean(item))
)

const isChecked = (key: string): boolean => draftPinned.value.includes(key)

const togglePinned = (key: string, checked: boolean): void => {
  draftPinned.value = checked
    ? [...draftPinned.value, key]
    : draftPinned.value.filter((k) => k !== key)
}

const listRef = ref<HTMLElement | null>(null)
let dragFromIndex = -1
// 拖拽正悬停在哪一行上 —— 驱动其他行「挤开让位」的动画并记录最终落点
const dragOverIndex = ref(-1)
const dragOffsetY = ref(0)
const isDragging = ref(false)
let dragStartY = 0
let activePointerId = -1

const dragTargetIndex = (clientY: number): number => {
  const list = listRef.value
  if (!list) return -1
  const rows = Array.from(list.querySelectorAll<HTMLElement>('.customize-row'))
  if (rows.length === 0) return -1

  const rowHeight = rows[0].getBoundingClientRect().height || rows[0].offsetHeight
  const gap = Number.parseFloat(getComputedStyle(list).rowGap || '0')
  const step = rowHeight + (Number.isFinite(gap) ? gap : 0)
  if (step <= 0) return -1

  // 行本身会通过 transform 让位，因此始终按列表的固定槽位计算落点。
  const pointerY = clientY - list.getBoundingClientRect().top + list.scrollTop
  return Math.min(rows.length - 1, Math.max(0, Math.floor(pointerY / step)))
}

const finishDrag = (index: number): void => {
  if (dragFromIndex >= 0 && index >= 0 && dragFromIndex !== index) {
    const next = [...draftOrder.value]
    const [moved] = next.splice(dragFromIndex, 1)
    next.splice(index, 0, moved)
    draftOrder.value = next
  }
  endDrag()
}

function removePointerListeners(): void {
  window.removeEventListener('pointermove', handlePointerMove)
  window.removeEventListener('pointerup', handlePointerUp)
  window.removeEventListener('pointercancel', handlePointerCancel)
}

function handlePointerMove(event: PointerEvent): void {
  if (dragFromIndex < 0 || event.pointerId !== activePointerId) return
  event.preventDefault()
  const offset = event.clientY - dragStartY
  if (!isDragging.value && Math.abs(offset) < 4) return

  isDragging.value = true
  dragOffsetY.value = offset
  const targetIndex = dragTargetIndex(event.clientY)
  if (targetIndex >= 0) dragOverIndex.value = targetIndex
}

function handlePointerUp(event: PointerEvent): void {
  if (dragFromIndex < 0 || event.pointerId !== activePointerId) return
  if (isDragging.value) finishDrag(dragOverIndex.value)
  else endDrag()
}

function handlePointerCancel(event: PointerEvent): void {
  if (event.pointerId !== activePointerId) return
  endDrag()
}

const handlePointerDown = (event: PointerEvent, index: number): void => {
  if (event.button !== 0) return
  event.preventDefault()
  endDrag()

  dragFromIndex = index
  dragStartY = event.clientY
  activePointerId = event.pointerId
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handlePointerCancel)
}

const endDrag = (): void => {
  removePointerListeners()
  dragFromIndex = -1
  dragOverIndex.value = -1
  dragOffsetY.value = 0
  isDragging.value = false
  activePointerId = -1
}

onBeforeUnmount(endDrag)

/**
 * 每行该「让」几个身位：被拖的行向下经过时，途经的行往上挪一格补位；
 * 向上拖则反过来。0 表示不动。
 */
const rowShift = (index: number): number => {
  const over = dragOverIndex.value
  if (dragFromIndex < 0 || over < 0 || index === dragFromIndex) return 0
  if (dragFromIndex < over) {
    return index > dragFromIndex && index <= over ? -1 : 0
  }
  return index >= over && index < dragFromIndex ? 1 : 0
}

const handleDone = (): void => {
  emit('save', { order: [...draftOrder.value], pinned: [...draftPinned.value] })
  emit('update:open', false)
}
</script>

<template>
  <AppModal
    :open="props.open"
    :width="360"
    :closable="false"
    centered
    class="sidebar-tools-customize"
    @cancel="emit('update:open', false)"
  >
    <div ref="listRef" class="customize-list">
      <div
        v-for="(item, index) in orderedItems"
        :key="item.key"
        class="customize-row"
        :class="{
          'is-dragging': index === dragFromIndex && isDragging,
          'is-drag-over': index === dragOverIndex && index !== dragFromIndex
        }"
        :style="{
          '--row-shift': String(rowShift(index)),
          '--drag-offset': index === dragFromIndex && isDragging ? `${dragOffsetY}px` : '0px'
        }"
      >
        <span class="drag-handle" @pointerdown.stop="handlePointerDown($event, index)">
          <PhDotsSixVertical />
        </span>
        <span class="row-content">
          <AppCheckbox
            :checked="isChecked(item.key)"
            @change="(checked: boolean) => togglePinned(item.key, checked)"
          >
            <component :is="item.icon" v-if="item.icon" class="row-icon" />
            <span>{{ item.label }}</span>
          </AppCheckbox>
        </span>
      </div>
    </div>

    <template #footer>
      <AppButton variant="primary" class="customize-done" @click="handleDone">
        <span>{{ t('sidebarTools.done') }}</span>
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped lang="less">
.customize-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 50vh;
  overflow-y: auto;
}

.customize-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: var(--space-8);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  transform: translateY(calc(var(--drag-offset, 0px) + var(--row-shift, 0) * (100% + 2px)));
  transition:
    transform 0.2s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.2s ease,
    background-color 0.2s ease;

  &.is-dragging {
    z-index: 1;
    opacity: 0.55;
  }

  &.is-drag-over {
    background: var(--color-bg-surface-hover);
  }

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  :deep(.app-checkbox) {
    display: inline-flex;
    align-items: center;
    color: var(--color-text-primary);

    // 图标与文字的间距全由 .row-icon 的 margin 控制；
    // ant 默认给 `.app-checkbox__box + span`（正好是图标）注入 margin-left，
    // 与 flex gap 叠加后忽远忽近，先归零
    .app-checkbox__box + .row-icon {
      margin-left: 0;
    }

    svg.row-icon {
      font-size: var(--font-size-sm);
      color: var(--color-text-secondary);
    }
  }
}

.row-content {
  display: inline-flex;
  align-items: center;
  flex: 1;
}

.drag-handle {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: var(--space-4);
  height: 100%;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  cursor: grab;
  touch-action: none;
  user-select: none;

  :deep(svg) {
    pointer-events: none;
  }
}

.row-icon {
  margin: 0 var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}
</style>
