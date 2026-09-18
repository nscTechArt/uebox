<script setup lang="ts">
import AppSegmented from '@renderer/components/AppSegmented.vue'
/** 外观设置：主题、配色与动态效果。 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import AppButton from '@renderer/components/AppButton.vue'
import { message } from '@renderer/utils/messageManager'
import { useTheme, type CustomThemeColors, type ThemePreference } from '@renderer/hooks/useTheme'
import {
  DEFAULT_CUSTOM_THEME,
  normalizeHexColor,
  validateCustomTheme,
  type CustomThemeContrastWarning,
  type CustomThemeValidationError
} from '@renderer/hooks/customTheme'
import { useMotionPreference, type MotionPreference } from '@renderer/hooks/useMotionPreference'

const { t } = useI18n()
const { themePreference, customTheme, setTheme, setCustomTheme } = useTheme()
const { motionPreference, setMotionPreference } = useMotionPreference()

/**
 * 这一页所有设置的真相源都在各自的 hook 里（写 localStorage，同步读取所以
 * 启动不闪）。这里的 ref 只是给控件做双向绑定用的镜像。
 */
const themeMode = ref<ThemePreference>(themePreference.value)

const MOTION_OPTIONS: readonly MotionPreference[] = ['system', 'full', 'reduced']
const motionMode = computed({
  get: () => motionPreference.value,
  set: (next: MotionPreference) => setMotionPreference(next)
})

function motionLabel(mode: MotionPreference): string {
  return t(
    {
      system: 'profile.appearance.motionSystem',
      full: 'profile.appearance.motionFull',
      reduced: 'profile.appearance.motionReduced'
    }[mode]
  )
}

// ── 自定义配色 ──────────────────────────────────────────────────────────

const customDraft = reactive<CustomThemeColors>({ ...customTheme.value })
const customColorFields = [
  { key: 'background', label: 'profile.appearance.customThemeBackground' },
  { key: 'foreground', label: 'profile.appearance.customThemeForeground' },
  { key: 'accent', label: 'profile.appearance.customThemeAccent' }
] as const

const customValidation = computed(() => validateCustomTheme(customDraft))
const customValidationMessages = computed(() => {
  const result = customValidation.value
  if (!result.valid) {
    const keys: Record<CustomThemeValidationError, string> = {
      'invalid-background': 'profile.appearance.customThemeInvalidBackground',
      'invalid-foreground': 'profile.appearance.customThemeInvalidForeground',
      'invalid-accent': 'profile.appearance.customThemeInvalidAccent'
    }
    return [t(keys[result.error ?? 'invalid-background'])]
  }

  const warningKeys: Record<CustomThemeContrastWarning, string> = {
    'text-contrast': 'profile.appearance.customThemeTextContrast',
    'accent-contrast': 'profile.appearance.customThemeAccentContrast',
    'accent-text-contrast': 'profile.appearance.customThemeAccentTextContrast'
  }
  // 只报结论，不报「4.7:1」那个比值 —— 那是设计师的指标，用户读到它也做不出判断
  if (result.warnings.length > 0) {
    return result.warnings.map((warning) => t(warningKeys[warning.type]))
  }

  return [t('profile.appearance.customThemeReady')]
})

function pickerColor(key: keyof CustomThemeColors): string {
  return normalizeHexColor(customDraft[key]) ?? customTheme.value[key]
}

function updateColorFromPicker(key: keyof CustomThemeColors, event: Event): void {
  customDraft[key] = (event.target as HTMLInputElement).value.toUpperCase()
}

function normalizeDraftColor(key: keyof CustomThemeColors): void {
  const normalized = normalizeHexColor(customDraft[key])
  if (normalized) customDraft[key] = normalized
}

function applyCustomTheme(): void {
  if (!customValidation.value.valid || !setCustomTheme(customDraft)) {
    message.error(customValidationMessages.value[0])
    return
  }
  Object.assign(customDraft, customTheme.value)
  message.success(t('profile.appearance.customThemeApplied'))
}

function resetCustomTheme(): void {
  Object.assign(customDraft, DEFAULT_CUSTOM_THEME)
  setCustomTheme(DEFAULT_CUSTOM_THEME)
  message.success(t('profile.appearance.customThemeReset'))
}

/**
 * 挂载那一刻主题下拉会被赋一次值，watch 会当成用户改的然后弹提示。
 * 和常规页同一个做法：加载完之前不响应。
 */
const isLoadingSettings = ref(true)
onMounted(() => {
  setTimeout(() => {
    isLoadingSettings.value = false
  }, 100)
})

