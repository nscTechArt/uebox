<template>
  <Transition name="player-slide">
    <div
      v-if="showPlayer || speech.active.value"
      ref="playerRef"
      class="global-audio-player"
      :class="{ 'is-dragging': isDragging }"
      :style="playerStyle"
    >
      <div
        class="player-container"
        :class="{ 'is-expanded': !speech.active.value && (isHovering || isSeeking) }"
        @mouseenter="onMouseEnter"
        @mouseleave="onMouseLeave"
      >
        <div class="player-main-content">
          <!-- 拖拽区域 -->
          <div class="drag-handle" @mousedown="startDrag" @touchstart="startDrag"></div>

          <!-- 音频信息 -->
          <div class="audio-info">
            <div class="audio-title-wrapper">
              <div class="audio-title" :class="{ 'is-scrolling': shouldScroll }">
                <span ref="titleTextRef">{{
                  speech.active.value
                    ? $t('assistant.readAloud.playerTitle')
                    : currentAudio?.title || $t('globalAudioPlayer.defaultTitle')
                }}</span>
              </div>
            </div>
          </div>

          <!-- 音频控制器 -->
          <audio
            ref="audioRef"
            preload="none"
            crossorigin="anonymous"
            @canplay="handleCanPlay"
            @canplaythrough="handleCanPlayThrough"
            @loadeddata="handleLoadedData"
            @loadedmetadata="handleLoadedMetadata"
            @durationchange="handleDurationChange"
            @timeupdate="handleTimeUpdate"
            @play="handlePlay"
            @pause="handlePause"
            @ended="handleEnded"
            @error="handleError"
            @waiting="handleWaiting"
            @playing="handlePlaying"
          />

          <!-- 播放控制按钮 -->
          <div v-if="speech.active.value" class="player-controls">
            <AppButton
              variant="text"
              :aria-label="
                $t(speech.paused.value ? 'assistant.readAloud.resume' : 'assistant.readAloud.pause')
              "
              :title="
                $t(speech.paused.value ? 'assistant.readAloud.resume' : 'assistant.readAloud.pause')
              "
              :disabled="speech.changing.value"
              @click="toggleSpeechPlayback"
            >
              <PhPlayCircle v-if="speech.paused.value" />
              <PhPauseCircle v-else />
            </AppButton>
            <AppButton
              variant="text"
              :aria-label="$t('assistant.readAloud.stop')"
              :title="$t('assistant.readAloud.stop')"
              @click="speech.stop"
            >
              <PhX />
            </AppButton>
          </div>
          <div v-else class="player-controls">
            <!-- 循环模式（hover 时显示） -->
            <Transition name="fade">
              <PhRepeat
                v-show="isHovering || isSeeking"
                class="control-btn loop-btn"
                :class="{ 'is-active': loopMode !== 'none', 'is-single': loopMode === 'single' }"
                :title="
                  loopMode === 'none'
                    ? $t('globalAudioPlayer.loopTooltip.listLoop')
                    : loopMode === 'single'
                      ? $t('globalAudioPlayer.loopTooltip.singleLoop')
                      : $t('globalAudioPlayer.loopTooltip.off')
                "
                @click="audioStore.toggleLoop()"
              />
            </Transition>
            <!-- 上一首（hover 时显示） -->
            <Transition name="fade">
              <PhSkipBack
                v-show="isHovering || isSeeking"
                class="control-btn nav-btn"
                :class="{ disabled: !canPlayPrev }"
                @click="audioStore.playPrev()"
              />
            </Transition>
            <!-- 播放/暂停 -->
            <PhPlayCircle v-if="!isPlaying" class="control-btn play-btn" @click="togglePlay" />
            <PhPauseCircle v-else class="control-btn pause-btn" @click="togglePlay" />
            <!-- 下一首（hover 时显示） -->
            <Transition name="fade">
              <PhSkipForward
                v-show="isHovering || isSeeking"
                class="control-btn nav-btn"
                :class="{ disabled: !canPlayNext }"
                @click="audioStore.playNext()"
              />
            </Transition>
            <!-- 关闭 -->
            <PhX class="control-btn close-btn" @click="closePlayer" />
          </div>
        </div>

        <!-- 进度条区域 -->
        <Transition name="fade">
          <div v-show="!speech.active.value && (isHovering || isSeeking)" class="progress-section">
            <span class="time-text">{{ formatTime(currentTime) }}</span>
            <div
              ref="progressBarRef"
              class="progress-bar-wrapper"
              @click="handleSeek"
              @mousedown="startSeekDrag"
            >
              <div class="progress-track">
                <div class="progress-fill" :style="{ width: `${progressPercent}%` }"></div>
                <div class="progress-thumb" :style="{ left: `${progressPercent}%` }"></div>
              </div>
            </div>
            <span class="time-text">{{ formatTime(duration) }}</span>
          </div>
        </Transition>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import AppButton from '@renderer/components/AppButton.vue'
