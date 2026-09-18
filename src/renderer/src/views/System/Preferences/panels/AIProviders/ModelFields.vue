<script setup lang="ts">
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
/**
 * 模型详情面板 —— 管理弹窗右侧、选中一个模型时显示的内容。
 *
 * **不是弹窗**。层级已经够深了（设置页 → 管理弹窗），再套一层对话框
 * 用户就不知道自己在哪儿了。左侧树选中谁，这里就换成谁。
 *
 * 里面再分两档：常改的（ID、显示名、能力）摊开，很少碰的（规格、思考档位）
 * 收进「高级设置」。
 */
import { computed, ref } from 'vue'
import { defaultSpeechVoice } from '@core/shared/speech'
import {
  DOUBAO_DEFAULT_REALTIME_VOICE,
  DOUBAO_REALTIME_VOICE_IDS,
  isDoubaoRealtimeBaseUrl,
  isOpenAiRealtimeModelId,
  OPENAI_DEFAULT_REALTIME_VOICE,
  OPENAI_REALTIME_VOICE_IDS,
  type ModelConfig
} from '@core/shared/aiProvider'
import type { AiProvidersState } from './useAiProviders'
import ThinkingLadderField from './ThinkingLadderField.vue'

const props = defineProps<{ state: AiProvidersState; index: number }>()

/**
 * 直接读写草稿里的那一条，而不是接一个 model prop。
 *
 * 弹窗底部只有一个「保存」，所有编辑都该落在同一份草稿上 —— 中间再隔一层
 * 拷贝就得考虑什么时候同步回去，而漏同步的表现是「改了没保存上」。
 * 与 ProviderFields 读 draft 是同一个模式。
 */
const model = computed<ModelConfig | null>(
  () => props.state.draft.value?.models[props.index] ?? null
)

const providerKind = computed(() => props.state.draft.value?.kind ?? 'chat')

const realtimeVoiceOptions = computed<readonly string[]>(() => {
  if (providerKind.value !== 'realtime') return []
  if (isDoubaoRealtimeBaseUrl(props.state.draft.value?.baseUrl || '')) {
    return DOUBAO_REALTIME_VOICE_IDS
  }
  if (model.value && isOpenAiRealtimeModelId(model.value.id)) return OPENAI_REALTIME_VOICE_IDS
  return []
})

const showRealtimeVoice = computed(() => realtimeVoiceOptions.value.length > 0)

/** 老配置没有这一位时显示各家默认音色；归一化存盘时也会补上 OpenAI 的默认值。 */
const realtimeVoice = computed({
  get: () => {
    if (model.value?.realtimeVoice) return model.value.realtimeVoice
    return isDoubaoRealtimeBaseUrl(props.state.draft.value?.baseUrl || '')
      ? DOUBAO_DEFAULT_REALTIME_VOICE
      : OPENAI_DEFAULT_REALTIME_VOICE
  },
  set: (voice: string) => {
    if (model.value) model.value.realtimeVoice = voice
  }
})

/**
 * 模型级能力位。
 *
 * **只剩这四项**，因为它们是同一个 Provider 下**逐模型不同**的东西：
 * OpenAI 的 gpt-4o 看得懂图、o3-mini 不行；有的会推理、有的不会。
 *
 * 生图/3D/视频/实时语音那几位已经删掉了 —— 那是「这个 Provider 是干什么的」，
 * 一个 Provider 下不会有一半模型生图一半模型聊天。它们现在是 Provider 的用途。
 */
const CAPABILITIES = [
  'supportsVision',
  'supportsVideo',
  'supportsTools',
  'supportsReasoning'
] as const

const showAdvanced = ref(false)
</script>

