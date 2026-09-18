<template>
  <div class="screen-recorder-page" :class="{ 'is-compact': compact }">
    <div v-if="compact" class="screen-recorder-quick" :class="{ 'is-collapsed': isCollapsed }">
      <div v-if="isCollapsed" class="quick-collapsed">
        <button class="collapsed-stop" @click="handleCollapsedStop">
          <span class="collapsed-dot"></span>
          <span class="collapsed-text">{{ $t('screenRecorderPanel.quick.pause') }}</span>
          <span class="collapsed-time">{{ formattedDuration }}</span>
        </button>
      </div>
      <div v-else class="quick-expanded">
        <div class="quick-header">
          <div class="quick-title">{{ $t('screenRecorderPanel.quick.title') }}</div>
          <button class="quick-close" @click="handleCloseQuickWindow">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="icon"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fill-rule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clip-rule="evenodd"
              />
            </svg>
          </button>
        </div>

        <div class="quick-status-row">
          <div class="status-items">
            <span class="status-dot" :class="{ 'is-recording': isRecording }"></span>
            <span class="status-text">{{
              isRecording
                ? $t('screenRecorderPanel.quick.statusRecording')
                : $t('screenRecorderPanel.quick.statusStandby')
            }}</span>
            <span class="divider">|</span>
            <span class="status-text">{{
              recordMode === 'full'
                ? $t('screenRecorderPanel.mode.full')
                : $t('screenRecorderPanel.mode.region')
            }}</span>
            <span class="divider">|</span>
            <span class="status-text">{{ recorderFps }} FPS</span>
          </div>
        </div>

        <div class="quick-time-display">
          {{ formattedDuration }}
        </div>

        <div class="quick-controls-bar">
          <div class="control-group left">
            <div
              class="mode-switch"
              :class="{
                'is-region': recordMode === 'region',
                'is-disabled': isRecording || isCountingDown
              }"
              :title="
                recordMode === 'full'
                  ? $t('screenRecorderPanel.mode.switchToRegion')
                  : $t('screenRecorderPanel.mode.switchToFull')
              "
              @click="handleToggleMode"
            >
              <div class="switch-track"></div>
              <div class="switch-thumb">
                <span class="thumb-text">{{
                  recordMode === 'full'
                    ? $t('screenRecorderPanel.mode.full')
                    : $t('screenRecorderPanel.mode.region')
                }}</span>
              </div>
            </div>
          </div>

          <div class="control-group center">
            <button
              v-if="!isRecording"
              class="main-record-btn start"
              :disabled="isCountingDown"
              @click="handleQuickStart"
            >
              <div class="inner-circle"></div>
            </button>
            <button v-else class="main-record-btn stop" @click="handleStopRecording">
              <div class="inner-square"></div>
            </button>
          </div>

          <div class="control-group right">
            <button
              class="icon-btn"
              :disabled="isCountingDown"
              :title="$t('screenRecorderPanel.quick.restartTitle')"
              @click="handleRestartRecording"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="icon"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
          </div>
        </div>

        <div v-if="isCountingDown" class="countdown-overlay">
          <div class="countdown-number">{{ countdown }}</div>
        </div>
      </div>
      <video ref="videoRef" class="quick-hidden-video" autoplay muted></video>
    </div>
    <template v-else>
      <header class="page-header">
        <div class="header-left">
          <div class="fps-group">
            <button
              class="seg-btn"
              :class="{ 'is-active': recorderFps === 60, 'is-disabled': isRecording }"
              :disabled="isRecording"
              @click="handleSetFps(60)"
            >
              {{ $t('screenRecorderPanel.fps.sixty') }}
            </button>
            <button
              class="seg-btn"
              :class="{ 'is-active': recorderFps === 30, 'is-disabled': isRecording }"
              :disabled="isRecording"
              @click="handleSetFps(30)"
            >
              {{ $t('screenRecorderPanel.fps.thirty') }}
            </button>
          </div>
        </div>

        <div class="header-actions">
          <button
            class="btn btn-secondary"
            :disabled="isRecording"
            :class="{ 'is-disabled': isRecording }"
            @click="getSources"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="btn-icon"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            {{ $t('screenRecorderPanel.actions.refreshSources') }}
          </button>

          <div class="divider"></div>

          <button
            class="btn btn-secondary"
            :disabled="isRecording"
            :class="{ 'is-disabled': isRecording }"
            @click="openQuickWindow"
          >
            {{ $t('screenRecorderPanel.actions.quickRecordWindow') }}
          </button>

          <button
            v-if="!isRecording"
            class="btn btn-secondary"
            :disabled="isRecording"
            :class="{ 'is-disabled': isRecording }"
            :title="$t('screenRecorderPanel.actions.selectRegionTitle')"
            @click="handleStartGlobalSelection"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="btn-icon"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
              />
            </svg>
            {{ $t('screenRecorderPanel.actions.screenRegion') }}
          </button>

          <button
            v-if="!isRecording"
            class="btn btn-primary"
            :disabled="!selectedSourceId"
            :class="{ 'is-disabled': !selectedSourceId }"
            @click="startRecording"
          >
            <div class="status-dot"></div>
            {{ $t('screenRecorderPanel.actions.startRecording') }}
          </button>

          <button v-else class="btn btn-danger is-pulsing" @click="stopRecording">
            <div class="status-dot square"></div>
            {{ $t('screenRecorderPanel.actions.stopRecording') }}
          </button>
        </div>
      </header>

      <main class="page-content">
        <section class="preview-section">
          <div class="section-header">
            <h2 class="section-title">
              <span class="status-indicator" :class="{ 'is-recording': isRecording }"></span>
              {{
                isRecording
                  ? $t('screenRecorderPanel.preview.recording')
                  : recordedVideoUrl
                    ? $t('screenRecorderPanel.preview.playback')
                    : $t('screenRecorderPanel.preview.live')
              }}
            </h2>
            <span v-if="isRecording" class="rec-badge">REC</span>
          </div>

          <div ref="previewContainerRef" class="preview-container">
            <video
              v-show="previewStream || recordedVideoUrl"
              ref="videoRef"
              class="preview-video"
              controls
              autoplay
              muted
            ></video>

            <div v-if="isRegionMode && previewStream" class="region-overlay">
              <div
                v-if="regionRect.w > 0"
                class="selection-box"
                :style="{
                  left: regionRect.x + 'px',
                  top: regionRect.y + 'px',
                  width: regionRect.w + 'px',
                  height: regionRect.h + 'px'
                }"
              >
                <div class="selection-info">
                  {{ Math.round(regionRect.w) }} x {{ Math.round(regionRect.h) }}
                </div>
              </div>
            </div>

            <div v-if="!previewStream && !recordedVideoUrl" class="preview-empty">
              <div class="icon-circle">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  class="icon"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="1.5"
                    d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                  />
                </svg>
              </div>
              <p>{{ $t('screenRecorderPanel.preview.emptyHint') }}</p>
            </div>
          </div>
        </section>
        <section class="sidebar-section">
          <div class="section-header">
            <h2 class="section-title">
              {{ $t('screenRecorderPanel.sources.title', { count: sources.length }) }}
            </h2>
          </div>

          <div class="source-list custom-scrollbar">
            <div v-if="sources.length === 0" class="empty-state">
              <p>{{ $t('screenRecorderPanel.sources.empty') }}</p>
              <button class="link-btn" @click="getSources">
                {{ $t('screenRecorderPanel.sources.refreshLink') }}
              </button>
            </div>

            <div
              v-for="source in sources"
              :key="source.id"
              class="source-card"
              :class="{ 'is-selected': selectedSourceId === source.id }"
              @click="handleSourceSelect(source.id)"
            >
              <div class="thumbnail-wrapper">
                <img :src="source.thumbnail" class="thumbnail" />
                <div v-if="selectedSourceId === source.id" class="check-mark">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    class="icon"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fill-rule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clip-rule="evenodd"
                    />
                  </svg>
                </div>
              </div>
              <div class="card-footer-in">
                <div class="source-name" :title="source.name">{{ source.name }}</div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <div v-if="isCountingDown" class="countdown-overlay">
        <div class="countdown-number">{{ countdown }}</div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onUnmounted, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import { mediaPermissionErrorKey } from '@renderer/utils/mediaPermissionError'