import { useSpeechPlayback } from '@renderer/views/Assistant/composables/useReadAloud'
import { useI18n } from 'vue-i18n'
import { useGlobalAudioStore } from '@renderer/store/modules/globalAudio'
import { storeToRefs } from 'pinia'
import {
  PhPauseCircle,
  PhPlayCircle,
  PhRepeat,
  PhSkipBack,
  PhSkipForward,
  PhX
} from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'
import { toLocalResourceUrl } from '@renderer/utils/localResource'

const { t } = useI18n()
const audioStore = useGlobalAudioStore()
const speech = useSpeechPlayback()
watch(speech.active, (active) => {
  if (active) audioStore.pause()
})
async function toggleSpeechPlayback(): Promise<void> {
  try {
    await speech.togglePause()
  } catch {
    message.error(t('assistant.readAloud.failed'))
  }
}
const {
  currentAudio,
  isPlaying,
  showPlayer,
  loopMode,
  canPlayPrev,
  canPlayNext,
  currentTime,
  duration
} = storeToRefs(audioStore)

const audioRef = ref<HTMLAudioElement | null>(null)
const playerRef = ref<HTMLElement | null>(null)
const progressBarRef = ref<HTMLElement | null>(null)
const titleTextRef = ref<HTMLElement | null>(null)

// 播放进度相关
watch(
  () => audioStore.seekRequest,
  (request) => {
    if (request && audioRef.value) {
      audioRef.value.currentTime = request.time
      currentTime.value = request.time
    }
  }
)
const isHovering = ref(false)
const isMouseOver = ref(false) // 鼠标是否在播放器内
let hoverTimer: ReturnType<typeof setTimeout> | null = null
const isSeeking = ref(false) // 是否正在拖拽进度条
const isSwitchingAudio = ref(false) // 是否正在切换音频源

// 歌名是否需要滚动（超过容器宽度时启用跑马灯）
const shouldScroll = computed(() => {
  if (!titleTextRef.value) return false
  const textWidth = titleTextRef.value.scrollWidth
  const containerWidth = titleTextRef.value.parentElement?.clientWidth || 0
  return textWidth > containerWidth
})

// 进度百分比
const progressPercent = computed(() => {
  if (!duration.value) return 0
  return (currentTime.value / duration.value) * 100
})

