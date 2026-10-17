<template>
  <div class="voice-status-panel">
    <span role="status" aria-live="polite">{{ voice.error.value || statusText }}</span>
    <template v-if="voice.active.value">
      <AppButton variant="text" size="small" @click="emit('open-call')">
        {{ t('assistantInputComposer.voice.boundCall', { name: boundTitle }) }}
      </AppButton>
      <AppButton
        variant="text"
        size="small"
        :aria-pressed="voice.muted.value"
        @click="voice.setMuted(!voice.muted.value)"
      >
        {{
          t(
            voice.muted.value
              ? 'assistantInputComposer.voice.unmute'
              : 'assistantInputComposer.voice.mute'
          )
        }}
      </AppButton>
    </template>
    <AppButton v-if="voice.connecting.value" variant="text" size="small" @click="voice.stop()">
      {{ t('assistantInputComposer.voice.cancelConnection') }}
    </AppButton>
    <AppButton
      v-if="voice.error.value && !voice.connecting.value && !voice.active.value"
      variant="text"
      size="small"
      @click="emit('retry')"
    >
      {{ t('assistantInputComposer.voice.retry') }}
    </AppButton>
  </div>
</template>

<script setup lang="ts">
/**
 * 语音通话的状态条：连接中 / 通话中 / 出错，以及静音、回到通话那条对话、重试。
 *
 * 首页放在问候语上方；对话页放进输入框那一层（`chatComposerRef`），
 * 这样高度算进 `--composer-height`，不会盖住铺满整页的消息区最后几行。
 */
import AppButton from '@renderer/components/AppButton.vue'
import { useI18n } from 'vue-i18n'
import type { RealtimeVoiceState } from '../composables/useRealtimeVoice'

defineProps<{
  voice: RealtimeVoiceState
  statusText: string
  boundTitle: string
}>()

const emit = defineEmits<{
  (event: 'open-call'): void
  (event: 'retry'): void
}>()

const { t } = useI18n()
</script>

<style scoped>
.voice-status-panel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}
</style>
