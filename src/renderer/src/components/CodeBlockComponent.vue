<script setup lang="ts">
import AppTooltip from '@renderer/components/AppTooltip.vue'
import { NodeViewWrapper, NodeViewContent, nodeViewProps } from '@tiptap/vue-3'
import { PhCheck, PhCopy } from '@phosphor-icons/vue'
import { ref } from 'vue'

const props = defineProps(nodeViewProps)
const copied = ref(false)

/**
 * 复制代码到剪贴板
 */
const copyCode = (): void => {
  const code = props.node.textContent
  navigator.clipboard.writeText(code)
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 2000)
}
</script>

<template>
  <node-view-wrapper class="code-block-wrapper">
    <div class="code-block-container">
      <pre><node-view-content as="code" /></pre>
      <AppTooltip placement="left" :title="$t('codeBlockComponent.copyTooltip')">
        <div class="copy-btn-container" @click="copyCode">
          <PhCheck v-if="copied" />
          <PhCopy v-else />
        </div>
      </AppTooltip>
    </div>
  </node-view-wrapper>
</template>

<style scoped lang="less">
.code-block-wrapper {
  margin: 16px 0;

  .code-block-container {
    position: relative;
    border-radius: 8px;
    overflow: hidden;

    &:hover {
      .copy-btn-container {
        opacity: 1;
      }
    }
  }

  pre {
    margin: 0;
    overflow-x: auto;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: 0.9em;
    color: var(--color-text-primary);
    background: transparent;

    code {
      background: transparent;
      padding: 0;
      color: inherit;
    }
  }

  .copy-btn-container {
    position: absolute;
    top: 24px;
    right: 8px;
    padding: 4px;
    border-radius: 4px;
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
    cursor: pointer;
    opacity: 0;
    transition: all 0.2s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;

    &:hover {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
    }
  }
}
</style>
