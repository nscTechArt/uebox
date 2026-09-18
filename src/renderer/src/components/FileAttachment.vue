<script setup lang="ts">
import { nodeViewProps, NodeViewWrapper } from '@tiptap/vue-3'
import { PhFile } from '@phosphor-icons/vue'
import dayjs from 'dayjs'
import { onMounted } from 'vue'

const props = defineProps(nodeViewProps)

console.log('FileAttachment setup, props:', props)

onMounted(() => {
  console.log('FileAttachment mounted, attrs:', props.node.attrs)
})

const openFile = (): void => {
  const path = props.node.attrs.path
  const shell = (window as unknown as { api: { shell: { openPath: (path: string) => void } } }).api
    ?.shell
  if (path && shell?.openPath) {
    shell.openPath(path)
  }
}

const formattedTime = (time: string | number): string => {
  return dayjs(time).format('YYYY-MM-DD HH:mm:ss')
}
</script>

<template>
  <NodeViewWrapper class="file-attachment-wrapper">
    <div class="file-attachment-card" contenteditable="false" data-drag-handle @dblclick="openFile">
      <div class="file-icon">
        <PhFile />
      </div>
      <div class="file-info">
        <div class="file-name">{{ props.node.attrs.name }}</div>
        <div class="file-meta">{{ formattedTime(props.node.attrs.mtime) }}</div>
      </div>
    </div>
  </NodeViewWrapper>
</template>

<style scoped lang="less">
.file-attachment-wrapper {
  margin: 8px 0;
}

.file-attachment-card {
  display: flex;
  align-items: center;
  background-color: var(--color-bg-surface); /* Dark background */
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  padding: 12px 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
  max-width: 400px;

  &:hover {
    background-color: var(--color-bg-surface);
    border-color: var(--color-border);
  }
}

.file-icon {
  font-size: 24px;
  color: var(--color-text-secondary);
  margin-right: 12px;
  display: flex;
  align-items: center;
}

.file-info {
  flex: 1;
  min-width: 0; /* Enable text truncation */
}

.file-name {
  color: var(--color-text-primary);
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-meta {
  color: var(--color-text-muted);
  font-size: 12px;
}
</style>