// 格式化时间
const formatTime = (seconds: number): string => {
  if (!isFinite(seconds) || seconds < 0) return '00:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

// 拖拽状态
const isDragging = ref(false)
const dragOffset = ref({ x: 0, y: 0 })
const position = ref({ x: 0, y: 0 })

// 自动关闭定时器
let autoCloseTimer: ReturnType<typeof setTimeout> | null = null

// 音频加载完成后的播放回调（用于清理）
let pendingPlayCallback: (() => void) | null = null

// 播放器样式
const playerStyle = computed(() => {
  if (position.value.x === 0 && position.value.y === 0) {
    // 默认位置(右下角)
    return {
      bottom: '24px',
      right: '24px',
      left: 'auto',
      top: 'auto'
    }
  }
  return {
    left: `${position.value.x}px`,
    top: `${position.value.y}px`,
    bottom: 'auto',
    right: 'auto'
  }
})

/**
 * 监听播放状态变化,控制音频播放/暂停
 */
watch(isPlaying, async (playing) => {
  if (playing && autoCloseTimer) {
    clearTimeout(autoCloseTimer)
    autoCloseTimer = null
  }
  if (playing && speech.active.value) speech.stop()
  // 等待 audioRef 可用（组件可能还没挂载）
  if (!audioRef.value) {
    // 先等待 nextTick
    await nextTick()
    // 如果还是不存在，再等待最多 1 秒
    if (!audioRef.value) {
      let attempts = 0
      while (!audioRef.value && attempts < 100) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        attempts++
      }
      if (!audioRef.value) {
        return
      }
    }
  }

  if (playing) {
    // 如果音频源还没设置，等待 src watch 来设置
    if (!audioRef.value.src) {
      return
    }

    // 尝试播放音频
    const playAudio = (): void => {
      if (!audioRef.value || !isPlaying.value) {
        return
      }

      audioRef.value.play().catch(() => {
        // 如果音频未准备好，等待加载完成
        if (audioRef.value && audioRef.value.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          // 等待 canplay 事件
          const playWhenReady = (): void => {
            if (audioRef.value && isPlaying.value) {
              audioRef.value.play().catch(() => {
                message.error(t('globalAudioPlayer.errors.playFailed'))
                audioStore.setPlaying(false)
              })
            }
          }
          audioRef.value.addEventListener('canplay', playWhenReady, { once: true })
          audioRef.value.addEventListener('loadeddata', playWhenReady, { once: true })
        } else {
          message.error(t('globalAudioPlayer.errors.playFailed'))
          audioStore.setPlaying(false)
        }
      })
    }

    // 立即尝试播放
    playAudio()
  } else {
    audioRef.value.pause()
  }
})

/**
 * 监听音频源变化,自动播放新音频
 */
watch(
  () => currentAudio.value?.src,
  async (newSrc) => {
    if (!newSrc) {
      return
    }

    // 等待 audioRef 可用（组件可能还没挂载）
    if (!audioRef.value) {
      // 先等待 nextTick
      await nextTick()
      // 如果还是不存在，再等待最多 1 秒
      if (!audioRef.value) {
        let attempts = 0
        while (!audioRef.value && attempts < 100) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          attempts++
        }
        if (!audioRef.value) {
          return
        }
      }
    }

    if (audioRef.value) {
      isSwitchingAudio.value = true

      // 清理之前的播放回调
      if (pendingPlayCallback && audioRef.value) {
        audioRef.value.removeEventListener('canplay', pendingPlayCallback)
        audioRef.value.removeEventListener('loadeddata', pendingPlayCallback)
        pendingPlayCallback = null
      }

      // 保存当前播放状态
      const shouldAutoPlay = isPlaying.value

      // 先暂停当前播放（如果正在播放），避免在加载新音频时出现错误
      if (audioRef.value && !audioRef.value.paused) {
        audioRef.value.pause()
      }

      // 直接设置音频源，确保立即更新（不依赖模板绑定）
      // 本地路径 / file:// 一律转成 local-resource://，否则 dev 模式下加载不了
      audioRef.value.src = toLocalResourceUrl(newSrc) ?? newSrc

      // 重置并加载新音频
      audioRef.value.load()

      // 等待下一个 tick,确保 DOM 已更新
      await nextTick()

      // 如果需要自动播放，等待音频加载完成后再播放
      if (shouldAutoPlay) {
        const tryAutoPlay = (): void => {
          isSwitchingAudio.value = false

          // 如果用户在加载过程中手动暂停了，则不再自动播放
          if (!isPlaying.value) {
            return
          }

          if (audioRef.value && audioRef.value.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            // 如果有指定起始时间，先设置播放位置（用于从页面播放器切换时保持进度）
            const startTime = currentAudio.value?.startTime
            if (startTime && startTime > 0 && audioRef.value.duration) {
              // 确保 startTime 不超过音频时长
              audioRef.value.currentTime = Math.min(startTime, audioRef.value.duration)
            }

            // 确保播放状态为 true
            if (!isPlaying.value) {
              audioStore.setPlaying(true)
            } else {
              // 如果已经是 true，直接尝试播放（可能 watch 没有触发）
              audioRef.value.play().catch(() => {
                message.error(t('globalAudioPlayer.errors.playFailed'))
                audioStore.setPlaying(false)
              })
            }
            // 清理回调引用
            pendingPlayCallback = null
          }
        }

        // 保存回调引用，以便后续清理
        pendingPlayCallback = tryAutoPlay

        // 如果音频已经准备好，立即尝试播放
        if (audioRef.value.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          tryAutoPlay()
        } else {
          // 否则等待 canplay 或 loadeddata 事件
          audioRef.value.addEventListener('canplay', tryAutoPlay, { once: true })
          audioRef.value.addEventListener('loadeddata', tryAutoPlay, { once: true })
        }
      } else {
        isSwitchingAudio.value = false
      }
    }
  },
  { immediate: true }
)

