<template>
  <div class="language-gate">
    <div class="gate-card">
      <div class="brand">
        <BrandMark class="brand-logo" />
        <h1 class="brand-name">Unreal Box</h1>
      </div>

      <p class="gate-hint">
        请选择语言
        <span class="hint-divider">/</span>
        Choose your language
      </p>

      <div class="options">
        <button
          v-for="option in options"
          :key="option.value"
          class="option"
          :class="{ 'option--busy': pending === option.value }"
          :disabled="Boolean(pending)"
          @click="choose(option.value)"
        >
          <span class="option-label">{{ option.label }}</span>
          <span class="option-sub">{{ option.sub }}</span>
        </button>
      </div>

      <p class="gate-note">
        {{ noteText }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import BrandMark from '@renderer/components/BrandMark.vue'
import { setLocale } from '@renderer/i18n'

const router = useRouter()

/** 正在切换的目标语言，用于禁用重复点击 */
const pending = ref<string>('')

const options = [
  { value: 'zh-CN', label: '简体中文', sub: '中国大陆' },
  { value: 'en-US', label: 'English', sub: 'International' }
]

const noteText = '之后可在设置中更改界面语言。 / UI language can be changed later in settings.'

function choose(locale: string): void {
  if (pending.value) return
  pending.value = locale

  // setLocale 会写入 localStorage，守卫据此放行。
  // 这里只定语言 —— 语言不再推导出任何「区域」，功能对所有地区一视同仁。
  setLocale(locale)

  router.replace('/')
}
</script>

<style scoped lang="less">
.language-gate {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100vw;
  height: 100vh;
  background: var(--color-bg-page);
}

.gate-card {
  width: 420px;
  padding: 40px 36px;
  text-align: center;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border, var(--color-border-subtle));
  border-radius: 12px;
}

.brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}

.brand-logo {
  width: 56px;
  height: 56px;
}

.brand-name {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.gate-hint {
  margin: 0 0 24px;
  font-size: 14px;
  color: var(--color-text-secondary, #a0a0a5);
}

.hint-divider {
  margin: 0 8px;
  opacity: 0.5;
}

.options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.option {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  cursor: pointer;
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border, var(--color-border-subtle));
  border-radius: 8px;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;

  &:hover:not(:disabled) {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border);
  }

  &:disabled {
    cursor: default;
    color: var(--color-text-disabled);
  }
}

.option--busy {
  border-color: var(--color-border);
}

.option-label {
  font-size: 16px;
  font-weight: 500;
  color: var(--color-text-primary);
}

.option-sub {
  font-size: 12px;
  color: var(--color-text-secondary, #a0a0a5);
}

.gate-note {
  margin: 24px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-text-muted);
}
</style>
