<script setup lang="ts">
/** 信息图生图模型选择器：只展示用户已经配置且可用的模型。 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { PhArrowClockwise, PhCheckCircle, PhCircleNotch, PhX } from '@phosphor-icons/vue'
import {
  buildInfographicModelOptions,
  getDefaultInfographicPrompt,
  resolveInfographicModelSelection,
  type InfographicModelOption
} from '@renderer/services/infographic'
import { useInfographicGenerationStore } from '@renderer/store/modules/infographicGenerationStore'

const { t } = useI18n()
const router = useRouter()

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
  (e: 'confirm'): void
}>()

const infographicStore = useInfographicGenerationStore()
const selectedModel = ref('')
const modelOptions = ref<InfographicModelOption[]>([])
const promptTemplate = ref('')
const promptCustomized = ref(false)
const loading = ref(false)
const loadError = ref('')
let loadRevision = 0

const selectedOption = computed(() =>
  modelOptions.value.find((option) => option.id === selectedModel.value)
)

function handleClose(): void {
  loadRevision += 1
  emit('update:visible', false)
}

async function goToModelSettings(): Promise<void> {
  handleClose()
  await router.push('/preferences?tab=models')
}

async function loadModelOptions(): Promise<void> {
  const revision = ++loadRevision
  loading.value = true
  loadError.value = ''
  modelOptions.value = []

  try {
    const settings = await window.api.aiProvider.getSettings()
    if (revision !== loadRevision || !props.visible) return

    const options = buildInfographicModelOptions(settings)
    if (options.length === 0) {
      await goToModelSettings()
      return
    }

    modelOptions.value = options
    selectedModel.value = resolveInfographicModelSelection(
      options,
      infographicStore.config,
      settings
    )
    const selected = options.find((option) => option.id === selectedModel.value)
    const savedPrompt = infographicStore.config.prompt
    promptCustomized.value = Boolean(savedPrompt?.trim())
    promptTemplate.value = savedPrompt?.trim()
      ? savedPrompt
      : getDefaultInfographicPrompt(selected?.providerId)
  } catch (error) {
    if (revision !== loadRevision || !props.visible) return
    console.error('[InfographicConfigModal] 加载生图模型失败:', error)
    loadError.value = t('notebook.infographicConfig.loadFailed')
  } finally {
    if (revision === loadRevision) loading.value = false
  }
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) void loadModelOptions()
    else loadRevision += 1
  },
  { immediate: true }
)

function handleSelectModel(option: InfographicModelOption): void {
  selectedModel.value = option.id
  if (!promptCustomized.value) {
    promptTemplate.value = getDefaultInfographicPrompt(option.providerId)
  }
}

function handlePromptInput(): void {
  promptCustomized.value = true
}

function handleResetPrompt(): void {
  promptCustomized.value = false
  promptTemplate.value = getDefaultInfographicPrompt(selectedOption.value?.providerId)
}

function handleConfirm(): void {
  const option = selectedOption.value
  if (!option) return

  infographicStore.updateConfig({
    providerId: option.providerId,
    modelId: option.modelId,
    imageSize: option.imageSize,
    aspectRatio: option.aspectRatio,
    prompt:
      promptTemplate.value.trim() === getDefaultInfographicPrompt(option.providerId).trim()
        ? undefined
        : promptTemplate.value.trim() || undefined
  })
  emit('confirm')
  handleClose()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click.self="handleClose">
      <section
        class="modal-container"
        role="dialog"
        aria-modal="true"
        aria-labelledby="infographic-model-dialog-title"
        @keydown.esc="handleClose"
      >
        <header class="modal-header">
          <h3 id="infographic-model-dialog-title">{{ t('notebook.infographicConfig.title') }}</h3>
          <button
            type="button"
            class="close-btn"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            @click="handleClose"
          >
            <PhX />
          </button>
        </header>

        <div class="modal-body">
          <div v-if="loading" class="status-state" aria-live="polite">
            <PhCircleNotch class="loading-icon" />
            <span>{{ t('notebook.infographicConfig.loading') }}</span>
          </div>

          <div v-else-if="loadError" class="status-state status-state--error" role="alert">
            <span>{{ loadError }}</span>
            <button type="button" class="retry-btn" @click="loadModelOptions">
              <PhArrowClockwise />
              <span>{{ t('notebook.infographicConfig.retry') }}</span>
            </button>
          </div>

          <div v-else class="model-section">
            <div class="section-label">{{ t('notebook.infographicConfig.modelLabel') }}</div>
            <div class="model-list">
              <button
                v-for="option in modelOptions"
                :key="option.id"
                type="button"
                class="model-option"
                :class="{ selected: selectedModel === option.id }"
                :aria-pressed="selectedModel === option.id"
                @click="handleSelectModel(option)"
              >
                <span class="option-header">
                  <span class="option-name">{{ option.modelName }}</span>
                  <PhCheckCircle
                    v-if="selectedModel === option.id"
                    weight="fill"
                    class="check-icon"
                    aria-hidden="true"
                  />
                </span>
                <span class="option-meta">
                  <span class="option-description">{{ option.providerName }}</span>
                  <span v-if="option.modelName !== option.modelId" class="option-model-id">
                    {{ option.modelId }}
                  </span>
                </span>
              </button>
            </div>
          </div>

          <div v-if="!loading && !loadError && modelOptions.length" class="prompt-editor">
            <div class="prompt-header">
              <label class="section-label" for="infographic-prompt">{{
                t('notebook.infographicConfig.promptLabel')
              }}</label>
              <button
                type="button"
                class="reset-prompt-btn"
                :disabled="!promptCustomized"
                @click="handleResetPrompt"
              >
                {{ t('notebook.infographicConfig.resetPrompt') }}
              </button>
            </div>
            <textarea
              id="infographic-prompt"
              v-model="promptTemplate"
              class="prompt-input"
              :placeholder="t('notebook.infographicConfig.promptPlaceholder')"
              :aria-describedby="'infographic-prompt-help'"
              spellcheck="false"
              @input="handlePromptInput"
            />
            <p id="infographic-prompt-help" class="prompt-help">
              {{
                t('notebook.infographicConfig.promptHelp', {
                  title: '{title}',
                  content: '{content}'
                })
              }}
            </p>
          </div>
        </div>

        <footer class="modal-footer">
          <button type="button" class="cancel-btn" @click="handleClose">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="confirm-btn"
            :disabled="loading || !selectedOption"
            @click="handleConfirm"
          >
            {{ t('common.confirm') }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped lang="less">
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  /*
    原来这里用的是 --color-bg-surface —— 那是**不透明**的面板底色，
    整块盖住页面，看着像换了一屏而不是弹了一层。遮罩要用 scrim。
  */
  background: var(--color-bg-scrim);
  backdrop-filter: blur(var(--blur-md));
}