/**
 * 切换播放/暂停
 */
function togglePlay(): void {
  if (isPlaying.value) {
    audioStore.pause()
  } else {
    audioStore.resume()
  }
}

/**
 * 关闭播放器
 */
function closePlayer(): void {
  audioStore.stop()
}

/**
 * 音频可以播放时触发(已加载足够数据)
 */
function handleCanPlay(): void {
  // 如果状态是播放中,则自动开始播放
  if (isPlaying.value && audioRef.value) {
    audioRef.value.play().catch(() => {
      message.error(t('globalAudioPlayer.errors.playFailed'))
      audioStore.setPlaying(false)
    })
  }
}

/**
 * 音频开始播放时触发
 */
function handlePlay(): void {
  audioStore.setPlaying(true)
}

/**
 * 音频暂停时触发
 */
function handlePause(): void {
  if (isSwitchingAudio.value) return
  audioStore.setPlaying(false)
}

/**
 * 音频播放结束时触发
 */
function handleEnded(): void {
  isSwitchingAudio.value = false

  // 清除之前的定时器
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer)
    autoCloseTimer = null
  }

  // 让 store 处理循环逻辑
  const endedSrc = currentAudio.value?.src
  const shouldContinue = audioStore.handleEnded()

  if (shouldContinue && currentAudio.value?.src === endedSrc && audioRef.value) {
    // 单曲循环：重新播放当前歌曲
    audioRef.value.currentTime = 0
    audioRef.value.play().catch(() => {
      message.error(t('globalAudioPlayer.errors.playFailed'))
      audioStore.setPlaying(false)
    })
  } else if (!shouldContinue) {
    // 没有继续播放，5秒后自动关闭播放器
    autoCloseTimer = setTimeout(() => {
      audioStore.stop()
      autoCloseTimer = null
    }, 5000)
  }
}

/**
 * 音频加载错误时触发
 */
function handleError(event: Event): void {
  isSwitchingAudio.value = false
  const audioElement = event.target as HTMLAudioElement
  const error = audioElement?.error
  // 对于流式音频，某些错误可能是暂时的（如网络波动），不立即提示
  if (error?.code === MediaError.MEDIA_ERR_NETWORK) {
    return
  }
  message.error(t('globalAudioPlayer.errors.loadFailed'))
  audioStore.setPlaying(false)
}

/**
 * 音频可以完整播放时触发（已缓冲足够数据）
 */
function handleCanPlayThrough(): void {
  // 音频已缓冲足够数据，可以流畅播放
}

