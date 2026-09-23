import { computed, ref, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { speechAPI } from '@renderer/api/speech'
import { aiProviderAPI } from '@renderer/api/aiProvider'
import { message } from '@renderer/utils/messageManager'
import { MAX_SPEECH_CHARS, splitSpeechText, type SpeechAudio } from '@core/shared/speech'
import { isPlanProvider } from '@core/shared/creatorPlan'
import type { SpeechBriefingStyle } from '@core/shared/speechBriefing'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import { briefForSpeech } from './speechBriefing'
import { speechText } from './speechText'
import { SpeechPcmPlayer } from './speechPcmPlayer'
import { speechCache } from './speechCache'
import { creatorPlanErrorText, isCreatorPlanChatErrorCode } from './creatorPlanChatError'

// One reader per renderer: clicking another reply replaces the current playback.
const activeOwner = ref<string | symbol | null>(null)
const generating = ref(false)
const paused = ref(false)
const changingPlayback = ref(false)
let currentRun: symbol | null = null
let requestId: string | null = null
let audio: SpeechPcmPlayer | null = null
/*
 * 「压缩没成、改念原文」这句提示一个窗口只说一次。它多半意味着轻量模型没绑，
 * 那是要用户去设置里改一次的事，不是每次朗读都要念叨的事。
 */
let briefingFallbackWarned = false

/** 掐掉当前这一段朗读，不管是哪条气泡起的头。接通语音时要用（见 `voiceCallState`） */
export function stopReadAloud(): void {
  stopReading()
}

function stopReading(): void {
  paused.value = false
  changingPlayback.value = false
  currentRun = null
  activeOwner.value = null
  generating.value = false
  if (requestId) void speechAPI.cancel(requestId).catch(() => {})
  requestId = null
  audio?.stop()
  audio = null
}

/** Controls for the existing global player, independent of the originating tab. */
export function useSpeechPlayback(): {
  active: ComputedRef<boolean>
  paused: ComputedRef<boolean>
  changing: ComputedRef<boolean>
  stop: () => void
  togglePause: () => Promise<void>
} {
  return {
    active: computed(() => activeOwner.value !== null),
    paused: computed(() => paused.value),
    changing: computed(() => changingPlayback.value),
    stop: stopReading,
    async togglePause(): Promise<void> {
      const player = audio
      if (!player || changingPlayback.value) return
      changingPlayback.value = true
      const nextPaused = !paused.value
      try {
        if (nextPaused) await player.pause()
        else await player.resume()
        if (audio === player) paused.value = nextPaused
      } finally {
        if (audio === player) changingPlayback.value = false
      }
    }
  }
}

/**
 * @param messageId 这条朗读的主人（消息 id），同一条回复重挂载后还能控制它的播放
 * @param briefingStyle 播报风格此刻的值。默认读本窗口的设置 store；小窗那份 store
 *   是启动时抄的旧账，它得自己从 localStorage 读新鲜的递进来（见 `miniVoiceAutoPlay`）
 */
export function useReadAloud(
  messageId?: () => string,
  briefingStyle?: () => SpeechBriefingStyle
): {
  active: ComputedRef<boolean>
  loading: ComputedRef<boolean>
  label: ComputedRef<string>
  toggle: (text: string) => Promise<void>
  stop: () => void
} {
  // Stable message identity lets a remounted reply control its ongoing playback.
  const fallbackOwner = Symbol('read-aloud')
  const owner = computed(() => messageId?.() ?? fallbackOwner)
  const { t } = useI18n()
  const aiConfigStore = useAIConfigStore()
  const style = briefingStyle ?? ((): SpeechBriefingStyle => aiConfigStore.voiceBriefingStyle)
  const active = computed(() => activeOwner.value === owner.value)
  const loading = computed(() => active.value && generating.value)
  const label = computed(() =>
    t(`assistant.readAloud.${loading.value ? 'loading' : active.value ? 'stop' : 'start'}`)
  )
  const stop = (): void => {
    if (active.value) stopReading()
  }
  // Playback belongs to the renderer, not the page's mount/activation lifetime.

  async function toggle(text: string): Promise<void> {
    if (active.value) {
      stopReading()
      return
    }
    stopReading()
    const plain = speechText(text)
    if (!splitSpeechText(plain).length) {
      message.info(t('assistant.readAloud.empty'))
      return
    }
    activeOwner.value = owner.value
    // A unique run ID also rejects responses from an older run of the same bubble.
    const run = Symbol('reading')
    currentRun = run
    try {
      generating.value = true
      const player = new SpeechPcmPlayer()
      audio = player
      await player.ready
      /*
       * 先压再合成。压是要等模型的，这段时间按钮显示「正在合成」，用户点一下照样
       * 能掐掉 —— 掐掉后 run 已经换了，下面的检查会让这次静静退出。
       * 压坏了、压出来念不出声，`briefForSpeech` 自己会退回原文。
       */
      const briefed = await briefForSpeech(text, style(), {
        plainText: plain,
        onFallback: (reason) => {
          if (reason !== 'error' || briefingFallbackWarned) return
          briefingFallbackWarned = true
          message.warning(t('assistant.readAloud.briefingFallback'))
        }
      })
      if (currentRun !== run) return
      const plainText = briefed === text ? plain : speechText(briefed)
      const settings = await aiProviderAPI.getSettings()
      if (currentRun !== run) return
      const binding = settings.roles.tts
      const provider = settings.providers.find((item) => item.id === binding?.providerId)
      const model = provider?.models.find((item) => item.id === binding?.modelId)
      // Box Plan 单次能收的字数在清单里（max_input_chars），按它切；别的来源 600 字
      const chunks = splitSpeechText(
        plainText,
        provider && isPlanProvider(provider.id)
          ? (model?.ttsMaxInputChars ?? MAX_SPEECH_CHARS)
          : MAX_SPEECH_CHARS
      )
      const cacheKey = JSON.stringify([plainText, binding, provider?.baseUrl, model?.ttsVoice])
      const cached = speechCache.get(cacheKey)
      if (cached) {
        for (const frame of cached) {
          await player.waitForRoom()
          if (currentRun !== run) return
          if (player.enqueue(frame)) generating.value = false
        }
        await player.drain()
        return
      }
      const frames: SpeechAudio[] = []
      let cacheSize = cacheKey.length * 2
      for (const chunk of chunks) {
        await player.waitForRoom()
        if (currentRun !== run) return
        const id = crypto.randomUUID()
        requestId = id
        await speechAPI.synthesize({ requestId: id, text: chunk }, (frame) => {
          if (currentRun !== run) return
          if (player.enqueue(frame)) generating.value = false
          cacheSize += frame.base64.length * 2 + 64
          if (cacheSize <= speechCache.capacity) frames.push(frame)
          else frames.length = 0
        })
        if (currentRun !== run) return
        requestId = null
      }
      await player.drain()
      if (currentRun === run) speechCache.set(cacheKey, frames)
    } catch (error) {
      if (currentRun !== run) return
      console.error('[ReadAloud] Playback failed', error)
      // Box Plan 的订阅 / 额度 / 授权错误（主进程回 TTS_PLAN_<码>）：用对话里同一套文案
      const planCode =
        error instanceof Error ? error.message.match(/TTS_PLAN_([A-Z_]+)/)?.[1]?.toLowerCase() : ''
      if (isCreatorPlanChatErrorCode(planCode)) {
        message.error(creatorPlanErrorText(planCode, t))
        return
      }
      message.error(
        t(
          error instanceof Error && error.message.includes('TTS_NOT_CONFIGURED')
            ? 'assistant.readAloud.missing'
            : 'assistant.readAloud.failed'
        )
      )
    } finally {
      if (currentRun === run) stopReading()
    }
  }
  return { active, loading, label, toggle, stop }
}
