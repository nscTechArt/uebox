import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

/**
 * 音频信息接口
 */
export interface AudioInfo {
  src: string // 音频源(URL 或 data URL)
  title?: string // 音频标题
  startTime?: number // 起始播放时间(秒)，用于从指定位置开始播放
  coverUrl?: string // 封面图片URL
}

/**
 * 循环模式类型
 */
export type LoopMode = 'none' | 'single' | 'list'

/**
 * 全局音频播放器状态管理
 * 用于管理应用全局的音频播放状态
 * 支持播放列表、上下首切换、循环模式
 */
export const useGlobalAudioStore = defineStore('globalAudio', () => {
  // ============ 状态 ============

  /** 播放列表 */
  const playlist = ref<AudioInfo[]>([])

  /** 当前播放索引 */
  const currentIndex = ref(-1)

  /** 当前音频信息（从播放列表中取） */
  const currentAudio = computed<AudioInfo | null>(() => {
    if (currentIndex.value < 0 || currentIndex.value >= playlist.value.length) {
      return null
    }
    return playlist.value[currentIndex.value]
  })

  /** 是否正在播放 */
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const seekRequest = ref<{ time: number } | null>(null)

  function seekTo(time: number): void {
    if (!currentAudio.value || !Number.isFinite(time)) return
    seekRequest.value = { time: Math.max(0, Math.min(time, duration.value)) }
  }

  watch(
    () => currentAudio.value?.src,
    () => {
      currentTime.value = 0
      duration.value = 0
      seekRequest.value = null
    },
    { flush: 'sync' }
  )

  /** 循环模式：none=不循环, single=单曲循环, list=列表循环 */
  const loopMode = ref<LoopMode>('none')

  /** 是否显示播放器 */
  const showPlayer = computed(() => playlist.value.length > 0)

  /** 是否可以播放上一首 */
  const canPlayPrev = computed(() => {
    if (loopMode.value === 'list') return playlist.value.length > 1
    return currentIndex.value > 0
  })

  /** 是否可以播放下一首 */
  const canPlayNext = computed(() => {
    if (loopMode.value === 'list') return playlist.value.length > 1
    return currentIndex.value < playlist.value.length - 1
  })

  // ============ 方法 ============

  /**
   * 播放单个音频（兼容旧API）
   * @param audio 音频信息
   */
  function playAudio(audio: AudioInfo): void {
    // 查找是否已在播放列表中
    const existingIndex = playlist.value.findIndex((item) => item.src === audio.src)

    if (existingIndex >= 0) {
      // 已存在，直接切换到该索引
      currentIndex.value = existingIndex
    } else {
      // 不存在，添加到播放列表末尾并播放
      playlist.value.push(audio)
      currentIndex.value = playlist.value.length - 1
    }

    isPlaying.value = true
  }

  /**
   * 播放整个播放列表
   * @param items 播放列表
   * @param startIndex 起始索引（默认0）
   */
  function playPlaylist(items: AudioInfo[], startIndex: number = 0): void {
    if (items.length === 0) return

    playlist.value = [...items]
    currentIndex.value = Math.max(0, Math.min(startIndex, items.length - 1))
    isPlaying.value = true
  }

  /**
   * 播放下一首
   */
  function playNext(): void {
    if (playlist.value.length === 0) return

    if (currentIndex.value < playlist.value.length - 1) {
      currentIndex.value++
      isPlaying.value = true
    } else if (loopMode.value === 'list') {
      // 列表循环：回到第一首
      currentIndex.value = 0
      isPlaying.value = true
    }
  }

  /**
   * 播放上一首
   */
  function playPrev(): void {
    if (playlist.value.length === 0) return

    if (currentIndex.value > 0) {
      currentIndex.value--
      isPlaying.value = true
    } else if (loopMode.value === 'list') {
      // 列表循环：跳到最后一首
      currentIndex.value = playlist.value.length - 1
      isPlaying.value = true
    }
  }

  /**
   * 切换循环模式
   */
  function toggleLoop(): void {
    const modes: LoopMode[] = ['none', 'single', 'list']
    const currentModeIndex = modes.indexOf(loopMode.value)
    loopMode.value = modes[(currentModeIndex + 1) % modes.length]
  }

  /**
   * 暂停播放
   */
  function pause(): void {
    isPlaying.value = false
  }

  /**
   * 恢复播放
   */
  function resume(): void {
    if (currentAudio.value) {
      isPlaying.value = true
    }
  }

  /**
   * 停止播放并关闭播放器
   */
  function stop(): void {
    playlist.value = []
    currentIndex.value = -1
    isPlaying.value = false
  }

  /**
   * 设置播放状态
   * @param playing 是否播放
   */
  function setPlaying(playing: boolean): void {
    isPlaying.value = playing
  }

  /**
   * 处理播放结束（由 GlobalAudioPlayer 调用）
   * @returns 是否应该继续播放（单曲循环或自动下一首）
   */
  function handleEnded(): boolean {
    if (loopMode.value === 'single') {
      // 单曲循环：返回 true，让播放器重新播放当前歌曲
      return true
    }

    if (loopMode.value === 'list' || currentIndex.value < playlist.value.length - 1) {
      // 列表循环或还有下一首：自动播放下一首
      playNext()
      return true
    }

    // 无循环且没有下一首：停止播放
    isPlaying.value = false
    return false
  }

  return {
    // 状态
    playlist,
    currentIndex,
    currentAudio,
    isPlaying,
    currentTime,
    duration,
    seekRequest,
    seekTo,
    loopMode,
    showPlayer,
    canPlayPrev,
    canPlayNext,
    // 方法
    playAudio,
    playPlaylist,
    playNext,
    playPrev,
    toggleLoop,
    pause,
    resume,
    stop,
    setPlaying,
    handleEnded
  }
})
