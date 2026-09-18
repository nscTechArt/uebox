<template>
  <div class="thinking-process">
    <div class="thinking-header" @click="toggleCollapse">
      <span class="thinking-icon" :class="{ spinning: isThinking }">
        <PhLightbulb v-if="!isThinking" />
        <PhCircleNotch v-else />
      </span>
      <span class="thinking-title">{{ title }}</span>
      <span class="thinking-arrow">
        <PhCaretDown :class="{ rotate: !isCollapsed }" />
      </span>
    </div>
    <!-- 收起时彻底卸载 Markdown：v-show 只隐藏，仍会在后台解析整段流式思考。 -->
    <div v-if="!isCollapsed" class="thinking-content">
      <MarkdownRenderer :content="content" :streaming="isThinking" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { PhCaretDown, PhCircleNotch, PhLightbulb } from '@phosphor-icons/vue'
import { useI18n } from 'vue-i18n'
import MarkdownRenderer from './MarkdownRenderer.vue'

const props = defineProps<{
  content: string
  isThinking?: boolean
}>()

const { t } = useI18n()
// 思考正文可能很长，默认收起，避免执行中的持续 Markdown 更新抢占页面交互。
const isCollapsed = ref(true)

const title = computed(() => {
  if (props.isThinking) {
    return t('assistant.thinking.processing') || '思考中...'
  }
  return t('assistant.thinking.finished') || '思考过程'
})

function toggleCollapse(): void {
  isCollapsed.value = !isCollapsed.value
}
</script>

<style scoped lang="less">
.thinking-process {
  width: 100%;
  border-radius: 6px;
  background-color: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  margin-bottom: 8px;
  overflow: hidden;
  opacity: 0.7;
  transition: opacity 0.2s;

  &:hover {
    opacity: 0.9;
  }
}

.thinking-header {
  display: flex;
  align-items: center;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s;
  font-size: 11px;
  color: var(--color-text-primary);

  &:hover {
    background-color: var(--color-bg-surface-hover);
  }
}

.thinking-icon {
  margin-right: 6px;
  display: flex;
  align-items: center;
  font-size: 12px;

  // 自带旋转动画，不依赖全局的 .icon-spin
  &.spinning {
    color: var(--color-accent-text);
    animation: thinking-spin 1s linear infinite;
  }
}

@keyframes thinking-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

.thinking-title {
  flex: 1;
  font-weight: 400;
}

.thinking-arrow {
  display: flex;
  align-items: center;
  transition: transform 0.3s;
  font-size: 9px;

  .rotate {
    transform: rotate(180deg);
  }
}

.thinking-content {
  padding: 0 10px 10px 10px;
  border-top: 1px solid var(--color-border-subtle);

  :deep(.markdown-body) {
    font-size: 11px !important;
    line-height: 1.5;
    color: var(--color-text-primary) !important;

    p {
      margin-bottom: 4px !important;
    }

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      font-size: 11px !important;
      font-weight: 500 !important;
      margin-top: 6px !important;
      margin-bottom: 3px !important;
      color: var(--color-text-primary) !important;
      border: none !important;
      padding: 0 !important;
    }

    ul,
    ol {
      margin-bottom: 4px !important;
      padding-left: 1.2em !important;
    }

    li {
      margin: 1px 0 !important;
    }

    code {
      font-size: 10px !important;
      background: var(--color-bg-surface-hover) !important;
      padding: 1px 3px !important;
      color: var(--color-text-primary) !important;
    }

    .code-block {
      margin: 4px 0 !important;

      .code-header {
        padding: 3px 6px !important;
        font-size: 9px !important;
      }

      pre {
        padding: 6px !important;
        font-size: 9px !important;
      }
    }

    blockquote {
      margin: 3px 0 !important;
      padding: 0 0.6em !important;
      font-size: 10px !important;
      border-left-color: var(--color-border-subtle) !important;
    }

    a {
      color: var(--color-accent-text) !important;
    }
  }
}
</style>
