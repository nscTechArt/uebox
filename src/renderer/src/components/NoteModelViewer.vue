<script setup lang="ts">
/** 笔记正文里的 3D 模型节点。查看器本体与其他地方共用 ModelViewer */
import { nodeViewProps, NodeViewWrapper } from '@tiptap/vue-3'
import { computed } from 'vue'
import ModelViewer from '@renderer/components/ModelViewer.vue'

const props = defineProps(nodeViewProps)

const modelPath = computed<string | null>(() => props.node.attrs.src || null)
</script>

<template>
  <NodeViewWrapper class="model-viewer-wrapper">
    <div class="model-viewer-container" contenteditable="false" data-drag-handle>
      <ModelViewer v-if="modelPath" :file-path="modelPath" />
      <div v-else class="error-placeholder">Invalid Model Path</div>
    </div>
  </NodeViewWrapper>
</template>

<style scoped lang="less">
.model-viewer-wrapper {
  margin: 16px 0;
  display: flex;
  justify-content: center;
}

.model-viewer-container {
  width: 700px;
  height: 600px;
  background: var(--color-bg-surface-hover);
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  position: relative;
  cursor: grab;

  &:active {
    cursor: grabbing;
  }
}

.error-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-danger-text);
}

:deep(canvas) {
  outline: none;
}
</style>
