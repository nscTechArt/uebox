<template>
  <div class="screen-recorder-quick-window">
    <ScreenRecorderPanel compact @export="handleRecordingExport" />
  </div>
</template>

<script setup lang="ts">
import { onUnmounted } from 'vue'
import ScreenRecorderPanel from './ScreenRecorderPanel.vue'

const channel = new BroadcastChannel('screen-recorder-cover')

async function handleRecordingExport(payload: { filePath: string; url: string }): Promise<void> {
  channel.postMessage({
    type: 'recording-complete',
    filePath: payload.filePath,
    url: payload.url,
    timestamp: Date.now()
  })
  await window.api.screenRecorder.closeQuickWindow()
}

onUnmounted(() => {
  channel.close()
})
</script>

<style scoped lang="less">
.screen-recorder-quick-window {
  width: 100%;
  height: 100%;
}
</style>
