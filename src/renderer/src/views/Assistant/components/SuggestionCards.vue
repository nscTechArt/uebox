<template>
  <div class="suggestion-grid">
    <AppCard
      v-for="item in items"
      :key="item.title"
      :hoverable="true"
      class="suggestion-card"
      @click="handleSelect(item)"
    >
      <div class="card-inner">
        <div class="title">{{ item.title }}</div>
        <div class="desc">{{ item.description }}</div>
      </div>
    </AppCard>
  </div>
</template>

<script setup lang="ts">
import AppCard from '@renderer/components/AppCard.vue'
/**
 * 建议卡片数据接口
 * - title: 卡片显示标题
 * - description: 卡片描述文本
 * - prompt: 点击后发送的实际消息（可选，默认使用title）
 */
export interface SuggestionItem {
  title: string
  description: string
  prompt?: string
}

interface Props {
  items: SuggestionItem[]
}

defineProps<Props>()
const emit = defineEmits<{ (e: 'select', item: SuggestionItem): void }>()

/**
 * 处理建议卡片选择事件，上抛所选项。
 */
function handleSelect(item: SuggestionItem): void {
  emit('select', item)
}
</script>

<style scoped lang="less">
.suggestion-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.suggestion-card {
  background: var(--color-bg-raised);
  border-radius: 16px;
  border: none;
  :deep(.app-card__body) {
    padding: 16px 18px;
  }
}

.card-inner {
  .title {
    font-weight: 600;
    font-size: 16px;
    color: var(--color-text-primary);
  }
  .desc {
    margin-top: 4px;
    font-size: 13px;
    color: var(--color-text-secondary);
  }
}

@media (max-width: 1024px) {
  .suggestion-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .suggestion-grid {
    grid-template-columns: 1fr;
  }
}
</style>