<template>
  <div v-if="model" class="pane">
    <div class="pane-head">{{ $t('aiProvider.model.section') }}</div>

    <div class="grid">
      <label class="field">
        <span class="field-label">{{ $t('aiProvider.model.id') }}</span>
        <input v-model="model.id" type="text" class="field-input" placeholder="gpt-5.6" />
      </label>

      <label class="field">
        <span class="field-label">{{ $t('aiProvider.model.displayName') }}</span>
        <input
          v-model="model.displayName"
          type="text"
          class="field-input"
          :placeholder="model.id || $t('aiProvider.model.displayNamePlaceholder')"
        />
      </label>
    </div>

    <!-- 能力位只对对话类有意义：生图/3D/视频模型没有「看得懂图」「能调工具」这回事 -->
    <div v-if="providerKind === 'chat'" class="field">
      <span class="field-label">{{ $t('aiProvider.model.capabilities') }}</span>
      <div class="caps">
        <AppCheckbox
          v-for="cap in CAPABILITIES"
          :key="cap"
          v-model:checked="model[cap]"
          class="cap"
        >
          <span class="cap-text">
            <span class="cap-name">{{ $t(`aiProvider.model.${cap}`) }}</span>
            <span class="cap-desc">{{ $t(`aiProvider.model.${cap}Desc`) }}</span>
          </span>
        </AppCheckbox>
      </div>
    </div>

    <label v-if="providerKind === 'tts'" class="field">
      <span class="field-label">{{ $t('aiProvider.model.ttsVoice') }}</span>
      <input
        v-model="model.ttsVoice"
        class="field-input"
        type="text"
        :placeholder="defaultSpeechVoice(model.id)"
      />
      <span class="hint">{{ $t('aiProvider.model.ttsVoiceHint') }}</span>
    </label>

    <label v-if="showRealtimeVoice" class="field">
      <span class="field-label">{{ $t('aiProvider.model.realtimeVoice') }}</span>
      <select v-model="realtimeVoice" class="field-input">
        <option v-for="voice in realtimeVoiceOptions" :key="voice" :value="voice">
          {{ $t(`aiProvider.model.realtimeVoices.${voice}`) }}
        </option>
      </select>
    </label>
    <p v-if="showRealtimeVoice" class="hint">
      {{ $t('aiProvider.model.realtimeVoiceHint') }}
    </p>

    <!--
      规格和档位都是「配一次或者永远不配」的东西，收进高级里。
      内置目录的模型这两项已经自带，绝大多数人不用打开。
    -->
    <section class="fold">
      <button type="button" class="fold-head" @click="showAdvanced = !showAdvanced">
        <span class="fold-arrow" :class="{ open: showAdvanced }">›</span>
        {{ $t('aiProvider.model.advanced') }}
        <span class="fold-note">{{ $t('aiProvider.model.advancedNote') }}</span>
      </button>

      <div v-if="showAdvanced" class="fold-body">
        <div class="grid">
          <label class="field">
            <span class="field-label">{{ $t('aiProvider.model.contextWindow') }}</span>
            <input
              v-model.number="model.contextWindow"
              type="number"
              min="1"
              class="field-input"
              :placeholder="$t('aiProvider.model.inherit')"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ $t('aiProvider.model.maxOutputTokens') }}</span>
            <input
              v-model.number="model.maxOutputTokens"
              type="number"
              min="1"
              class="field-input"
              :placeholder="$t('aiProvider.model.inherit')"
            />
          </label>
        </div>
        <p class="hint">{{ $t('aiProvider.model.limitsHint') }}</p>

        <!-- 档位阶梯只对推理模型有意义，勾了才出现 -->
        <div v-if="model.supportsReasoning" class="ladder-block">
          <span class="field-label">{{ $t('aiProvider.model.ladder') }}</span>
          <ThinkingLadderField v-model="model.thinkingLevelMap" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pane-head {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.field-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-sunken);
  color: var(--color-text-primary);
  font-size: 13px;
}

.field-input:focus {
  outline: none;
  border-color: var(--color-accent-border);
}

.caps {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.cap {
  align-items: flex-start;
}

.cap-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cap-name {
  font-size: 13px;
  color: var(--color-text-primary);
}

.cap-desc {
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-muted);
}

.fold {
  border-top: 1px solid var(--color-border);
  padding-top: 14px;
}

.fold-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
}

.fold-arrow {
  display: inline-block;
  transition: transform 0.15s ease;
}

.fold-arrow.open {
  transform: rotate(90deg);
}

.fold-note {
  font-size: 11px;
  color: var(--color-text-muted);
}

.fold-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 14px;
}

.ladder-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-text-muted);
}
</style>