.modal-container {
  display: flex;
  flex-direction: column;
  width: min(600px, calc(100vw - var(--space-8)));
  max-height: min(80vh, 720px);
  overflow: hidden;
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-modal);
}

.modal-header,
.modal-footer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  padding: var(--space-5) var(--space-6);
}

.modal-header {
  justify-content: space-between;
  border-bottom: 1px solid var(--color-border);

  h3 {
    margin: 0;
    color: var(--color-text-primary);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
  }
}

.close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--space-8);
  height: var(--space-8);
  padding: 0;
  color: var(--color-text-primary);
  background: transparent;
  border: 0;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition:
    color var(--motion-fast),
    background var(--motion-fast);

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

.modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6);
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;

  &::-webkit-scrollbar {
    width: var(--space-2);
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-surface-hover);
    border-radius: var(--radius-full);
  }
}

/*
  这里原来自己也是一块 `max-height + overflow-y: auto` 的滚动区，套在同样能滚的
  modal-body 里 —— 一个弹窗上同时挂着两条滚动条，鼠标停在哪儿滚的是哪一层全靠猜。
  现在只留 modal-body 一层滚动。
*/
.model-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.model-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* 两块内容（模型 / 提示词）用同一种小标题，读起来才是「两节」而不是「一堆」 */
.section-label {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.option-meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.prompt-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-5);
}

