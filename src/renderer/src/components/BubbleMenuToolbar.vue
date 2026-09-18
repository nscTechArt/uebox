<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, nextTick } from 'vue'
import { BubbleMenuPlugin } from '@tiptap/extension-bubble-menu'
import type { Editor } from '@tiptap/core'
import { Input } from 'ant-design-vue'
import {
  PhCheck,
  PhCode,
  PhHighlighter,
  PhLink,
  PhListBullets,
  PhListNumbers,
  PhTextB,
  PhTextItalic,
  PhTextStrikethrough,
  PhTextUnderline,
  PhX
} from '@phosphor-icons/vue'

interface Props {
  editor?: Editor | null
}

const props = defineProps<Props>()
const element = ref<HTMLElement | null>(null)
const linkInputRef = ref<HTMLElement | null>(null)
const linkInputSelection = ref<any>(null)

// 链接编辑状态
const showLinkInput = ref(false)
const linkUrl = ref('')

/**
 * 开始添加/编辑链接
 */
const startEditLink = (): void => {
  if (!props.editor) return

  const previousUrl = props.editor.getAttributes('link').href
  linkUrl.value = previousUrl || ''
  linkInputSelection.value = props.editor.state.selection
  showLinkInput.value = true

  // 自动聚焦输入框
  nextTick(() => {
    linkInputRef.value?.focus()
  })
}

/**
 * 确认添加链接
 */
