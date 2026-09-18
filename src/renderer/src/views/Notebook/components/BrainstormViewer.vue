<script setup lang="ts">
/**
 * 头脑风暴查看器组件
 * 展示 AI 生成的创意卡片，支持分类筛选
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhArrowLeft, PhCircleNotch, PhLightbulb } from '@phosphor-icons/vue'
import type {
  BrainstormSession,
  BrainstormIdea,
  IdeaCategory
} from '@renderer/services/brainstorm/types'
import { CATEGORY_CONFIG, categoryLabel } from '@renderer/services/brainstorm/types'

const props = defineProps<{
  /** 头脑风暴数据 */
  data: BrainstormSession | null
  /** 标题 */
  title?: string
  /** 是否正在生成 */
  isGenerating?: boolean
  /** 生成进度 */
  progress?: number
  /** 状态消息 */
  statusMessage?: string
}>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'idea-dblclick', idea: BrainstormIdea): void
}>()

const { t } = useI18n()

/** 当前筛选的分类 */
const activeCategory = ref<IdeaCategory | 'all'>('all')

/** 所有分类列表 */
const categories = computed(() => {
  const all = {
    key: 'all' as const,
    label: t('notebookBrainstormViewer.allCategory'),
    count: props.data?.ideas.length || 0
  }
  const cats = Object.entries(CATEGORY_CONFIG).map(([key, config]) => ({
    key: key as IdeaCategory,
    label: categoryLabel(key),
    icon: config.icon,
    color: config.color,
    count: props.data?.ideas.filter((i) => i.category === key).length || 0
  }))
  return [all, ...cats.filter((c) => c.count > 0)]
})

/** 筛选后的创意列表 */
const filteredIdeas = computed(() => {
  if (!props.data?.ideas) return []
  if (activeCategory.value === 'all') return props.data.ideas
  return props.data.ideas.filter((i) => i.category === activeCategory.value)
})

/**
 * 获取分类配置
 */
function getCategoryConfig(category: IdeaCategory) {
  return CATEGORY_CONFIG[category] || CATEGORY_CONFIG.exploration
}
</script>

<template>
  <div class="brainstorm-viewer">
    <!-- 头部 -->
    <div class="viewer-header">
      <div class="header-left">
        <button class="back-btn" @click="emit('back')">
          <PhArrowLeft />
        </button>
        <div class="header-info">
          <div class="type-badge">
            <PhLightbulb />
            <span>{{ $t('notebookBrainstormViewer.badge') }}</span>
          </div>
          <h2 class="title">
            {{ title || data?.topicSummary || $t('notebookBrainstormViewer.titleFallback') }}
          </h2>
        </div>
      </div>
    </div>

    <!-- 内容区 -->
    <div class="content-area">
      <!-- 生成中状态 -->
      <div v-if="isGenerating" class="generating-state">
        <div class="generating-content">
          <PhCircleNotch class="icon-spin generating-icon" />
          <div class="generating-info">
            <div class="generating-title">{{ $t('notebookBrainstormViewer.generatingTitle') }}</div>
            <div class="generating-message">
              {{ statusMessage || $t('notebookBrainstormViewer.generatingMessageFallback') }}
            </div>
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: (progress || 0) + '%' }"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else-if="!data?.ideas?.length" class="empty-state">
        <PhLightbulb class="empty-icon" />
        <span>{{ $t('notebookBrainstormViewer.emptyState') }}</span>
      </div>

      <!-- 创意列表 -->
      <template v-else>
        <!-- 分类筛选 -->
        <div class="category-filter">
          <button
            v-for="cat in categories"
            :key="cat.key"
            class="category-btn"
            :class="{ active: activeCategory === cat.key }"
            @click="activeCategory = cat.key"
          >
            <span v-if="'icon' in cat" class="cat-icon">{{ cat.icon }}</span>
            <span>{{ cat.label }}</span>
            <span class="cat-count">{{ cat.count }}</span>
          </button>
        </div>

        <!-- 卡片网格 -->
        <div class="ideas-grid">
          <div
            v-for="idea in filteredIdeas"
            :key="idea.id"
            class="idea-card"
            :style="{ '--cat-color': getCategoryConfig(idea.category).color }"
            @dblclick="emit('idea-dblclick', idea)"
          >
            <div class="card-header">
              <span class="cat-badge">
                {{ getCategoryConfig(idea.category).icon }}
                {{ categoryLabel(idea.category) }}
              </span>
            </div>
            <h3 class="idea-title">{{ idea.title }}</h3>
            <p class="idea-desc">{{ idea.description }}</p>
            <p v-if="idea.reasoning" class="idea-reasoning">💭 {{ idea.reasoning }}</p>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped lang="less">
.brainstorm-viewer {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-surface-hover);
  overflow: hidden;
}

.viewer-header {
  height: 85px;
  display: flex;
  align-items: center;
  padding: 0 24px;
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--color-border-subtle);
  flex-shrink: 0;

  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .back-btn {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1px solid var(--color-border-subtle);
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
    &:hover {
      background: var(--color-bg-surface-hover);
    }
  }

  .header-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .type-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--color-text-primary);
    background: var(--color-warning-bg);
    padding: 2px 8px;
    border-radius: 4px;
    width: fit-content;
  }

  .title {
    font-size: 16px;
    font-weight: 500;
    color: var(--color-text-primary);
    margin: 0;
  }
}

.content-area {
  flex: 1;
  overflow: auto;
  padding: 24px;
}

.generating-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-primary);
}

.generating-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  padding: 40px;
  background: var(--color-bg-surface-hover);
  border-radius: 16px;
  border: 1px solid var(--color-border-subtle);
}

.generating-icon {
  font-size: 48px;
  color: var(--color-warning-text);
}
.generating-info {
  text-align: center;
}
.generating-title {
  font-size: 18px;
  font-weight: 500;
  color: var(--color-text-primary);
  margin-bottom: 8px;
}
.generating-message {
  font-size: 14px;
  color: var(--color-text-primary);
  margin-bottom: 16px;
}

.progress-bar {
  width: 200px;
  height: 6px;
  background: var(--color-bg-surface-hover);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--color-warning-solid);
  transition: width 0.3s;
}

.empty-icon {
  font-size: 48px;
  opacity: 0.3;
  margin-bottom: 12px;
}

.category-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 24px;
}

.category-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 20px;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: var(--color-bg-surface-hover);
  }
  &.active {
    background: var(--color-warning-bg);
    border-color: var(--color-warning-border);
    color: var(--color-warning-text);
  }

  .cat-count {
    background: var(--color-bg-surface-hover);
    padding: 2px 6px;
    border-radius: 10px;
    font-size: 11px;
  }
}

.ideas-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.idea-card {
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-radius: 12px;
  padding: 20px;
  transition: all 0.2s;

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--cat-color);
    transform: translateY(-2px);
    cursor: pointer;
  }

  .card-header {
    margin-bottom: 12px;
  }

  .cat-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--cat-color);
    background: color-mix(in srgb, var(--cat-color) 20%, transparent);
    padding: 4px 10px;
    border-radius: 12px;
  }

  .idea-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0 0 8px;
  }

  .idea-desc {
    font-size: 14px;
    color: var(--color-text-primary);
    line-height: 1.6;
    margin: 0 0 12px;
  }

  .idea-reasoning {
    font-size: 13px;
    color: var(--color-text-primary);
    font-style: italic;
    margin: 0;
    padding-top: 12px;
    border-top: 1px solid var(--color-border-subtle);
  }
}
</style>
