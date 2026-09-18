<template>
  <div v-if="uniqueSources.length > 0" class="message-sources">
    <div class="sources-header">
      <span class="header-text">{{ $t('assistantMessageSources.header') }}</span>
      <div class="divider"></div>
    </div>
    <div class="sources-list">
      <div
        v-for="source in uniqueSources"
        :key="source.sourceId"
        class="source-card"
        @click="handleClick(source)"
      >
        <div class="source-header">
          <div class="source-badges">
            <span v-for="idx in source.indices" :key="idx" class="source-index"> {{ idx }} </span>
          </div>
          <AppTooltip placement="top" :title="source.title">
            <div class="source-title">{{ source.title }}</div>
          </AppTooltip>
        </div>
        <div class="source-snippet">
          {{ source.snippet }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppTooltip from '@renderer/components/AppTooltip.vue'
import { computed } from 'vue'

interface Citation {
  id: string
  title: string
  url?: string
  filePath?: string
  content?: string
  sourceId: string
  type?: string
}

interface GroupedSource extends Citation {
  indices: string[]
  snippet: string
}

const props = defineProps<{
  sources: Citation[]
}>()

const emit = defineEmits<{
  (e: 'click', source: any): void
}>()

const uniqueSources = computed<GroupedSource[]>(() => {
  const map = new Map<string, GroupedSource>()

  props.sources.forEach((s) => {
    if (!map.has(s.sourceId)) {
      // 提取摘要：取前 80 个字符，并移除换行符
      const snippet = s.content ? s.content.slice(0, 80).replace(/[\r\n]+/g, ' ') + '...' : ''
      map.set(s.sourceId, {
        ...s,
        indices: [s.id],
        snippet
      })
    } else {
      const existing = map.get(s.sourceId)!
      if (!existing.indices.includes(s.id)) {
        existing.indices.push(s.id)
      }
    }
  })

  return Array.from(map.values())
})

const handleClick = (source: GroupedSource): void => {
  // 构造 NotebookDetail 需要的 source 对象结构
  // SourceItem: { id, title, type, content, ... }
  const payload = {
    id: source.sourceId,
    title: source.title,
    type: source.type || 'text', // Fallback to text
    content: source.content || '',
    sourceUrl: source.url,
    fileName: source.filePath
  }
  emit('click', payload)
}
</script>

<style scoped lang="less">
.message-sources {
  margin: 12px 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sources-header {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-muted);
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 4px;
}

.header-text {
  flex-shrink: 0;
}

.divider {
  flex: 1;
  height: 1px;
  background-color: var(--color-bg-surface-hover);
  opacity: 0.5;
}

.sources-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.source-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background-color: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    background-color: var(--color-bg-surface-hover);
    border-color: var(--color-border-strong);
    transform: translateY(-1px);
    box-shadow: 0 2px 8px var(--shadow-color-weak);

    .source-title {
      color: var(--color-accent-text);
    }
  }
}

.source-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.source-badges {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.source-index {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: 12px;
  font-weight: bold;
  color: var(--color-accent-text);
  background-color: var(--color-accent-bg);
  border-radius: 4px;
}

.source-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.source-snippet {
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
</style>
