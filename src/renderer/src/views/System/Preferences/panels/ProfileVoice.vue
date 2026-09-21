<script setup lang="ts">
import AppSegmented from '@renderer/components/AppSegmented.vue'
import { useMicrophoneDevices } from '@renderer/hooks/useMicrophoneDevices'
import AppSwitch from '@renderer/components/AppSwitch.vue'
/**
 * 语音和语音助手设置。
 *
 * 助手反馈控制任务进度汇报，自动播放和无人回应时自动结束由独立开关控制。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import {
  REALTIME_ECHO_GUARDS,
  type RealtimeEchoGuard
} from '@core/shared/realtimeEchoGuard'

const aiConfigStore = useAIConfigStore()
const { t } = useI18n()
const { devices, failed, refresh } = useMicrophoneDevices()
const microphone = computed({
  get: () => aiConfigStore.voiceMicrophoneDeviceId,
  set: (id: string) => aiConfigStore.setVoiceMicrophoneDeviceId(id)
})
const microphoneOptions = computed(() => {
  const options = [
    { value: '', label: t('profile.voice.systemDefault'), disabled: false },
    ...devices.value.map((device, index) => ({
      value: device.deviceId,
      label: device.label || t('profile.voice.unnamedMicrophone', { index: index + 1 }),
      disabled: false
    }))
  ]
  if (microphone.value && !options.some((option) => option.value === microphone.value)) {
    options.push({
      value: microphone.value,
      label: t('profile.voice.microphoneUnavailable'),
      disabled: true
    })
  }
  return options
})

/**
 * 回声门限。管的是**厂商那一侧**判停有多灵敏 —— 本地的回声消除一直开着，
 * 但它压不到零，残留顶过服务端 VAD 的门限时，模型会把自己的尾音当成用户在说话
 * （对话里凭空多出没说过的话）。档位含义见 `shared/realtimeEchoGuard.ts`。
 */
const echoGuard = computed({
  get: () => aiConfigStore.voiceEchoGuard,
  set: (guard: RealtimeEchoGuard) => aiConfigStore.setVoiceEchoGuard(guard)
})

/** 同 feedbackLevelLabel：查表而不是拼 key，缺 key 才在门禁里当场暴露 */
function echoGuardLabel(guard: RealtimeEchoGuard): string {
  return t(
    {
      headset: 'profile.voice.echoGuardHeadset',
      speaker: 'profile.voice.echoGuardSpeaker',
      strong: 'profile.voice.echoGuardStrong'
    }[guard]
  )
}

/** 当前档位下那行小字。三个词本身说不清「灵敏一点」到底换来什么 */
const echoGuardHint = computed(() =>
  t(
    {
      headset: 'profile.voice.echoGuardHeadsetHint',
      speaker: 'profile.voice.echoGuardSpeakerHint',
      strong: 'profile.voice.echoGuardStrongHint'
    }[echoGuard.value]
  )
)

type VoiceFeedbackLevel = 'concise' | 'detailed'
const FEEDBACK_LEVELS: readonly VoiceFeedbackLevel[] = ['concise', 'detailed']

const feedbackLevel = computed<VoiceFeedbackLevel>({
  get: () => (aiConfigStore.voiceAntiSilenceEnabled ? 'detailed' : 'concise'),
  set: (level) => aiConfigStore.setVoiceAntiSilenceEnabled(level === 'detailed')
})

const autoHangupEnabled = computed({
  get: () => aiConfigStore.voiceAutoHangupEnabled,
  set: (enabled: boolean) => aiConfigStore.setVoiceAutoHangupEnabled(enabled)
})

const autoPlayEnabled = computed({
  get: () => aiConfigStore.voiceAutoPlayEnabled,
  set: (enabled: boolean) => aiConfigStore.setVoiceAutoPlayEnabled(enabled)
})

/** 用查表而不是模板字符串拼 key：字面量 key 才扫得到，缺 key 会在门禁里当场暴露 */
function feedbackLevelLabel(level: VoiceFeedbackLevel): string {
  return t(
    {
      concise: 'profile.voice.feedbackConcise',
      detailed: 'profile.voice.feedbackDetailed'
    }[level]
  )
}

/** 当前档位下那一行小字。两档到底差在哪，光看「简洁 / 详细」是猜不到的 */
const feedbackHint = computed(() =>
  t(
    {
      concise: 'profile.voice.feedbackConciseHint',
      detailed: 'profile.voice.feedbackDetailedHint'
    }[feedbackLevel.value]
  )
)
</script>

<template>
  <div class="settings-content">
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.voice.generalTitle') }}</h4>
      <div class="settings-list">
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.voice.microphone') }}</div>
            <div class="setting-desc">
              {{ $t(failed ? 'profile.voice.microphoneFailed' : 'profile.voice.microphoneDesc') }}
            </div>
          </div>
          <a-select
            v-model:value="microphone"
            class="microphone-select"
            :options="microphoneOptions"
            :aria-label="$t('profile.voice.microphone')"
            @dropdown-visible-change="refresh"
          />
        </div>
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.voice.echoGuard') }}</div>
            <div class="setting-desc">{{ echoGuardHint }}</div>
          </div>
          <!-- @vue-generic {RealtimeEchoGuard} -->
          <AppSegmented
            v-model="echoGuard"
            :options="REALTIME_ECHO_GUARDS"
            :aria-label="$t('profile.voice.echoGuard')"
          >
            <template #default="{ option: guard }">
              {{ echoGuardLabel(guard) }}
            </template>
          </AppSegmented>
        </div>
      </div>
    </section>
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.voice.title') }}</h4>
      <div class="settings-list">
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.voice.autoPlay') }}</div>
            <div class="setting-desc">{{ $t('profile.voice.autoPlayDesc') }}</div>
          </div>
          <AppSwitch v-model:checked="autoPlayEnabled" :aria-label="$t('profile.voice.autoPlay')" />
        </div>
      </div>
    </section>
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.voice.assistantTitle') }}</h4>
      <div class="settings-list">
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.voice.feedback') }}</div>
            <div class="setting-desc">{{ feedbackHint }}</div>
          </div>
          <!-- @vue-generic {typeof FEEDBACK_LEVELS[number]} -->
          <AppSegmented
            v-model="feedbackLevel"
            :options="FEEDBACK_LEVELS"
            :aria-label="$t('profile.voice.feedback')"
          >
            <template #default="{ option: level }">
              {{ feedbackLevelLabel(level) }}
            </template>
          </AppSegmented>
        </div>
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.voice.autoHangup') }}</div>
            <div class="setting-desc">{{ $t('profile.voice.autoHangupDesc') }}</div>
          </div>
          <AppSwitch
            v-model:checked="autoHangupEnabled"
            :aria-label="$t('profile.voice.autoHangup')"
          />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped lang="less">
.microphone-select {
  flex: 0 1 50%;
  min-width: 0;
}

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
</style>
