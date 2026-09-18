<script setup lang="ts">
import { computed, ref } from 'vue'
import { nodeViewProps, NodeViewWrapper } from '@tiptap/vue-3'
import { PhWarningCircle } from '@phosphor-icons/vue'

import { toLocalResourceUrl } from '@renderer/utils/localResource'

const props = defineProps(nodeViewProps)

const failed = ref(false)

/** 存的是保管库里的绝对路径，播放前转成本地资源 URL */
const src = computed(() => {
  const raw = props.node.attrs.src
  return raw ? toLocalResourceUrl(raw) : ''
})

const name = computed(() => props.node.attrs.name || '')
</script>

<template>
  <NodeViewWrapper class="video-embed-wrapper">
    <div class="video-embed" contenteditable="false" data-drag-handle>
      <!-- 播不出来要说出来。静默显示一个黑框，用户只会以为是软件坏了 -->
      <div v-if="failed || !src" class="video-embed-failed">
        <PhWarningCircle class="video-embed-failed-icon" />
        <span>{{ $t('noteEditor.video.playFailed') }}</span>
        <span v-if="name" class="video-embed-failed-name">{{ name }}</span>
      </div>
      <video
        v-else
        class="video-embed-player"
        controls
        preload="metadata"
        :src="src"
        :aria-label="name"
        @error="failed = true"
      />
    </div>
  </NodeViewWrapper>
</template>

<style scoped lang="less">
.video-embed-wrapper {
  margin: 8px 0;
}

.video-embed {
  max-width: 100%;
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-subtle);
  user-select: none;
}

.video-embed-player {
  display: block;
  width: 100%;
  max-height: 480px;
  background: var(--color-bg-sunken);
}

.video-embed-failed {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  color: var(--color-text-muted);
  font-size: 13px;
}

.video-embed-failed-icon {
  font-size: 16px;
  color: var(--color-warning-text);
}

.video-embed-failed-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
