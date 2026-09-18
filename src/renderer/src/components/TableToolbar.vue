<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import type { Editor } from '@tiptap/core'
import {
  PhColumns,
  PhColumnsPlusLeft,
  PhColumnsPlusRight,
  PhRows,
  PhRowsPlusBottom,
  PhRowsPlusTop,
  PhTrash
} from '@phosphor-icons/vue'

interface Props {
  editor?: Editor | null
}

const props = defineProps<Props>()
const toolbarRef = ref<HTMLElement | null>(null)
const visible = ref(false)
const position = ref({ top: 0, left: 0 })

/**
 * 更新工具栏位置
 */
const updatePosition = (): void => {
  if (!props.editor || !visible.value) return

  const { view } = props.editor
  const { state } = view
  const { selection } = state

  // 获取表格节点的位置
  const domAtPos = view.domAtPos(selection.from)
  const tableElement = domAtPos.node?.parentElement?.closest('table')

  if (tableElement) {
    const tableRect = tableElement.getBoundingClientRect()
    const editorRect = view.dom.getBoundingClientRect()

    // 定位在表格右上角
    position.value = {
      top: tableRect.top - editorRect.top - 40,
      left: tableRect.right - editorRect.left - 200
    }
  }
}

/**
 * 检查光标是否在表格内
 */
const checkTableActive = (): void => {
  if (!props.editor) {
    visible.value = false
    return
  }

  const isInTable = props.editor.isActive('table')
  visible.value = isInTable

  if (isInTable) {
    nextTick(() => {
      updatePosition()
    })
  }
}

// 表格操作方法
const deleteTable = (): void => {
  props.editor?.chain().focus().deleteTable().run()
}

const addRowBefore = (): void => {
  props.editor?.chain().focus().addRowBefore().run()
}

const addRowAfter = (): void => {
  props.editor?.chain().focus().addRowAfter().run()
}

const deleteRow = (): void => {
  props.editor?.chain().focus().deleteRow().run()
}

const addColumnBefore = (): void => {
  props.editor?.chain().focus().addColumnBefore().run()
}

const addColumnAfter = (): void => {
  props.editor?.chain().focus().addColumnAfter().run()
}

const deleteColumn = (): void => {
  props.editor?.chain().focus().deleteColumn().run()
}

// 监听编辑器选择变化
watch(
  () => props.editor?.state.selection,
  () => {
    checkTableActive()
  },
  { deep: true }
)

// 监听编辑器变化（切换页面时 editor 可能变为 null）
watch(
  () => props.editor,
  (newEditor) => {
    if (!newEditor) {
      visible.value = false
    }
  }
)

/**
 * 处理编辑器失去焦点
 */
const handleBlur = (): void => {
  // 延迟隐藏，避免点击工具栏按钮时立即隐藏
  setTimeout(() => {
    if (!props.editor?.isFocused) {
      visible.value = false
    }
  }, 200)
}

onMounted(() => {
  if (props.editor) {
    props.editor.on('selectionUpdate', checkTableActive)
    props.editor.on('focus', checkTableActive)
    props.editor.on('blur', handleBlur)
  }
})

onBeforeUnmount(() => {
  // 确保组件卸载时隐藏工具栏
  visible.value = false

  if (props.editor) {
    props.editor.off('selectionUpdate', checkTableActive)
    props.editor.off('focus', checkTableActive)
    props.editor.off('blur', handleBlur)
  }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="visible && editor" ref="toolbarRef" class="table-toolbar">
      <div class="toolbar-group">
        <button class="toolbar-btn" :title="$t('tableToolbar.rowAbove')" @click="addRowBefore">
          <PhRowsPlusTop />
        </button>
        <button class="toolbar-btn" :title="$t('tableToolbar.rowBelow')" @click="addRowAfter">
          <PhRowsPlusBottom />
        </button>
        <button class="toolbar-btn" :title="$t('tableToolbar.deleteRow')" @click="deleteRow">
          <PhRows />
        </button>
      </div>
      <div class="toolbar-divider"></div>
      <div class="toolbar-group">
        <button class="toolbar-btn" :title="$t('tableToolbar.columnLeft')" @click="addColumnBefore">
          <PhColumnsPlusLeft />
        </button>
        <button class="toolbar-btn" :title="$t('tableToolbar.columnRight')" @click="addColumnAfter">
          <PhColumnsPlusRight />
        </button>
        <button class="toolbar-btn" :title="$t('tableToolbar.deleteColumn')" @click="deleteColumn">
          <PhColumns />
        </button>
      </div>
      <div class="toolbar-divider"></div>
      <button
        class="toolbar-btn danger"
        :title="$t('tableToolbar.deleteTableTitle')"
        @click="deleteTable"
      >
        <PhTrash />
        <span>{{ $t('tableToolbar.deleteTableLabel') }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped lang="less">
.table-toolbar {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  background: var(--color-bg-surface);
  backdrop-filter: blur(20px);
  border: 1px solid var(--color-border-subtle);
  border-radius: 10px;
  box-shadow: 0 12px 40px var(--shadow-color-strong);
  z-index: 10000;

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .toolbar-divider {
    width: 1px;
    height: 20px;
    background: var(--color-bg-surface-hover);
    margin: 0 6px;
  }

  .toolbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 32px;
    min-width: 32px;
    padding: 0 8px;
    border: none;
    background: transparent;
    color: var(--color-text-primary);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 14px;

    &:hover {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
    }

    &.danger {
      color: var(--color-danger-text);
      padding: 0 12px;

      &:hover {
        background: var(--color-danger-bg);
        color: var(--color-danger-text);
      }
    }

    :deep(svg) {
      font-size: 15px;
    }

    span {
      font-size: 13px;
      font-weight: 500;
    }
  }
}
</style>