import { probeScreenCapture } from './screenCaptureProbe'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    compact?: boolean
  }>(),
  {
    compact: false
  }
)

const emit = defineEmits<{
  (e: 'export', payload: { filePath: string; url: string }): void
}>()

const sources = ref<Array<{ id: string; name: string; thumbnail: string }>>([])
const selectedSourceId = ref<string>('')
const isRecording = ref(false)
const mediaRecorder = ref<MediaRecorder | null>(null)
const recordedChunks = ref<Blob[]>([])
const previewStream = ref<MediaStream | null>(null)
const recordedVideoUrl = ref<string>('')
const videoRef = ref<HTMLVideoElement | null>(null)
const previewContainerRef = ref<HTMLElement | null>(null)

const countdown = ref(3)
const isCountingDown = ref(false)
let countdownTimer: any = null
const recordingDuration = ref(0)
let recordingTimer: number | null = null
const shouldSaveOnStop = ref(true)
const isCollapsed = ref(false)

const isRegionMode = ref(false)
const isGlobalSelection = ref(false)
const regionRect = ref({ x: 0, y: 0, w: 0, h: 0 })
const recordMode = ref<'full' | 'region'>('full')

const selectionDisplayBounds = ref<{ width: number; height: number } | null>(null)
const recorderFps = ref<number>(60)
const formattedDuration = computed(() => formatDuration(recordingDuration.value))

