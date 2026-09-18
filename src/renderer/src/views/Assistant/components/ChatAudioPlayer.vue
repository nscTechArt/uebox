<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhWaveform,
  PhRepeat,
  PhPlay,
  PhPause,
  PhDotsThree,
  PhCopy,
  PhDownloadSimple
} from '@phosphor-icons/vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import { useGlobalAudioStore } from '@renderer/store/modules/globalAudio'
import { saveAudioCopy } from '@renderer/api/chatAudio'

const props = defineProps<{ filePath: string; title?: string }>()
const { t } = useI18n()
const audio = ref<HTMLAudioElement>()
const store = useGlobalAudioStore()
const src = computed(() => toLocalResourceUrl(props.filePath)!)
const selected = computed(() => toLocalResourceUrl(store.currentAudio?.src) === src.value)
const playing = computed(() => selected.value && store.isPlaying)
const current = computed(() => (selected.value ? store.currentTime : 0))
const metadataDuration = ref(0)
const duration = computed(() =>
  selected.value ? store.duration || metadataDuration.value : metadataDuration.value
)
const loop = computed(() => store.loopMode === 'single')
function toggleLoop(): void {
  store.loopMode = loop.value ? 'none' : 'single'
}
const failed = ref(false)
const actionFailed = ref(false)
const menuOpen = ref(false)
const filename = computed(() => props.filePath.split(/[\\/]/).pop() ?? props.filePath)
const format = computed(() => filename.value.split('.').pop()?.toUpperCase())
function updateTime(): void {
  const value = audio.value?.duration ?? 0
  metadataDuration.value = Number.isFinite(value) ? value : 0
}
function time(value: number): string {
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
}
function toggle(): void {
  if (playing.value) store.pause()
  else if (selected.value) store.resume()
  else store.playPlaylist([{ src: src.value, title: props.title || filename.value }])
}
function seek(event: Event): void {
  if (selected.value) store.seekTo(Number((event.target as HTMLInputElement).value))
}
async function action(kind: 'copy' | 'save'): Promise<void> {
  menuOpen.value = false
  actionFailed.value = false
  try {
    if (kind === 'copy') await navigator.clipboard.writeText(props.filePath)
    else await saveAudioCopy(props.filePath)
  } catch {
    actionFailed.value = true
  }
}
</script>

<template>
  <section class="chat-audio" :aria-label="title || filename">
    <audio
      ref="audio"
      :src="toLocalResourceUrl(filePath)"
      preload="metadata"
      @loadedmetadata="updateTime"
      @durationchange="updateTime"
      @error="failed = true"
    />
    <div class="audio-heading">
      <PhWaveform class="audio-icon" aria-hidden="true" />
      <div class="audio-name">
        <strong :title="filePath">{{ title || filename }}</strong
        ><span>{{ t('assistant.musicPlayer.audio', { format }) }}</span>
      </div>
      <button
        type="button"
        class="audio-button"
        :aria-label="t(playing ? 'assistant.musicPlayer.pause' : 'assistant.musicPlayer.play')"
        @click="toggle"
      >
        <PhPause v-if="playing" /><PhPlay v-else />
      </button>
      <button
        type="button"
        class="audio-button"
        :class="{ 'is-active': loop }"
        :aria-pressed="loop"
        :aria-label="t('assistant.musicPlayer.loop')"
        :title="t('assistant.musicPlayer.loop')"
        @click="toggleLoop"
      >
        <PhRepeat />
      </button>
      <AppDropdown v-model:open="menuOpen" placement="bottomRight">
        <button type="button" class="audio-button" :aria-label="t('assistant.musicPlayer.more')">
          <PhDotsThree />
        </button>
        <template #overlay
          ><AppMenu>
            <AppMenuItem @click="action('copy')"
              ><PhCopy /> {{ t('assistant.musicPlayer.copy') }}</AppMenuItem
            >
            <AppMenuItem @click="action('save')"
              ><PhDownloadSimple /> {{ t('assistant.musicPlayer.save') }}</AppMenuItem
            >
          </AppMenu></template
        >
      </AppDropdown>
    </div>
    <div class="audio-progress">
      <input
        type="range"
        min="0"
        :max="duration || 0"
        step="0.1"
        :value="current"
        :disabled="!duration || !selected"
        :aria-label="t('assistant.musicPlayer.seek')"
        @input="seek"
      />
      <span>{{ time(current) }} / {{ time(duration) }}</span>
    </div>
    <p v-if="failed || actionFailed" role="alert">
      {{ t(failed ? 'assistant.musicPlayer.error' : 'assistant.musicPlayer.actionError') }}
    </p>
  </section>
</template>

<style scoped>
.chat-audio {
  width: 100%;
  max-width: 36rem;
  margin-block: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  background: var(--color-bg-surface);
  overflow: hidden;
}
.audio-heading {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
}
.audio-icon {
  flex-shrink: 0;
  font-size: var(--font-size-xl);
  color: var(--color-accent-text);
}
.audio-name {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.audio-name strong {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.audio-name span,
.audio-progress {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}
.audio-button {
  display: inline-flex;
  padding: var(--space-2);
  border: 0;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-primary);
  cursor: pointer;
}
.audio-button:hover {
  background: var(--color-bg-surface-hover);
}
.audio-button:focus-visible {
  outline: 2px solid var(--color-accent-text);
}
.audio-progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-border);
}
.audio-progress input {
  flex: 1;
  min-width: 0;
  accent-color: var(--color-accent-text);
}
.audio-progress span {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
p {
  padding-inline: var(--space-3);
  color: var(--color-text-secondary);
}
</style>

<style scoped>
.audio-button.is-active {
  color: var(--color-accent-text);
  background: var(--color-bg-selected);
}
</style>