.prompt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);

  label {
    color: var(--color-text-primary);
    font-size: var(--font-size-base);
    font-weight: var(--font-weight-semibold);
  }
}

.reset-prompt-btn {
  min-height: var(--space-8);
  padding: var(--space-1) var(--space-3);
  color: var(--color-text-primary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-accent-border);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }

  &:disabled {
    color: var(--color-text-disabled);
    cursor: not-allowed;
  }
}

/*
  提示词有几十行。原来 min 180 / max 320 被外层挤到只剩一百多像素高，
  改一句话要在里面上下滚 —— 去掉 max-height，让它跟着弹窗一起长。
*/
.prompt-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 300px;
  padding: var(--space-4);
  color: var(--color-text-primary);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-relaxed);
  resize: vertical;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);

  &::placeholder {
    color: var(--color-text-muted);
  }

  &:hover {
    border-color: var(--color-border-strong);
  }

  &:focus {
    border-color: var(--color-accent-border);
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
  }
}

.prompt-help {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
}

/*
  卡片压扁：原来一张卡 padding 20px + 三行堆叠 + 2px 边框，一屏只放得下两个，
  于是选个模型要滚半天。现在一行标题 + 一行灰色小字，同样的高度能放五六个。
*/
.model-option {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-3) var(--space-4);
  color: var(--color-text-primary);
  text-align: left;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition:
    border-color var(--motion-fast),
    background var(--motion-fast);

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }

  &.selected {
    background: var(--color-accent-bg);
    border-color: var(--color-accent-border);
  }
}

.option-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.option-name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
}

.check-icon {
  flex: 0 0 auto;
  color: var(--color-accent-text);
  font-size: var(--font-size-base);
}

/*
  服务商和模型 id 原来都是强调色，比模型名还抢眼 —— 次要信息不该比主要信息更亮。
*/
.option-description,
.option-model-id {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  overflow-wrap: anywhere;
}

.option-model-id {
  font-family: var(--font-family-mono);
}

.status-state {
  display: flex;
  min-height: 240px;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  color: var(--color-text-secondary);

  &--error {
    flex-direction: column;
    text-align: center;
  }
}

.loading-icon {
  color: var(--color-text-primary);
  animation: spin 1s linear infinite;
}

.retry-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--space-9);
  padding: var(--space-2) var(--space-4);
  color: var(--color-accent-text);
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-accent-border);
  border-radius: var(--radius-md);
  cursor: pointer;
}

.modal-footer {
  justify-content: flex-end;
  gap: var(--space-3);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-sunken);

  button {
    min-height: var(--space-9);
    padding: var(--space-2) var(--space-6);
    border-radius: var(--radius-md);
    font-size: var(--font-size-base);
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition:
      color var(--motion-fast),
      background var(--motion-fast),
      border-color var(--motion-fast);

    &:focus-visible {
      outline: 2px solid var(--color-border-focus);
      outline-offset: 2px;
    }
  }
}

.cancel-btn {
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid var(--color-border-strong);

  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }
}

.confirm-btn {
  color: var(--color-text-on-solid);
  background: var(--color-accent-solid);
  border: 1px solid var(--color-accent-border);

  /* 原来 hover 会把主按钮刷成灰色面板底，看着像坏了。提亮就够了 */
  &:hover:not(:disabled) {
    filter: brightness(1.08);
  }

  /*
    不用 opacity 压：它把按钮往背后的底色上拖，白底浅色主题下白字直接看不见了。
    换成明确的失效语义色。
  */
  &:disabled {
    color: var(--color-text-disabled);
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border-subtle);
    box-shadow: none;
    cursor: not-allowed;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 480px) {
  .modal-container {
    max-height: calc(100vh - var(--space-8));
  }

  .modal-header,
  .modal-footer,
  .modal-body {
    padding: var(--space-4);
  }
}

@media (prefers-reduced-motion: reduce) {
  .model-option {
    transition: none;

    &:hover {
      transform: none;
    }
  }

  .loading-icon {
    animation: none;
  }
}
</style>