const confirmLink = (): void => {
  if (!props.editor) return

  const url = linkUrl.value

  // empty
  if (url === '') {
    props.editor.chain().focus().extendMarkRange('link').unsetLink().run()
  } else {
    // update link
    props.editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  showLinkInput.value = false
  linkUrl.value = ''
}

/**
 * 取消添加链接
 */
const cancelLink = (): void => {
  showLinkInput.value = false
  linkUrl.value = ''
  // 恢复焦点到编辑器
  props.editor?.chain().focus().run()
}

/**
 * 设置标题级别
 */
const setHeading = (level: 1 | 2 | 3): void => {
  if (!props.editor) return
  props.editor.chain().focus().toggleHeading({ level }).run()
}

/**
 * 检查命令是否激活
 */
const isActive = (name: string, attrs = {}): boolean => {
  return props.editor?.isActive(name, attrs) || false
}

onMounted(() => {
  if (!props.editor || !element.value) return

  const plugin = BubbleMenuPlugin({
    pluginKey: 'bubbleMenu',
    editor: props.editor,
    element: element.value,
    tippyOptions: { duration: 100, placement: 'top' },
    shouldShow: ({ editor, state }) => {
      // 默认逻辑：选中文本时显示
      const { selection } = state
      const { empty } = selection

      // 如果正在编辑链接，且选区发生了变化，则重置状态
      if (
        showLinkInput.value &&
        linkInputSelection.value &&
        !selection.eq(linkInputSelection.value)
      ) {
        showLinkInput.value = false
        linkUrl.value = ''
      }

      // 如果选中了 fileAttachment、noteModelViewer 或 image 节点，不显示
      if (
        editor.isActive('fileAttachment') ||
        editor.isActive('noteModelViewer') ||
        editor.isActive('image')
      ) {
        showLinkInput.value = false
        linkUrl.value = ''
        return false
      }

      // 仅在非空选择时显示
      if (empty) {
        showLinkInput.value = false
        linkUrl.value = ''
        return false
      }

      return true
    }
  } as any)

  props.editor.registerPlugin(plugin)
})

onBeforeUnmount(() => {
  props.editor?.unregisterPlugin('bubbleMenu')
})
</script>

<template>
  <div v-if="editor" style="display: none">
    <div ref="element" class="bubble-menu-toolbar">
      <!-- 链接输入模式 -->
      <div v-if="showLinkInput" class="link-input-wrapper">
        <Input
          ref="linkInputRef"
          v-model:value="linkUrl"
          :placeholder="$t('bubbleMenuToolbar.linkInput.placeholder')"
          size="small"
          class="link-input"
          @press-enter="confirmLink"
          @keydown.esc="cancelLink"
        />
        <button
          class="toolbar-button"
          :title="$t('bubbleMenuToolbar.confirmTitle')"
          @click="confirmLink"
        >
          <PhCheck />
        </button>
        <button
          class="toolbar-button"
          :title="$t('bubbleMenuToolbar.cancelTitle')"
          @click="cancelLink"
        >
          <PhX />
        </button>
      </div>

      <!-- 常规工具栏模式 -->
      <template v-else>
        <!-- 标题 -->
        <button
          :class="['toolbar-button', 'text-button', { active: isActive('heading', { level: 1 }) }]"
          :title="$t('bubbleMenuToolbar.heading.level1')"
          @click="setHeading(1)"
        >
          H1
        </button>
        <button
          :class="['toolbar-button', 'text-button', { active: isActive('heading', { level: 2 }) }]"
          :title="$t('bubbleMenuToolbar.heading.level2')"
          @click="setHeading(2)"
        >
          H2
        </button>
        <button
          :class="['toolbar-button', 'text-button', { active: isActive('heading', { level: 3 }) }]"
          :title="$t('bubbleMenuToolbar.heading.level3')"
          @click="setHeading(3)"
        >
          H3
        </button>

        <div class="toolbar-divider"></div>

        <!-- 文本格式 -->
        <button
          :class="['toolbar-button', { active: isActive('bold') }]"
          :title="$t('bubbleMenuToolbar.bold')"
          @click="editor?.chain().focus().toggleBold().run()"
        >
          <PhTextB />
        </button>
        <button
          :class="['toolbar-button', { active: isActive('italic') }]"
          :title="$t('bubbleMenuToolbar.italic')"
          @click="editor?.chain().focus().toggleItalic().run()"
        >
          <PhTextItalic />
        </button>
        <button
          :class="['toolbar-button', { active: isActive('underline') }]"
          :title="$t('bubbleMenuToolbar.underline')"
          @click="editor?.chain().focus().toggleUnderline().run()"
        >
          <PhTextUnderline />
        </button>
        <button
          :class="['toolbar-button', { active: isActive('strike') }]"
          :title="$t('bubbleMenuToolbar.strikethrough')"
          @click="editor?.chain().focus().toggleStrike().run()"
        >
          <PhTextStrikethrough />
        </button>
        <button
          :class="['toolbar-button', { active: isActive('code') }]"
          :title="$t('bubbleMenuToolbar.inlineCode')"
          @click="editor?.chain().focus().toggleCode().run()"
        >
          <PhCode />
        </button>
        <button
          :class="['toolbar-button', { active: isActive('highlight') }]"
          :title="$t('bubbleMenuToolbar.highlight')"
          @click="editor?.chain().focus().toggleHighlight().run()"
        >
          <PhHighlighter />
        </button>

        <div class="toolbar-divider"></div>

        <!-- 列表 -->
        <button
          :class="['toolbar-button', { active: isActive('bulletList') }]"
          :title="$t('bubbleMenuToolbar.bulletList')"
          @click="editor?.chain().focus().toggleBulletList().run()"
        >
          <PhListBullets />
        </button>
        <button
          :class="['toolbar-button', { active: isActive('orderedList') }]"
          :title="$t('bubbleMenuToolbar.orderedList')"
          @click="editor?.chain().focus().toggleOrderedList().run()"
        >
          <PhListNumbers />
        </button>

        <div class="toolbar-divider"></div>

        <!-- 链接 -->
        <button
          :class="['toolbar-button', { active: isActive('link') }]"
          :title="$t('bubbleMenuToolbar.addLink')"
          @click="startEditLink"
        >
          <PhLink />
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped lang="less">
.bubble-menu-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px;
  background: var(--color-bg-surface);
  backdrop-filter: blur(20px);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  box-shadow: 0 8px 32px var(--shadow-color-strong);

  .toolbar-divider {
    width: 1px;
    height: 16px;
    background: var(--color-bg-surface-hover);
    margin: 0 4px;
  }

  .toolbar-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    background: transparent;
    color: var(--color-text-primary);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s ease;
    font-size: 14px;
    padding: 0;

    &:hover {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
    }

    &.active {
      background: var(--color-accent-solid);
      color: var(--color-text-on-solid);
    }

    &.text-button {
      font-weight: 600;
      font-size: 13px;
      width: auto;
      padding: 0 6px;
    }

    :deep(svg) {
      font-size: 14px;
    }
  }

  .link-input-wrapper {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 4px;

    .link-input {
      width: 200px;
      background: var(--color-bg-surface-hover);
      border: 1px solid var(--color-border-subtle);
      color: var(--color-text-primary);

      &::placeholder {
        color: var(--color-text-disabled);
      }

      &:focus {
        background: var(--color-bg-surface-hover);
        border-color: var(--color-accent-border);
        box-shadow: none;
      }
    }
  }
}
</style>