function notifyInfo(text: string): void {
  if (props.compact) return
  message.info(text)
}

function notifySuccess(text: string): void {
  if (props.compact) return
  message.success(text)
}

function notifyWarning(text: string): void {
  if (props.compact) return
  message.warning(text)
}

const isEntireScreenSource = (source: { id: string; name: string }) => {
  return (
    source.id.startsWith('screen:') ||
    source.name.includes('Entire Screen') ||
    source.name.includes('Screen 1') ||
    source.name === 'Screen'
  )
}

function handleSetFps(fps: number): void {
  recorderFps.value = fps
}

async function openQuickWindow(): Promise<void> {
  if (props.compact) return
  await window.api.screenRecorder.openQuickWindow()
}

async function handleCloseQuickWindow(): Promise<void> {
  if (!props.compact) return
  await setQuickWindowMode('expanded')
  await window.api.screenRecorder.closeQuickWindow()
}

function handleStartGlobalSelection(): void {
  void startGlobalSelection(true)
}

async function startGlobalSelection(autoStart = true) {
  try {
    const result = await window.api.screenRecorder.startSelection()
    if (result && result.selection) {
      await getSources()

      const screenSource = sources.value.find((s) => isEntireScreenSource(s)) || sources.value[0]

      if (screenSource) {
        selectedSourceId.value = screenSource.id

        isRegionMode.value = true
        isGlobalSelection.value = true

        selectionDisplayBounds.value = result.displayBounds
        recordMode.value = 'region'

        regionRect.value = {
          x: result.selection.x,
          y: result.selection.y,
          w: result.selection.width,
          h: result.selection.height
        }

        if (autoStart) {
          startRecording()
        }
      } else {
        notifyWarning('未找到可用的屏幕源')
      }
    } else {
      // 用户取消选区（右键或点击取消），重置为全屏模式，不关闭弹窗
      recordMode.value = 'full'
      if (props.compact) {
        await setQuickWindowMode('expanded')
      }
    }
  } catch (error) {
    console.error('选区失败:', error)
    recordMode.value = 'full'
    if (props.compact) {
      await setQuickWindowMode('expanded')
    }
  }
}

onMounted(async () => {
  await getSources()
  if (props.compact) {
    await handleSelectFullScreen()
    await setQuickWindowMode('expanded')
  }
})

watch(selectedSourceId, (newId) => {
  if (newId) {
    initPreview()
  }
})

watch(recorderFps, () => {
  if (!isRecording.value && selectedSourceId.value) {
    initPreview()
  }
})

async function verifySourceRecordable(sourceId: string): Promise<boolean> {
  return probeScreenCapture(() =>
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      } as MediaTrackConstraints
    })
  )
}

async function filterRecordableSources(
  list: Array<{ id: string; name: string; thumbnail: string }>
): Promise<Array<{ id: string; name: string; thumbnail: string }>> {
  const result: Array<{ id: string; name: string; thumbnail: string }> = []
  for (const source of list) {
    const recordable = await verifySourceRecordable(source.id)
    if (recordable) {
      result.push(source)
    }
  }
  return result
}

async function getSources() {
  try {
    const res = await window.api.screenRecorder.getSources()
    const validSources = window.api.platform === 'darwin' ? res : await filterRecordableSources(res)
    const sortedSources = [...validSources].sort((a, b) => {
      const aIsScreen = isEntireScreenSource(a)
      const bIsScreen = isEntireScreenSource(b)
      if (aIsScreen === bIsScreen) return 0
      return aIsScreen ? -1 : 1
    })
    sources.value = sortedSources
    const hasSelected = validSources.some((s) => s.id === selectedSourceId.value)
    if (!hasSelected) {
      selectedSourceId.value = ''
    }
    if (sortedSources.length > 0 && !selectedSourceId.value) {
      selectedSourceId.value = sortedSources[0].id
    }
  } catch (error) {
    const key = mediaPermissionErrorKey(error, 'screen', window.api.platform)
    message.error(key ? t(key) : t('mediaPermissions.sourcesFailed', { error: String(error) }))
  }
}

function handleSourceSelect(id: string) {
  if (selectedSourceId.value === id && recordedVideoUrl.value && !isRecording.value) {
    initPreview()
  }
  selectedSourceId.value = id
}