/**
 * 音频数据加载完成时触发
 */
function handleLoadedData(): void {
  // 对于流式音频，数据加载后立即尝试播放
  if (isPlaying.value && audioRef.value) {
    audioRef.value.play().catch(() => {
      // 播放失败，忽略（可能还在加载中）
    })
  }
}

/**
 * 音频等待更多数据时触发（缓冲中）
 */
function handleWaiting(): void {
  // 音频正在缓冲
}

/**
 * 音频开始真正播放时触发（从 waiting 状态恢复）
 */
function handlePlaying(): void {
  audioStore.setPlaying(true)
}

/**
 * 更新播放进度
 */
function handleTimeUpdate(e: Event): void {
  if (isSeeking.value) return // 拖拽进度条时不更新
  const audio = e.target as HTMLAudioElement
  currentTime.value = audio.currentTime
}

/**
 * 音频元数据加载完成
 */
function handleLoadedMetadata(e: Event): void {
  const audio = e.target as HTMLAudioElement
  duration.value = audio.duration
}

/**
 * 音频时长变化
 */
function handleDurationChange(e: Event): void {
  const audio = e.target as HTMLAudioElement
  duration.value = audio.duration
}

/**
 * 鼠标进入播放器
 */
function onMouseEnter(): void {
  isMouseOver.value = true
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
  isHovering.value = true
}

/**
 * 鼠标离开播放器
 */
function onMouseLeave(): void {
  isMouseOver.value = false
  if (isSeeking.value) return // 正在拖拽进度条时不收起

  startLeaveTimer()
}

/**
 * 开始离开计时
 */
function startLeaveTimer(): void {
  if (hoverTimer) {
    clearTimeout(hoverTimer)
  }

  hoverTimer = setTimeout(() => {
    isHovering.value = false
    hoverTimer = null
  }, 2000)
}

/**
 * 点击进度条跳转
 */
function handleSeek(e: MouseEvent): void {
  if (!audioRef.value || !duration.value) return

  const progressBar = e.currentTarget as HTMLElement
  const rect = progressBar.getBoundingClientRect()
  const x = e.clientX - rect.left
  const percent = Math.min(Math.max(x / rect.width, 0), 1)

  const time = percent * duration.value
  audioRef.value.currentTime = time
  currentTime.value = time
}

/**
 * 开始拖拽进度条
 */
function startSeekDrag(e: MouseEvent): void {
  e.preventDefault() // 防止选中文本
  e.stopPropagation() // 防止触发播放器拖拽

  isSeeking.value = true

  // 添加全局事件监听
  document.addEventListener('mousemove', onSeekDrag)
  document.addEventListener('mouseup', stopSeekDrag)
}

/**
 * 拖拽进度条中
 */
function onSeekDrag(e: MouseEvent): void {
  if (!isSeeking.value || !audioRef.value || !duration.value) return

  const progressBar = progressBarRef.value
  if (!progressBar) return

  const rect = progressBar.getBoundingClientRect()
  const x = e.clientX - rect.left
  const percent = Math.min(Math.max(x / rect.width, 0), 1)

  const time = percent * duration.value
  currentTime.value = time // 只更新显示，不设置 audio.currentTime，避免卡顿
}

/**
 * 停止拖拽进度条
 */
function stopSeekDrag(e: MouseEvent): void {
  if (!isSeeking.value) return

  isSeeking.value = false

  // 应用最终时间
  if (audioRef.value && duration.value) {
    const progressBar = progressBarRef.value
    if (progressBar) {
      const rect = progressBar.getBoundingClientRect()
      const x = e.clientX - rect.left
      const percent = Math.min(Math.max(x / rect.width, 0), 1)
      audioRef.value.currentTime = percent * duration.value
    }
  }

  document.removeEventListener('mousemove', onSeekDrag)
  document.removeEventListener('mouseup', stopSeekDrag)

  // 如果鼠标不在播放器内，开始离开计时
  if (!isMouseOver.value) {
    startLeaveTimer()
  }
}

