<script setup lang="ts">
/**
 * 知识库设置组件
 * 管理知识库相关的偏好设置
 * 样式与常规设置保持一致
 */
import { ref, onMounted } from 'vue'
import { message } from '@renderer/utils/messageManager'
import { useI18n } from 'vue-i18n'
import AppSwitch from '@renderer/components/AppSwitch.vue'
import {
  DEFAULT_IMAGE_READ_MAX,
  MAX_IMAGES_PER_SOURCE,
  MIN_IMAGES_PER_SOURCE,
  normalizeMaxImages
} from '@core/shared/notebookImagePolicy'

const { t } = useI18n()

// 「笔记自动索引」搬去知识库页了，就在「向量化」按钮旁边的下拉里 ——
// 那个开关管的正是这个按钮要不要自己按，分在两个页面看不出是同一件事。
// 设置项本身没变，还是 notebook_auto_train

const readImagesEnabled = ref(false)
const readImagesMax = ref(DEFAULT_IMAGE_READ_MAX)
const loading = ref(false)

// 「召回距离阈值」那个输入框删了。合适的距离阈值取决于嵌入模型、语料和 query 长度，
// 这三样我们知道、用户不知道 —— 摆一个 0.5~2.0 的数字框，等于把一道我们自己该答的
// 题推给他。要调的人（我们）走 NOTEBOOK_RECALL_DISTANCE_THRESHOLD 环境变量，
// 见 src/main/sqliteDataBase/services/notebookRagConfig.ts

/**
 * 加载设置
 */
const loadSettings = async (): Promise<void> => {
  try {
    loading.value = true
    readImagesEnabled.value = await window.api.settings.get('notebook_read_images', false)
    readImagesMax.value = normalizeMaxImages(
      await window.api.settings.get('notebook_read_images_max', DEFAULT_IMAGE_READ_MAX)
    )
  } catch (error) {
    console.error('加载知识库设置失败:', error)
    message.error(t('common.loadFailed'))
  } finally {
    loading.value = false
  }
}

/**
 * 读图开关。
 *
 * 默认关是有意的：读图按张收费，一篇公众号十几张图，不能替用户决定这笔开销。
 * 打开之后每篇最多读 6 张，太小的（图标、分割线）和模型判定是二维码/装饰图的
 * 都不读，识别结果标注「AI 识别」插在图片下面，不覆盖原文。
 */
const handleReadImagesChange = async (): Promise<void> => {
  const newValue = !readImagesEnabled.value
  try {
    loading.value = true
    await window.api.settings.set('notebook_read_images', newValue)
    readImagesEnabled.value = newValue
    message.success(t('common.saved'))
  } catch (error) {
    console.error('保存读图设置失败:', error)
    message.error(t('common.saveFailed'))
  } finally {
    loading.value = false
  }
}

/**
 * 每篇读几张。
 *
 * 这个数只有用户自己知道 —— 他订阅的是哪家模型、一张多少钱、这批资料图多不多，
 * 我们都不知道。所以不写死，只把明显是手滑的值（0、负数、四位数）收进合法范围。
 */
const handleReadImagesMaxChange = async (): Promise<void> => {
  try {
    const value = normalizeMaxImages(readImagesMax.value)
    readImagesMax.value = value
    await window.api.settings.set('notebook_read_images_max', value)
    message.success(t('common.saved'))
  } catch (error) {
    console.error('保存读图张数失败:', error)
    message.error(t('common.saveFailed'))
  }
}

// 暂时隐藏重建索引功能
// const rebuilding = ref(false)
//

onMounted(() => {
  loadSettings()
})
</script>

<template>
  <div class="settings-content">
    <!-- 知识库设置 Section -->
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.notebook.settingsTitle') }}</h4>
      <div class="settings-list">
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.notebook.readImages') }}</div>
            <div class="setting-desc">{{ $t('profile.notebook.readImagesDesc') }}</div>
          </div>
          <AppSwitch
            :checked="readImagesEnabled"
            :disabled="loading"
            @change="handleReadImagesChange"
          />
        </div>
        <!-- 张数只在开关打开时才有意义，关着显示它只是噪音 -->
        <div v-if="readImagesEnabled" class="setting-item setting-item--sub">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.notebook.readImagesMax') }}</div>
            <div class="setting-desc">
              {{
                $t('profile.notebook.readImagesMaxDesc', {
                  min: MIN_IMAGES_PER_SOURCE,
                  max: MAX_IMAGES_PER_SOURCE
                })
              }}
            </div>
          </div>
          <div class="threshold-input-wrapper">
            <input
              v-model.number="readImagesMax"
              type="number"
              step="1"
              :min="MIN_IMAGES_PER_SOURCE"
              :max="MAX_IMAGES_PER_SOURCE"
              class="threshold-input"
              :disabled="loading"
              @blur="handleReadImagesMaxChange"
              @keyup.enter="handleReadImagesMaxChange"
            />
          </div>
        </div>
      </div>
    </section>

    <!-- 数据管理 Section - 暂时隐藏 -->
    <!-- <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.notebook.dataManagement') }}</h4>
      <div class="settings-list">
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.notebook.rebuildIndex') }}</div>
            <div class="setting-desc">{{ $t('profile.notebook.rebuildIndexDesc') }}</div>
          </div>
          <AppButton variant="soft" size="medium" :loading="rebuilding" @click="handleRebuildIndex">
            <span v-if="rebuilding">Rebuilding...</span>
            <span v-else>Rebuild</span>
          </AppButton>
        </div>
      </div>
    </section> -->
  </div>
</template>

<style scoped lang="less">
.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}

/* Section 样式 */
.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.section-title {
  margin: 0;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
}

/* 设置列表 */
.settings-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

/* 张数是「读图」的子项，缩进一格 + 一条竖线，让它从属关系一眼可见 */
.setting-item--sub {
  padding-left: var(--space-4);
  border-left: 2px solid var(--color-border-subtle);
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.setting-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.setting-desc {
  font-size: 12px;
  color: var(--color-text-muted);
}

/* 阈值输入框样式 */
.threshold-input-wrapper {
  display: flex;
  align-items: center;
}

.threshold-input {
  width: 70px;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  color: var(--color-text-primary);
  font-size: 12px;
  text-align: center;
  transition: all 0.2s;

  &:hover:not(:disabled) {
    border-color: var(--color-border);
  }

  &:focus {
    outline: none;
    border-color: var(--color-accent-border);
    background: var(--color-bg-surface-hover);
  }

  &:disabled {
    color: var(--color-text-disabled);
    cursor: not-allowed;
  }

  /* 隐藏数字输入框的上下箭头 */
  &::-webkit-inner-spin-button,
  &::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  -moz-appearance: textfield;
}
</style>