async function initPreview() {
  if (!selectedSourceId.value) return

  if (isRecording.value) return

  if (recordedVideoUrl.value) {
    URL.revokeObjectURL(recordedVideoUrl.value)
    recordedVideoUrl.value = ''
  }

  if (previewStream.value) {
    previewStream.value.getTracks().forEach((track) => track.stop())
    previewStream.value = null
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: selectedSourceId.value,
          maxFrameRate: recorderFps.value
        }
      } as any
    })

    previewStream.value = stream
    if (videoRef.value) {
      videoRef.value.srcObject = stream
      videoRef.value.muted = true
    }
  } catch (error) {
    console.error('预览失败:', error)
    const key = mediaPermissionErrorKey(error, 'screen', window.api.platform)
    message.error(key ? t(key) : t('mediaPermissions.previewFailed', { error: String(error) }))
  }
}

async function startRecording() {
  shouldSaveOnStop.value = true
  if (!selectedSourceId.value) {
    notifyWarning('请先选择一个屏幕源')
    return
  }

  if (!previewStream.value) {
    await initPreview()
  }

  if (!previewStream.value) {
    message.error(t('screenRecorderPanel.errors.streamUnavailable'))
    return
  }

  isCountingDown.value = true
  countdown.value = 3

  countdownTimer = setInterval(() => {
    countdown.value--
    if (countdown.value <= 0) {
      clearInterval(countdownTimer)
      isCountingDown.value = false
      startMediaRecorder()
    }
  }, 1000)
}

async function startMediaRecorder() {
  if (!previewStream.value) return

  try {
    let streamToRecord = previewStream.value

    if (isRegionMode.value && regionRect.value.w > 0 && regionRect.value.h > 0 && videoRef.value) {
      const video = videoRef.value
      const canvas = document.createElement('canvas')

      let videoRatioX = 1
      let videoRatioY = 1

      if (isGlobalSelection.value) {
        const screenW = selectionDisplayBounds.value
          ? selectionDisplayBounds.value.width
          : window.screen.width
        const screenH = selectionDisplayBounds.value
          ? selectionDisplayBounds.value.height
          : window.screen.height

        videoRatioX = video.videoWidth / screenW
        videoRatioY = video.videoHeight / screenH

        console.log('[Recorder] Global Selection Ratio:', {
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          screenW,
          screenH,
          videoRatioX,
          videoRatioY,
          region: regionRect.value
        })
      } else {
        videoRatioX = video.videoWidth / video.clientWidth
        videoRatioY = video.videoHeight / video.clientHeight
      }

      canvas.width = regionRect.value.w * videoRatioX
      canvas.height = regionRect.value.h * videoRatioY

      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建 Canvas 上下文')

      const draw = () => {
        if (mediaRecorder.value?.state === 'inactive') return

        let currentRatioX = videoRatioX
        let currentRatioY = videoRatioY

        if (isGlobalSelection.value && video.videoWidth > 0 && selectionDisplayBounds.value) {
          currentRatioX = video.videoWidth / selectionDisplayBounds.value.width
          currentRatioY = video.videoHeight / selectionDisplayBounds.value.height
        }

        ctx.drawImage(
          video,
          regionRect.value.x * currentRatioX,
          regionRect.value.y * currentRatioY,
          canvas.width,
          canvas.height,
          0,
          0,
          canvas.width,
          canvas.height
        )
        setTimeout(draw, 1000 / recorderFps.value)
      }

      streamToRecord = canvas.captureStream(recorderFps.value)

      if (video.paused) {
        try {
          await video.play()
        } catch (e) {
          console.error('Video play failed:', e)
        }
      }

      if (video.videoWidth === 0) {
        console.log('Waiting for video metadata...')
        await new Promise<void>((resolve) => {
          const onLoaded = () => {
            video.removeEventListener('loadedmetadata', onLoaded)
            resolve()
          }
          video.addEventListener('loadedmetadata', onLoaded)
          setTimeout(() => {
            video.removeEventListener('loadedmetadata', onLoaded)
            resolve()
          }, 2000)
        })
      }

      if (isGlobalSelection.value && selectionDisplayBounds.value && video.videoWidth > 0) {
        videoRatioX = video.videoWidth / selectionDisplayBounds.value.width
        videoRatioY = video.videoHeight / selectionDisplayBounds.value.height
        canvas.width = regionRect.value.w * videoRatioX
        canvas.height = regionRect.value.h * videoRatioY
      }

      ctx.drawImage(
        video,
        regionRect.value.x * videoRatioX,
        regionRect.value.y * videoRatioY,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height
      )

      draw()
    }

    const mimeType = 'video/webm; codecs=vp9'
    mediaRecorder.value = new MediaRecorder(streamToRecord, { mimeType })
    recordedChunks.value = []

    mediaRecorder.value.ondataavailable = (e) => {
      if (e.data.size > 0) {
        recordedChunks.value.push(e.data)
      }
    }

    mediaRecorder.value.onstop = saveRecording

    isRecording.value = true
    mediaRecorder.value.start(1000)
    recordingDuration.value = 0
    startRecordingTimer()
    if (props.compact) {
      if (recordMode.value === 'full') {
        await setQuickWindowMode('collapsed')
      } else {
        await window.api.screenRecorder.moveQuickWindow('bottom-right')
      }
    }
    notifyInfo(t('screenRecorderPanel.toast.started'))
  } catch (error) {
    isRecording.value = false
    console.error(error)
    message.error(t('screenRecorderPanel.toast.startFailed', { reason: String(error) }))
  }
}