/**
 * 开始拖拽
 */
function startDrag(e: MouseEvent | TouchEvent): void {
  e.preventDefault()

  if (!playerRef.value) return

  isDragging.value = true

  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
  const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY

  const rect = playerRef.value.getBoundingClientRect()
  dragOffset.value = {
    x: clientX - rect.left,
    y: clientY - rect.top
  }

  // 添加全局事件监听
  // 使用 passive: false 以便在 touchmove 中调用 preventDefault
  document.addEventListener('mousemove', onDrag, { passive: false })
  document.addEventListener('mouseup', stopDrag)
  document.addEventListener('touchmove', onDrag, { passive: false })
  document.addEventListener('touchend', stopDrag)
}

/**
 * 拖拽中
 */
function onDrag(e: MouseEvent | TouchEvent): void {
  if (!isDragging.value) return

  e.preventDefault() // 防止默认行为，提升性能

  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
  const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY

  // 直接更新位置，在拖拽时 transition 已被禁用，不会有延迟
  position.value = {
    x: clientX - dragOffset.value.x,
    y: clientY - dragOffset.value.y
  }
}

/**
 * 停止拖拽并吸附到最近的边
 */
function stopDrag(): void {
  if (!isDragging.value) return

  isDragging.value = false

  // 移除全局事件监听
  document.removeEventListener('mousemove', onDrag)
  document.removeEventListener('mouseup', stopDrag)
  document.removeEventListener('touchmove', onDrag)
  document.removeEventListener('touchend', stopDrag)

  // 吸附到最近的边
  snapToEdge()
}

/**
 * 吸附到最近的边
 */
function snapToEdge(): void {
  if (!playerRef.value) return

  const rect = playerRef.value.getBoundingClientRect()
  const windowWidth = window.innerWidth
  const windowHeight = window.innerHeight

  // 计算到各边的距离
  const distanceToLeft = rect.left
  const distanceToRight = windowWidth - rect.right
  const distanceToTop = rect.top
  const distanceToBottom = windowHeight - rect.bottom

  // 找出最小距离
  const minDistance = Math.min(distanceToLeft, distanceToRight, distanceToTop, distanceToBottom)

  // 确定吸附位置
  let newX = position.value.x
  let newY = position.value.y

  const padding = 24 // 边距

  if (minDistance === distanceToLeft) {
    // 吸附到左边
    newX = padding
  } else if (minDistance === distanceToRight) {
    // 吸附到右边
    newX = windowWidth - rect.width - padding
  }

  if (minDistance === distanceToTop) {
    // 吸附到顶部
    newY = padding
  } else if (minDistance === distanceToBottom) {
    // 吸附到底部
    newY = windowHeight - rect.height - padding
  }

  // 应用新位置(带动画)
  position.value = { x: newX, y: newY }
}
</script>

<style scoped lang="less">
.global-audio-player {
  position: fixed;
  z-index: 9999;
  transition:
    left 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    top 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: left, top;

  // 拖拽时禁用 transition，避免滞后感
  &.is-dragging {
    transition: none;
  }
}

.player-container {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 16px 20px;
  background: linear-gradient(135deg, var(--color-bg-surface), var(--color-bg-raised));
  backdrop-filter: blur(30px);
  border-radius: 26px;
  box-shadow:
    0 8px 32px var(--shadow-color),
    0 0 0 1px var(--shadow-highlight);
  min-width: 280px;
  max-width: 320px;
  position: relative;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

  &.is-expanded {
    padding-bottom: 12px;
  }
}

.player-main-content {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
}

// 拖拽手柄
.drag-handle {
  position: absolute;
  top: 0;
  left: 0;
  right: 80px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  user-select: none;
  z-index: 1;

  &:active {
    cursor: grabbing;
  }
}

