<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Editor, Range } from '@tiptap/core'

/**
 * Notion 风格的斜杠命令菜单组件
 * 支持键盘导航、命令搜索和快速插入内容块
 */

const { t } = useI18n()

interface CommandItem {
  title: string
  description: string
  icon: string
  command: (props: { editor: Editor; range: Range }) => void
  searchTerms?: string[]
}

interface Props {
  editor: Editor
  range: Range
  query: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'select', item: CommandItem): void
}>()

// 选中的命令索引
const selectedIndex = ref(0)

/**
 * 定义所有可用的斜杠命令（使用 computed 支持动态翻译）
 */
const commands = computed<CommandItem[]>(() => [
  {
    title: t('noteEditor.commands.heading1.title'),
    description: t('noteEditor.commands.heading1.description'),
    icon: '📰',
    searchTerms: ['h1', 'heading', 'title', 'biaoti'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run()
    }
  },
  {
    title: t('noteEditor.commands.heading2.title'),
    description: t('noteEditor.commands.heading2.description'),
    icon: '📄',
    searchTerms: ['h2', 'heading', 'subtitle', 'biaoti'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run()
    }
  },
  {
    title: t('noteEditor.commands.heading3.title'),
    description: t('noteEditor.commands.heading3.description'),
    icon: '📃',
    searchTerms: ['h3', 'heading', 'biaoti'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run()
    }
  },
  {
    title: t('noteEditor.commands.bulletList.title'),
    description: t('noteEditor.commands.bulletList.description'),
    icon: '•',
    searchTerms: ['ul', 'list', 'bullet', 'liebiao'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run()
    }
  },
  {
    title: t('noteEditor.commands.orderedList.title'),
    description: t('noteEditor.commands.orderedList.description'),
    icon: '1.',
    searchTerms: ['ol', 'list', 'number', 'liebiao'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run()
    }
  },
  {
    title: t('noteEditor.commands.todoList.title'),
    description: t('noteEditor.commands.todoList.description'),
    icon: '☑',
    searchTerms: ['todo', 'task', 'checkbox', 'daiban'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run()
    }
  },
  {
    title: t('noteEditor.commands.blockquote.title'),
    description: t('noteEditor.commands.blockquote.description'),
    icon: '❝',
    searchTerms: ['quote', 'blockquote', 'yinyong'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run()
    }
  },
  {
    title: t('noteEditor.commands.codeBlock.title'),
    description: t('noteEditor.commands.codeBlock.description'),
    icon: '</>',
    searchTerms: ['code', 'codeblock', 'daima'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run()
    }
  },
  {
    title: t('noteEditor.commands.table.title'),
    description: t('noteEditor.commands.table.description'),
    icon: '📋',
    searchTerms: ['table', 'biaoge'],
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run()
    }
  },
  {
    title: t('noteEditor.commands.divider.title'),
    description: t('noteEditor.commands.divider.description'),
    icon: '—',
    searchTerms: ['hr', 'divider', 'separator', 'fengexian'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run()
    }
  }
])

/**
 * 根据搜索查询过滤命令
 */
const filteredCommands = computed(() => {
  const query = props.query.toLowerCase().trim()
  if (!query) return commands.value

  return commands.value.filter((cmd) => {
    const titleMatch = cmd.title.toLowerCase().includes(query)
    const descMatch = cmd.description.toLowerCase().includes(query)
    const searchTermsMatch = cmd.searchTerms?.some((term) => term.toLowerCase().includes(query))
    return titleMatch || descMatch || searchTermsMatch
  })
})

/**
 * 当过滤结果变化时重置选中索引
 */
watch(filteredCommands, () => {
  selectedIndex.value = 0
})

/**
 * 向上导航
 */
const navigateUp = (): void => {
  selectedIndex.value =
    selectedIndex.value > 0 ? selectedIndex.value - 1 : filteredCommands.value.length - 1
}

/**
 * 向下导航
 */
const navigateDown = (): void => {
  selectedIndex.value =
    selectedIndex.value < filteredCommands.value.length - 1 ? selectedIndex.value + 1 : 0
}

/**
 * 选择当前命令
 */
const selectCommand = (index?: number): void => {
  const finalIndex = index ?? selectedIndex.value
  const command = filteredCommands.value[finalIndex]
  if (command) {
    // 直接执行命令
    command.command({ editor: props.editor, range: props.range })
  }
}

/**
 * 键盘事件处理
 */
const onKeyDown = (event: KeyboardEvent): boolean => {
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    navigateUp()
    return true
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    navigateDown()
    return true
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    selectCommand()
    return true
  }

  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return true
  }

  return false
}

// 暴露键盘处理方法供父组件调用
defineExpose({
  onKeyDown
})
</script>

<template>
  <div class="slash-command-menu">
    <div v-if="filteredCommands.length === 0" class="no-results">
      <span>{{ t('noteEditor.noResults') }}</span>
    </div>
    <div
      v-for="(item, index) in filteredCommands"
      :key="item.title"
      :class="['menu-item', { selected: index === selectedIndex }]"
      @click="selectCommand(index)"
      @mouseenter="selectedIndex = index"
    >
      <div class="item-icon">{{ item.icon }}</div>
      <div class="item-content">
        <div class="item-title">{{ item.title }}</div>
        <div class="item-description">{{ item.description }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.tippy-box {
  background: transparent !important;
}
.slash-command-menu {
  backdrop-filter: blur(20px);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 8px;
  box-shadow: 0 8px 12px var(--shadow-color-strong);
  min-width: 280px;
  max-height: 400px;
  overflow-y: auto;
  z-index: 1000;

  .no-results {
    padding: 16px;
    text-align: center;
    color: var(--color-text-primary);
    font-size: 14px;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;

    /* 鼠标划过 ≠ 键盘选中，两者不能同色，否则回车执行哪条只能靠猜 */
    &:hover {
      background: var(--color-bg-surface-hover);
    }

    &.selected {
      background: var(--color-bg-selected);
    }

    .item-icon {
      font-size: 20px;
      flex-shrink: 0;
      width: 24px;
      text-align: center;
    }

    .item-content {
      flex: 1;
      min-width: 0;

      .item-title {
        color: var(--color-text-primary);
        font-size: 14px;
        font-weight: 500;
        margin-bottom: 2px;
      }

      .item-description {
        color: var(--color-text-primary);
        font-size: 12px;
      }
    }
  }

  // 自定义滚动条
  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-track {
    background: var(--color-bg-surface-hover);
    border-radius: 3px;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-accent-solid);
    border-radius: 3px;

    &:hover {
      background: var(--color-accent-solid);
    }
  }
}
</style>
