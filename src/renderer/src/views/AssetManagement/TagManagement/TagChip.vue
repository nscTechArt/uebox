<script setup lang="ts">
/**
 * 标签管理页里的一个标签。
 *
 * 这里没有直接用 AppTag：管理态要塞下星标、用量数字、删除，还要能拖、能就地改名，
 * 那是另一个部件了。但**形状、尺寸、配色档位跟 AppTag 对齐**，两处看着是同一种东西。
 *
 * 一条硬规矩：**任何交互都不许改变这个盒子的尺寸**。
 * 星标常驻（只换颜色）、选中只换底色。
 * 流式排布里但凡有一个标签宽了几像素，后面整片都要重新折行 —— 点一下满屏乱跳。
 *
 * 选中挂在**整个 chip** 上，不是名字那几个字：用量数字、空隙、内边距点上去都算选中。
 * 名字仍是 button，是为了留住键盘焦点和双击改名 —— 键盘回车按下去照样冒泡到 chip 上选中。
 * 星标和改名输入框各自 `.stop`，点它们不会顺手把标签选了。
 *
 * 改名和删除都在**右键菜单**里，chip 上不放。删除是不可逆动作，
 * 常驻一个 ✕ 摆在每个标签右边，等于在最容易手滑的位置放了一排地雷；
 * 而且它占的那几像素乘以几百个标签，就是好几行。
 */
import { nextTick, ref, watch } from 'vue'
import { PhStar } from '@phosphor-icons/vue'
import type { Tag } from './types'

interface Props {
  tag: Tag
  /** 当前保管库里的引用数 */
  usage: number
  selected: boolean
  renaming: boolean
  renameValue: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'select', event: MouseEvent): void
  (e: 'startRename', tag: Tag): void
  (e: 'renameInput', value: string): void
  (e: 'submitRename', id: number): void
  (e: 'cancelRename'): void
  (e: 'toggleFavorite', tag: Tag): void
  (e: 'contextmenu', event: MouseEvent): void
  (e: 'dragstart', event: DragEvent): void
  (e: 'dragend'): void
}>()

const inputEl = ref<HTMLInputElement | null>(null)
/** Esc 取消后 blur 还会再触发一次，用它挡掉那次提交 */
const cancelled = ref(false)

watch(
  () => props.renaming,
  async (on) => {
    if (!on) return
    cancelled.value = false
    await nextTick()
    inputEl.value?.focus()
    inputEl.value?.select()
  }
)

const handleBlur = (): void => {
  if (cancelled.value || !props.tag.id) return
  emit('submitRename', props.tag.id)
}

const handleCancel = (): void => {
  cancelled.value = true
  emit('cancelRename')
}
</script>

<template>
  <span
    class="tag-chip"
    :class="{ 'tag-chip--selected': selected, 'tag-chip--unused': usage === 0 }"
    :draggable="!renaming"
    @click="!renaming && emit('select', $event)"
    @contextmenu.prevent.stop="emit('contextmenu', $event)"
    @dragstart="emit('dragstart', $event)"
    @dragend="emit('dragend')"
  >
    <button
      type="button"
      class="tag-chip__star"
      :class="{ 'tag-chip__star--on': tag.is_favorite }"
      :title="
        tag.is_favorite
          ? $t('tagDisplay.actions.unsetFavorite')
          : $t('tagDisplay.actions.setFavorite')
      "
      :aria-label="
        tag.is_favorite
          ? $t('tagDisplay.actions.unsetFavorite')
          : $t('tagDisplay.actions.setFavorite')
      "
      :aria-pressed="!!tag.is_favorite"
      @click.stop="emit('toggleFavorite', tag)"
    >
      <PhStar :weight="tag.is_favorite ? 'fill' : 'regular'" />
    </button>

    <input
      v-if="renaming"
      ref="inputEl"
      class="tag-chip__input"
      type="text"
      :value="renameValue"
      :placeholder="$t('tagDisplay.renamePlaceholder')"
      @input="emit('renameInput', ($event.target as HTMLInputElement).value)"
      @keydown.enter="tag.id && emit('submitRename', tag.id)"
      @keydown.esc="handleCancel"
      @blur="handleBlur"
      @click.stop
    />
    <button
      v-else
      type="button"
      class="tag-chip__name"
      :title="tag.name"
      @dblclick.stop="emit('startRename', tag)"
    >
      {{ tag.name }}
    </button>

    <span
      class="tag-chip__usage"
      :title="
        usage === 0 ? $t('tagDisplay.unusedTitle') : $t('tagDisplay.usageTitle', { count: usage })
      "
      >{{ usage }}</span
    >
  </span>
</template>

<style scoped>
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  max-width: 100%;
  padding: 0 7px 0 5px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xs);
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: grab;
  -webkit-user-drag: element;
}

.tag-chip:hover {
  border-color: var(--color-border-strong);
  color: var(--color-text-primary);
}

.tag-chip:active {
  cursor: grabbing;
}

/* 本库一次都没用过：虚线边，和「有内容」的标签区分开，但不用报警色吓人 */
.tag-chip--unused {
  border-style: dashed;
  color: var(--color-text-muted);
}

/* 选中只换底色，盒子一个像素都不动 */
.tag-chip--selected,
.tag-chip--selected:hover {
  border-style: solid;
  border-color: var(--color-accent-solid);
  background: var(--color-accent-solid);
  color: var(--color-text-on-solid);
}

.tag-chip__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font-family: inherit;
  font-size: inherit;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: inherit;
}

.tag-chip__input {
  width: 110px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid var(--color-border-focus);
  border-radius: 2px;
  background: var(--color-bg-page);
  color: var(--color-text-primary);
  font-family: inherit;
  font-size: inherit;
  outline: none;
}

.tag-chip__usage {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
}

.tag-chip--selected .tag-chip__usage {
  color: var(--color-text-on-solid);
  opacity: 0.75;
}

.tag-chip__star {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 2px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}

/*
 * 星标**常驻**，不做 hover 才出现。
 * 一是出现/消失会改宽度；二是 opacity:0 的按钮照样能 Tab 聚焦、照样能回车按下去，
 * 键盘用户会停在一个看不见的按钮上。
 */
.tag-chip__star {
  color: var(--color-border-strong);
}

.tag-chip__star--on {
  color: var(--color-warning-text);
}

.tag-chip--selected .tag-chip__star {
  color: var(--color-text-on-solid);
  opacity: 0.7;
}

.tag-chip--selected .tag-chip__star--on {
  color: var(--color-warning-text);
  opacity: 1;
}

.tag-chip__name:focus-visible,
.tag-chip__star:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 1px;
}
</style>