// 拖拽指示器(三条横线)
.drag-indicator {
  width: 32px;
  height: 4px;
  background: var(--color-bg-surface-hover);
  border-radius: 2px;
  position: relative;

  &::before,
  &::after {
    content: '';
    position: absolute;
    width: 32px;
    height: 4px;
    background: var(--color-bg-surface-hover);
    border-radius: 2px;
    left: 0;
  }

  &::before {
    top: -8px;
  }

  &::after {
    top: 8px;
  }
}

.audio-info {
  display: flex;
  align-items: center;
  flex: 1;
  overflow: hidden;
  position: relative;
  z-index: 2;
  pointer-events: none;
  min-width: 0; // 确保 flex 子元素可以收缩
}

.audio-title-wrapper {
  flex: 1;
  overflow: hidden;
  position: relative;
  min-width: 0;
}

.audio-title {
  font-size: 14px;
  color: var(--color-text-primary);
  font-weight: 500;
  white-space: nowrap;
  display: inline-block;

  span {
    display: inline-block;
  }

  // 跑马灯滚动动画
  &.is-scrolling {
    animation: marquee 8s linear infinite;

    span {
      padding-right: 50px; // 滚动间隔
    }

    // 添加重复文本用于无缝滚动
    &::after {
      content: attr(data-title);
      position: absolute;
      left: 100%;
      padding-left: 50px;
    }
  }
}

@keyframes marquee {
  0% {
    transform: translateX(0);
  }
  100% {
    transform: translateX(-50%);
  }
}

.player-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  position: relative;
  z-index: 2;
}

.control-btn {
  font-size: 24px;
  cursor: pointer;
  transition: all 0.2s ease;
  color: var(--color-text-primary);

  &:hover {
    transform: scale(1.1);
  }

  &:active {
    transform: scale(0.95);
  }
}

.play-btn,
.pause-btn {
  color: var(--color-accent-text);

  &:hover {
    color: var(--color-accent-text);
  }
}

.close-btn {
  font-size: 16px;
  opacity: 0.6;

  &:hover {
    opacity: 1;
    color: var(--color-danger-text);
  }
}

// 上下首按钮
.nav-btn {
  font-size: 18px;

  &.disabled {
    color: var(--color-text-disabled);
    cursor: not-allowed;
    pointer-events: none;
  }
}

// 循环模式按钮
.loop-btn {
  font-size: 16px;
  opacity: 0.5;

  &:hover {
    opacity: 0.8;
  }

  &.is-active {
    opacity: 1;
    color: var(--color-accent-text);
  }

  &.is-single {
    color: var(--color-success-text);
  }
}

// 进度条样式
.progress-section {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 0 4px;
  width: 100%;
}

.time-text {
  font-size: 12px;
  color: var(--color-text-primary);
  font-family: monospace;
  min-width: 32px;
}

.progress-bar-wrapper {
  flex: 1;
  height: 20px;
  display: flex;
  align-items: center;
  cursor: pointer;

  &:hover .progress-thumb {
    transform: scale(1.5);
  }
}

.progress-track {
  width: 100%;
  height: 3px;
  background: var(--color-bg-surface-hover);
  border-radius: 2px;
  position: relative;
}

.progress-fill {
  height: 100%;
  background: var(--color-accent-solid);
  border-radius: 2px;
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
}

.progress-thumb {
  width: 8px;
  height: 8px;
  background: #fff;
  border-radius: 50%;
  position: absolute;
  top: 50%;
  margin-top: -4px;
  margin-left: -4px;
  box-shadow: 0 0 8px var(--shadow-color);
  transition: transform 0.2s;
  pointer-events: none;
}

// 动画
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

// 过渡动画
.player-slide-enter-active,
.player-slide-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.player-slide-enter-from {
  transform: translateY(100px);
  opacity: 0;
}

.player-slide-leave-to {
  transform: translateY(100px);
  opacity: 0;
}
</style>