function stopRecording() {
  if (mediaRecorder.value && mediaRecorder.value.state !== 'inactive') {
    mediaRecorder.value.stop()
  }
  if (previewStream.value) {
    previewStream.value.getTracks().forEach((track) => track.stop())
    previewStream.value = null
  }
  isRecording.value = false
  stopRecordingTimer()
  if (props.compact && recordMode.value === 'full' && isCollapsed.value) {
    void setQuickWindowMode('expanded')
  }
}

async function saveRecording() {
  if (!shouldSaveOnStop.value) {
    shouldSaveOnStop.value = true
    resetRecordingState()
    return
  }
  const blob = new Blob(recordedChunks.value, { type: 'video/webm' })
  const buffer = await blob.arrayBuffer()

  recordedVideoUrl.value = URL.createObjectURL(blob)
  if (videoRef.value) {
    videoRef.value.srcObject = null
    videoRef.value.src = recordedVideoUrl.value
    videoRef.value.muted = false
  }

  try {
    const res = await window.api.screenRecorder.autoSave(buffer, 'webm')
    if (res.success && res.filePath) {
      notifySuccess(`已自动保存为 WebM: ${res.filePath}`)
      emit('export', { filePath: res.filePath, url: recordedVideoUrl.value })
      return
    }
    if (res.filePath) {
      notifyWarning(res.error || `已保存为 WebM: ${res.filePath}`)
      emit('export', { filePath: res.filePath, url: recordedVideoUrl.value })
      return
    }
    if (res.error) {
      message.error(res.error)
    }
  } catch (error) {
    message.error(t('screenRecorderPanel.toast.autoSaveFailed', { reason: String(error) }))
  }
}

onUnmounted(() => {
  stopRecording()
  stopRecordingTimer()
  if (recordedVideoUrl.value) {
    URL.revokeObjectURL(recordedVideoUrl.value)
  }
})

function startRecordingTimer(): void {
  stopRecordingTimer()
  recordingTimer = window.setInterval(() => {
    recordingDuration.value += 1
  }, 1000)
}

function stopRecordingTimer(): void {
  if (recordingTimer) {
    window.clearInterval(recordingTimer)
    recordingTimer = null
  }
}

