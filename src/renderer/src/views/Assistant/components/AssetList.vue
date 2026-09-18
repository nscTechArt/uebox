<template>
  <div class="asset-list-container">
    <div class="asset-list-header" @click="toggleCollapse">
      <PhFileImage class="header-icon" />
      <span class="header-title">{{ t('assistantAssetList.header', { count: totalCount }) }}</span>
      <PhCaretUp v-if="!isCollapsed" class="collapse-icon" />
      <PhCaretDown v-else class="collapse-icon" />
    </div>
    <div v-show="!isCollapsed" class="asset-list-content">
      <div
        v-for="(asset, index) in displayAssets"
        :key="index"
        class="asset-item"
        @click="handleAssetClick(asset)"
      >
        <div class="asset-icon">
          <PhFileImage v-if="isImage(asset)" />
          <PhFile v-else />
        </div>
        <div class="asset-info">
          <AppTooltip placement="top" :title="asset.name || asset.assetName">
            <div class="asset-name">
              {{ asset.name || asset.assetName || t('assistantAssetList.unknownName') }}
            </div>
          </AppTooltip>
          <div class="asset-meta">
            <span v-if="asset.type && asset.type !== 'File'" class="asset-type">{{
              asset.type
            }}</span>
            <span v-if="getAssetSize(asset)" class="asset-size">{{ getAssetSize(asset) }}</span>
          </div>
        </div>
      </div>
      <div v-if="hasMore" class="asset-more">
        {{ t('assistantAssetList.moreHidden', { count: totalCount - displayAssets.length }) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppTooltip from '@renderer/components/AppTooltip.vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretDown, PhCaretUp, PhFile, PhFileImage } from '@phosphor-icons/vue'

interface Asset {
  name?: string
  assetName?: string
  type?: string
  size?: number
  fileSize?: number
  assetKey?: string
  path?: string
}

interface Props {
  assets: Asset[]
  totalCount?: number
  maxDisplay?: number
}

const props = withDefaults(defineProps<Props>(), {
  assets: () => [],
  totalCount: 0,
  maxDisplay: 50
})

const emit = defineEmits<{
  (e: 'asset-click', asset: Asset): void
}>()

const { t } = useI18n()

// 折叠状态
const isCollapsed = ref(false)

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value
}

const displayAssets = computed(() => {
  return props.assets.slice(0, props.maxDisplay)
})

const hasMore = computed(() => {
  return props.totalCount > displayAssets.value.length
})

const isImage = (asset: Asset): boolean => {
  const name = asset.name || asset.assetName || ''
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tga', '.tiff', '.webp']
  return imageExtensions.some((ext) => name.toLowerCase().endsWith(ext))
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

// 为每个资产计算大小
const getAssetSize = (asset: Asset): string => {
  const size = asset.size || asset.fileSize
  return size ? formatFileSize(size) : ''
}

const handleAssetClick = (asset: Asset): void => {
  emit('asset-click', asset)
}
</script>

<style scoped lang="less">
.asset-list-container {
  margin-top: 16px;
  margin-bottom: 16px;
  border-radius: 8px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  overflow: hidden;
}

.asset-list-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-primary);
  cursor: pointer;
  user-select: none;
  transition: background 0.2s;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  .header-icon {
    font-size: 16px;
    color: var(--color-accent-text);
  }

  .header-title {
    flex: 1;
    color: var(--color-text-primary);
  }

  .collapse-icon {
    font-size: 12px;
    color: var(--color-text-secondary);
    transition: transform 0.2s;
  }
}

.asset-list-content {
  max-height: 400px;
  overflow-y: auto;
  padding: 8px;

  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-track {
    background: var(--color-bg-surface-hover);
    border-radius: 3px;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: 3px;

    &:hover {
      background: var(--color-bg-surface-hover);
    }
  }
}

.asset-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  margin-bottom: 4px;
  border-radius: 6px;
  background: var(--color-bg-surface-hover);
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: var(--color-bg-surface-hover);
    transform: translateX(2px);
  }

  &:last-child {
    margin-bottom: 0;
  }

  .asset-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 6px;
    background: var(--color-accent-bg);
    color: var(--color-accent-text);
    font-size: 16px;
    flex-shrink: 0;
  }

  .asset-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;

    .asset-name {
      font-size: 13px;
      color: var(--color-text-primary);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .asset-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--color-text-secondary);

      .asset-type {
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--color-accent-bg);
        color: var(--color-accent-text);
      }

      .asset-size {
        color: var(--color-text-secondary);
      }
    }
  }
}

.asset-more {
  padding: 12px;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-secondary);
  border-top: 1px solid var(--color-border-subtle);
  margin-top: 4px;
}
</style>
