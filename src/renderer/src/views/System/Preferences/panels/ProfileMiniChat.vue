<script setup lang="ts">
/**
 * MiniChat 设置组件
 * 独立管理 MiniChat 的窗口行为与透明度
 */
import { computed } from 'vue'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import AppSwitch from '@renderer/components/AppSwitch.vue'

const aiConfigStore = useAIConfigStore()

const miniChatPersistEnabled = computed({
  get: () => aiConfigStore.miniChatPersistEnabled,
  set: (value: boolean) => aiConfigStore.setMiniChatPersistEnabled(value)
})

const miniChatOpacityPercent = computed({
  get: () => Math.round(aiConfigStore.miniChatOpacity * 100),
  set: (value: number) => {
    const normalized = Math.min(100, Math.max(40, value))
    const opacity = normalized / 100
    aiConfigStore.setMiniChatOpacity(opacity)
    window.electron?.ipcRenderer.send('mini-chat:set-opacity', opacity)
  }
})
</script>

<template>
  <div class="settings-content">
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.miniChat.title') }}</h4>
      <div class="settings-list">
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.miniChat.persist') }}</div>
            <div class="setting-desc">{{ $t('profile.miniChat.persistDesc') }}</div>
          </div>
          <AppSwitch v-model:checked="miniChatPersistEnabled" />
        </div>

        <div class="setting-item vertical">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.miniChat.opacity') }}</div>
            <div class="setting-desc">{{ $t('profile.miniChat.opacityDesc') }}</div>
          </div>
          <div class="slider-row">
            <a-slider
              v-model:value="miniChatOpacityPercent"
              :min="40"
              :max="100"
              :step="5"
              class="opacity-slider"
            />
            <span class="slider-value">{{ miniChatOpacityPercent }}%</span>
          </div>
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

.section-title {
  margin: 0;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
}

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

.setting-item.vertical {
  flex-direction: column;
  align-items: stretch;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.setting-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.setting-desc {
  font-size: 12px;
  color: var(--color-text-muted);
}

.slider-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.opacity-slider {
  flex: 1;
}

.slider-value {
  min-width: 44px;
  text-align: right;
  font-size: 12px;
  color: var(--color-text-primary);
}
</style>