function formatDuration(value: number): string {
  const minutes = Math.floor(value / 60)
  const seconds = value % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function resetRecordingState(): void {
  recordedChunks.value = []
  if (recordedVideoUrl.value) {
    URL.revokeObjectURL(recordedVideoUrl.value)
    recordedVideoUrl.value = ''
  }
  recordingDuration.value = 0
}

async function handleSelectFullScreen(): Promise<void> {
  recordMode.value = 'full'
  isRegionMode.value = false
  isGlobalSelection.value = false
  regionRect.value = { x: 0, y: 0, w: 0, h: 0 }
  await setQuickWindowMode('expanded')
  if (sources.value.length === 0) {
    await getSources()
  }
  const screenSource = sources.value.find((s) => isEntireScreenSource(s)) || sources.value[0]
  if (screenSource) {
    selectedSourceId.value = screenSource.id
  } else {
    notifyWarning('未找到可用的屏幕源')
  }
}

const isSwitchingMode = ref(false)

async function handleToggleMode(): Promise<void> {
  if (isRecording.value || isCountingDown.value || isSwitchingMode.value) return

  isSwitchingMode.value = true
  const targetMode = recordMode.value === 'full' ? 'region' : 'full'
  recordMode.value = targetMode

  // 等待 CSS 动画完成 (300ms)
  await new Promise((resolve) => setTimeout(resolve, 300))

  if (targetMode === 'region') {
    await handleSelectRegion()
  } else {
    await handleSelectFullScreen()
  }

  isSwitchingMode.value = false
}

async function handleSelectRegion(): Promise<void> {
  recordMode.value = 'region'
  await setQuickWindowMode('expanded')
  await startGlobalSelection(false)
}

async function handleQuickStart(): Promise<void> {
  if (recordMode.value === 'region' && (!regionRect.value.w || !regionRect.value.h)) {
    await startGlobalSelection(false)
    if (!regionRect.value.w || !regionRect.value.h) {
      return
    }
  }
  await startRecording()
}

function handleRestartRecording(): void {
  if (isRecording.value) {
    shouldSaveOnStop.value = false
    stopRecording()
    return
  }
  resetRecordingState()
}

async function setQuickWindowMode(mode: 'expanded' | 'collapsed'): Promise<void> {
  if (!props.compact) return
  try {
    await window.api.screenRecorder.setQuickWindowMode(mode)
    isCollapsed.value = mode === 'collapsed'
  } catch {
    undefined
  }
}

async function handleStopRecording(): Promise<void> {
  stopRecording()
  if (props.compact && recordMode.value === 'full') {
    await setQuickWindowMode('expanded')
  }
}

async function handleCollapsedStop(): Promise<void> {
  await handleStopRecording()
}
</script>

<style lang="less" scoped>
.screen-recorder-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;

  color: var(--color-text-primary);
  overflow: hidden;

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px;

    .header-left {
      display: flex;
      align-items: center;
      gap: 8px;

      .header-icon {
        width: 32px;
        height: 32px;
        border-radius: 6px;
        background-color: var(--color-accent-bg);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--color-accent-text);

        .icon {
          width: 18px;
          height: 18px;
        }
      }

      .header-info {
        .title {
          font-size: 16px;
          font-weight: 600;
          line-height: 1;
          margin: 0;
        }

        .subtitle {
          font-size: 11px;
          color: var(--color-text-secondary);
          margin-top: 2px;
        }
      }

      .fps-group {
        display: inline-flex;
        background: var(--color-bg-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        overflow: hidden;

        .seg-btn {
          padding: 6px 10px;
          font-size: 12px;
          color: var(--color-text-primary);
          background: transparent;
          border: none;
          cursor: pointer;
          transition:
            background 0.2s ease,
            color 0.2s ease;

          &.is-active {
            background: var(--color-bg-surface);
            color: var(--color-text-primary);
          }

          &.is-disabled {
            color: var(--color-text-disabled);
            cursor: not-allowed;
          }
        }
      }
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;

      .divider {
        height: 20px;
        width: 1px;
        background-color: var(--color-bg-raised);
        margin: 0 2px;
      }
    }
  }

  .btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.2s;
    cursor: pointer;
    border: none;
    outline: none;

    &.is-disabled {
      color: var(--color-text-disabled);
      cursor: not-allowed;
    }

    &.is-active {
      background-color: var(--color-bg-raised);
      border-color: var(--color-accent-border);
      color: var(--color-accent-text);
    }

    .btn-icon {
      width: 14px;
      height: 14px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: #ffffff;

      &.square {
        border-radius: 2px;
      }
    }
  }

  .btn-secondary {
    background-color: var(--color-bg-raised);
    color: var(--color-text-primary);
    border: 1px solid var(--color-border);

    &:hover:not(.is-disabled) {
      background-color: var(--color-bg-raised);
    }
  }

  .btn-primary {
    background-color: var(--color-accent-solid);
    color: var(--color-text-on-solid);
    box-shadow: none;

    &:hover:not(.is-disabled) {
      background-color: var(--color-accent-solid);
    }
  }

  .btn-danger {
    background-color: var(--color-danger-solid);
    color: var(--color-text-on-solid);
    box-shadow: none;

    &:hover {
      background-color: var(--color-danger-solid);
    }
  }

  .is-pulsing {
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.8;
    }
  }

  .page-content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 6px;
  }

  .sidebar-section {
    width: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;

      .section-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--color-text-primary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin: 0;
      }
    }

    .source-list {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      overflow-y: hidden;
      padding-bottom: 2px;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 80px;
      width: 100%;
      color: var(--color-text-muted);
      border: 1px dashed var(--color-border);
      border-radius: 8px;
      background-color: var(--color-bg-surface);

      .link-btn {
        background: none;
        border: none;
        color: var(--color-accent-text);
        font-size: 12px;
        margin-top: 6px;
        cursor: pointer;

        &:hover {
          text-decoration: underline;
        }
      }
    }

    .source-card {
      position: relative;
      cursor: pointer;
      border-radius: 8px;
      border: 1px solid var(--color-border);
      overflow: hidden;

      transition: all 0.2s;
      width: 200px;
      flex: 0 0 auto;
      &:hover {
        border-color: var(--color-border-strong);
      }

      &.is-selected {
        border-color: var(--color-accent-border);
        box-shadow: none;
      }

      .thumbnail-wrapper {
        aspect-ratio: 16 / 9;
        width: 100%;
        background-color: var(--color-bg-page);
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;

        .thumbnail {
          width: 100%;
          height: 100%;
          object-fit: contain;
          padding: 10px;
        }

        .check-mark {
          position: absolute;
          top: 6px;
          right: 6px;
          background-color: var(--color-accent-solid);
          color: var(--color-text-on-solid);
          padding: 3px;
          border-radius: 50%;
          box-shadow: none;

          .icon {
            width: 12px;
            height: 12px;
            display: block;
          }
        }
      }

      .card-footer-in {
        text-align: center;
        padding: 5px;

        .source-name {
          font-weight: 500;
          font-size: 12px;
          color: var(--color-text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .source-id {
          font-size: 12px;
          color: var(--color-text-muted);
          margin-top: 4px;
        }
      }
    }
  }

  .preview-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;

      .section-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--color-text-primary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 0;

        .status-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background-color: #6b7280;

          &.is-recording {
            background-color: var(--color-danger-solid);
            animation: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;
          }
        }
      }

      .rec-badge {
        color: var(--color-danger-text);
        font-family: monospace;
        font-size: 12px;
        background-color: var(--color-danger-bg);
        padding: 2px 6px;
        border-radius: 3px;
      }
    }

    .preview-container {
      flex: 0 0 auto;

      background-color: var(--color-bg-page);
      border-radius: 10px;
      border: 1px solid var(--color-border);
      overflow: hidden;
      position: relative;
      box-shadow: none;
      display: flex;
      align-items: center;
      justify-content: center;
      height: calc(100vh - 400px);
      .preview-video {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      .preview-empty {
        text-align: center;
        color: var(--color-text-muted);

        .icon-circle {
          width: 56px;
          height: 56px;
          margin: 0 auto 10px;
          border-radius: 50%;
          background-color: var(--color-bg-surface);
          display: flex;
          align-items: center;
          justify-content: center;

          .icon {
            width: 28px;
            height: 28px;
          }
        }
      }

      .region-overlay {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: var(--color-bg-surface-hover);
        cursor: crosshair;
        z-index: 10;

        .selection-box {
          position: absolute;
          border: 2px solid var(--color-accent-border);
          background-color: var(--color-accent-bg);
          box-shadow: 0 0 0 9999px var(--shadow-color-strong);

          .selection-info {
            position: absolute;
            top: -24px;
            left: 0;
            background-color: var(--color-accent-solid);
            color: var(--color-text-on-solid);
            font-size: 12px;
            padding: 2px 6px;
            border-radius: 4px;
            white-space: nowrap;
          }
        }
      }
    }
  }

  .countdown-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: var(--color-bg-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    backdrop-filter: blur(4px);

    .countdown-number {
      font-size: 140px;
      font-weight: 900;
      color: var(--color-text-primary);
      text-shadow: 0 0 20px var(--color-accent-border);
      animation: scale-up 1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
  }

  .screen-recorder-quick {
    height: 100%;
    display: flex;
    flex-direction: column;

    gap: 10px;
    color: var(--color-text-primary);
    position: relative;
    --quick-radius: 12px;

    &.is-collapsed {
      padding: 6px;
      gap: 0;
    }

    .quick-collapsed {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--color-bg-page);
      border: 1px solid var(--color-border-subtle);
      border-radius: var(--quick-radius);

      .collapsed-stop {
        width: 48px;
        height: 140px;
        border-radius: var(--quick-radius);
        border: 1px solid var(--color-danger-border);
        background: var(--color-danger-solid);
        color: var(--color-text-on-solid);
        font-size: 12px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;

        .collapsed-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #ffffff;
          box-shadow: 0 0 0 4px var(--shadow-highlight);
        }

        .collapsed-text {
          font-size: 12px;
          letter-spacing: 4px;
        }

        .collapsed-time {
          font-size: 11px;
          opacity: 0.9;
        }
      }
    }

    .quick-expanded {
      display: flex;
      flex-direction: column;
      // flex: 1;
      height: 220px;
      background: var(--color-bg-page);
      padding-bottom: 10px;

      gap: 12px;

      .quick-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        -webkit-app-region: drag;
        padding: 5px 5px 0px 5px;
        background: var(--color-bg-surface);
        .quick-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--color-text-primary);
        }

        .quick-close {
          -webkit-app-region: no-drag;
          background: transparent;
          border: none;
          color: var(--color-text-secondary);
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          border-radius: 4px;
          padding: 0;

          &:hover {
            color: var(--color-text-primary);
            background: var(--color-bg-surface-hover);
          }

          .icon {
            width: 18px;
            height: 18px;
          }
        }
      }

      .quick-status-row {
        display: flex;
        justify-content: center;

        .status-items {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: var(--color-text-secondary);
          background: var(--color-bg-sunken);
          padding: 4px 10px;
          border-radius: 12px;
          border: 1px solid var(--color-border-subtle);

          .status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--color-bg-page);

            &.is-recording {
              background: var(--color-danger-solid);
              box-shadow: 0 0 0 2px var(--color-danger-border);
            }
          }

          .divider {
            color: var(--color-text-muted);
            font-size: 10px;
          }
        }
      }

      .quick-time-display {
        text-align: center;
        font-family: monospace;
        font-size: 32px;
        font-weight: 700;
        color: var(--color-text-primary);
        letter-spacing: 1px;
        padding: 4px 0;
        text-shadow: 0 2px 10px var(--shadow-color);
      }

      .quick-controls-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: auto;
        padding: 0 10px;

        .control-group {
          display: flex;
          align-items: center;
          gap: 12px;

          &.left {
            flex: 1;
            justify-content: flex-start;
          }
          &.center {
            flex: 0 0 auto;
            justify-content: center;
          }
          &.right {
            flex: 1;
            justify-content: flex-end;
          }
        }

        .mode-switch {
          width: 80px;
          height: 28px;
          background: var(--color-bg-sunken);
          border-radius: 14px;
          position: relative;
          cursor: pointer;
          transition: all 0.3s ease;
          border: 1px solid var(--color-border);

          &.is-disabled {
            color: var(--color-text-disabled);
            cursor: not-allowed;
          }

          .switch-track {
            width: 100%;
            height: 100%;
          }

          .switch-thumb {
            position: absolute;
            top: 2px;
            left: 2px;
            width: 38px;
            height: 22px;
            background: var(--color-accent-solid);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            color: var(--color-text-on-solid);
            box-shadow: 0 1px 3px var(--shadow-color);

            .thumb-text {
              font-size: 11px;
              font-weight: 500;
              line-height: 1;
              white-space: nowrap;
            }
          }

          &.is-region {
            background: var(--color-bg-sunken);

            .switch-thumb {
              transform: translateX(38px);
              background: var(--color-success-solid);
            }
          }

          &:hover:not(.is-disabled) {
            border-color: var(--color-border-strong);
          }
        }

        .icon-btn {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--color-text-secondary);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.2s;

          &:hover:not(:disabled) {
            background: var(--color-bg-surface-hover);
            color: var(--color-text-primary);
          }

          &.is-active {
            background: var(--color-accent-bg);
            color: var(--color-accent-text);
            border-color: var(--color-accent-border);
          }

          &:disabled {
            color: var(--color-text-disabled);
            cursor: not-allowed;
          }

          .icon {
            width: 20px;
            height: 20px;
          }
        }

        .main-record-btn {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          border: 2px solid var(--color-border-subtle);
          background: transparent;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s;
          padding: 0;

          &:hover:not(:disabled) {
            background: var(--color-bg-surface-hover);
            border-color: var(--color-border);
          }

          &.start {
            .inner-circle {
              width: 36px;
              height: 36px;
              background: var(--color-danger-solid);
              border-radius: 50%;
              transition: all 0.2s;
              box-shadow: 0 0 10px var(--color-danger-border);
            }

            &:hover .inner-circle {
              transform: scale(1.05);
              box-shadow: 0 0 15px var(--color-danger-border);
            }
          }

          &.stop {
            border-color: var(--color-danger-border);

            .inner-square {
              width: 24px;
              height: 24px;
              background: var(--color-danger-solid);
              border-radius: 4px;
              transition: all 0.2s;
              box-shadow: 0 0 10px var(--color-danger-border);
            }

            &:hover .inner-square {
              transform: scale(1.1);
            }
          }
        }
      }
    }

    .quick-hidden-video {
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
      position: absolute;
      left: -9999px;
      top: -9999px;
    }

    .countdown-overlay {
      position: absolute;
      inset: 0;
      background-color: var(--color-bg-scrim);
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--quick-radius);
      z-index: 20;

      .countdown-number {
        font-size: 64px;
        font-weight: 700;
        animation: none;
      }
    }
  }

  @keyframes scale-up {
    0% {
      transform: scale(0.5);
      opacity: 0;
    }
    50% {
      transform: scale(1.2);
      opacity: 1;
    }
    100% {
      transform: scale(1);
      opacity: 0;
    }
  }

  @keyframes timeline-move {
    0% {
      transform: translateX(-60%);
    }
    100% {
      transform: translateX(160%);
    }
  }
}

@keyframes ping {
  75%,
  100% {
    transform: scale(2);
    opacity: 0;
  }
}

.custom-scrollbar {
  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-raised);
    border-radius: 3px;
    &:hover {
      background: var(--color-bg-raised);
    }
  }
}
</style>