watch(themeMode, (next) => {
  if (isLoadingSettings.value) return
  setTheme(next)
  const keys: Record<ThemePreference, string> = {
    system: 'profile.appearance.themeChangedSystem',
    light: 'profile.appearance.themeChangedLight',
    dark: 'profile.appearance.themeChangedDark',
    custom: 'profile.appearance.themeChangedCustom'
  }
  message.success(t(keys[next]))
})
</script>

<template>
  <div class="settings-content">
    <section class="settings-section">
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-label">{{ $t('profile.appearance.motion') }}</div>
          <div class="setting-desc">{{ $t('profile.appearance.motionDesc') }}</div>
        </div>
        <!-- @vue-generic {typeof MOTION_OPTIONS[number]} -->
        <AppSegmented
          v-model="motionMode"
          :options="MOTION_OPTIONS"
          :aria-label="$t('profile.appearance.motion')"
        >
          <template #default="{ option }">
            {{ motionLabel(option) }}
          </template>
        </AppSegmented>
      </div>

      <!-- 主题 -->
      <div class="setting-item theme-setting">
        <div class="setting-info">
          <div class="setting-label">{{ $t('profile.appearance.theme') }}</div>
        </div>
        <a-select
          v-model:value="themeMode"
          class="theme-select"
          :aria-label="$t('profile.appearance.theme')"
        >
          <a-select-option value="system">
            {{ $t('profile.appearance.themeSystem') }}
          </a-select-option>
          <a-select-option value="light">
            {{ $t('profile.appearance.themeLight') }}
          </a-select-option>
          <a-select-option value="dark">{{ $t('profile.appearance.themeDark') }}</a-select-option>
          <a-select-option value="custom">
            {{ $t('profile.appearance.themeCustom') }}
          </a-select-option>
        </a-select>
      </div>

      <!-- 自定义配色，只在选了「自定义」那一档时出现 -->
      <div v-if="themeMode === 'custom'" class="custom-theme-editor">
        <div class="custom-theme-heading">
          <div class="setting-label">{{ $t('profile.appearance.customThemeTitle') }}</div>
          <div class="setting-desc">{{ $t('profile.appearance.customThemeDesc') }}</div>
        </div>

        <div class="custom-theme-fields">
          <div v-for="field in customColorFields" :key="field.key" class="custom-color-field">
            <label class="select-label" :for="`custom-theme-${field.key}`">
              {{ $t(field.label) }}
            </label>
            <div class="custom-color-control">
              <input
                :id="`custom-theme-${field.key}`"
                type="color"
                :value="pickerColor(field.key)"
                :aria-label="$t(field.label)"
                @input="updateColorFromPicker(field.key, $event)"
              />
              <a-input
                v-model:value="customDraft[field.key]"
                :aria-label="$t(field.label)"
                :status="normalizeHexColor(customDraft[field.key]) ? undefined : 'error'"
                @blur="normalizeDraftColor(field.key)"
                @press-enter="applyCustomTheme"
              />
            </div>
          </div>
        </div>

        <div
          class="custom-theme-feedback"
          :class="{
            'custom-theme-feedback--error': !customValidation.valid,
            'custom-theme-feedback--warning':
              customValidation.valid && customValidation.warnings.length > 0
          }"
          aria-live="polite"
        >
          <div v-for="feedback in customValidationMessages" :key="feedback">{{ feedback }}</div>
        </div>

        <div class="custom-theme-actions">
          <AppButton @click="resetCustomTheme">
            {{ $t('profile.appearance.customThemeResetAction') }}
          </AppButton>
          <AppButton
            variant="primary"
            :disabled="!customValidation.valid"
            @click="applyCustomTheme"
          >
            {{ $t('profile.appearance.customThemeApply') }}
          </AppButton>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped lang="less">
.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.theme-select {
  flex: 0 1 160px;
  min-width: 0;
}

.select-label {
  font-size: 12px;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
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

/* 三态分段控件。与 AI 设置页那几处档位切换同一套外观 */

.custom-theme-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
}

.custom-theme-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.custom-theme-fields {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-4);
}

.custom-color-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.custom-color-control {
  display: flex;
  align-items: center;
  gap: var(--space-2);

  /*
   * 取色器本身就是一块颜色，它显示的**就是**用户挑的那个值 ——
   * 这里不适用「不许写死颜色」那条：没有主题变量可用，色块的内容是数据。
   */
  input[type='color'] {
    width: 36px;
    height: 32px;
    padding: 0;
    border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    cursor: pointer;
    flex-shrink: 0;
  }
}

.custom-theme-feedback {
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.6;

  &--warning {
    color: var(--color-warning-text);
  }

  &--error {
    color: var(--color-danger-text);
  }
}

.custom-theme-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
}
</style>
