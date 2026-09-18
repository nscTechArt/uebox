<template>
  <AppModal
    v-model:open="visible"
    :title="t('assetLib.colorPicker.title')"
    :width="360"
    @ok="handleConfirm"
    @cancel="handleCancel"
  >
    <div class="color-picker-content">
      <!-- 预设颜色 -->
      <div class="preset-section">
        <div class="section-label">{{ t('assetLib.colorPicker.presets') }}</div>
        <div class="color-grid">
          <div
            v-for="color in presetColors"
            :key="color"
            class="color-swatch"
            :class="{ selected: selectedColor === color }"
            :style="{ backgroundColor: color }"
            @click="selectColor(color)"
          >
            <PhCheck v-if="selectedColor === color" class="check-icon" />
          </div>
        </div>
      </div>

      <!-- 自定义颜色输入 -->
      <div class="custom-section">
        <div class="section-label">{{ t('assetLib.colorPicker.custom') }}</div>
        <div class="custom-input-row">
          <div class="color-preview" :style="{ backgroundColor: customColor || '#CCCCCC' }"></div>
          <a-input
            v-model:value="customColor"
            placeholder="#FF5733"
            :maxlength="7"
            @change="handleCustomColorChange"
          />
        </div>
      </div>

      <!-- 清除颜色按钮 -->
      <div class="clear-section">
        <AppButton variant="text" danger @click="clearColor">
          <template #icon><PhTrash /></template>
          {{ t('assetLib.colorPicker.clear') }}
        </AppButton>
      </div>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCheck, PhTrash } from '@phosphor-icons/vue'

interface Props {
  open: boolean
  /** 当前颜色（十六进制格式，如 #FF5733） */
  currentColor?: string
}

interface Emits {
  (e: 'update:open', value: boolean): void
  /** 确认选择颜色，color 为 null 表示清除颜色 */
  (e: 'confirm', color: string | null): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()
const { t } = useI18n()

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

/**
 * 预设颜色调色板
 * 包含常用标记颜色，参考 macOS Finder / Windows 文件夹颜色
 */
const presetColors = [
  // 第一行：鲜艳色
  '#EF4444', // 红色
  '#F97316', // 橙色
  '#EAB308', // 黄色
  '#22C55E', // 绿色
  '#3B82F6', // 蓝色
  '#8B5CF6', // 紫色
  // 第二行：柔和色
  '#EC4899', // 粉色
  '#14B8A6', // 青色
  '#6366F1', // 靛蓝
  '#84CC16', // 酸橙
  '#F43F5E', // 玫红
  '#0EA5E9', // 天蓝
  // 第三行：中性色
  '#78716C', // 灰棕
  '#64748B', // 石板灰
  '#71717A', // 锌灰
  '#A8A29E' // 浅灰
]

const selectedColor = ref<string | null>(null)
const customColor = ref('')

/**
 * 监听弹窗打开，初始化颜色状态
 */
watch(
  () => props.open,
  (newVal) => {
    if (newVal) {
      // 初始化为当前颜色
      if (props.currentColor) {
        selectedColor.value = props.currentColor.toUpperCase()
        customColor.value = props.currentColor.toUpperCase()
      } else {
        selectedColor.value = null
        customColor.value = ''
      }
    }
  }
)

/**
 * 选择预设颜色
 * @param color 颜色值
 */
const selectColor = (color: string): void => {
  selectedColor.value = color
  customColor.value = color
}

/**
 * 处理自定义颜色输入变化
 */
const handleCustomColorChange = (): void => {
  const value = customColor.value.trim().toUpperCase()
  // 验证是否为有效的十六进制颜色
  if (/^#[0-9A-F]{6}$/i.test(value)) {
    selectedColor.value = value
  }
}

/**
 * 清除颜色
 */
const clearColor = (): void => {
  selectedColor.value = null
  customColor.value = ''
}

/**
 * 确认选择
 */
const handleConfirm = (): void => {
  emit('confirm', selectedColor.value)
  visible.value = false
}

/**
 * 取消选择
 */
const handleCancel = (): void => {
  visible.value = false
}
</script>

<style scoped lang="less">
.color-picker-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-label {
  font-size: 12px;
  color: var(--color-text-primary);
  margin-bottom: 8px;
}

.preset-section {
  .color-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 8px;
  }

  .color-swatch {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    border: 2px solid transparent;

    &:hover {
      transform: scale(1.1);
      box-shadow: 0 2px 8px var(--shadow-color);
    }

    &.selected {
      border-color: var(--color-border-strong);
      box-shadow: 0 0 0 2px var(--shadow-highlight);
    }

    .check-icon {
      color: var(--color-text-primary);
      font-size: 16px;
      text-shadow: 0 1px 2px var(--shadow-color-strong);
    }
  }
}

.custom-section {
  .custom-input-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .color-preview {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    flex-shrink: 0;
  }
}

.clear-section {
  display: flex;
  justify-content: center;
  padding-top: 8px;
  border-top: 1px solid var(--color-border-subtle);
}
</style>
