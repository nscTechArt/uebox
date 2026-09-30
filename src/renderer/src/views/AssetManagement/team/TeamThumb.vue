<template>
  <div
    class="team-thumb"
    :class="{ deleted, small: size === 'small', large: size === 'large' }"
    :title="title"
  >
    <img
      v-if="fact?.preview"
      :src="large ? (fact.previewLarge ?? fact.preview) : fact.preview"
      alt=""
    />
    <!-- 没有缩略图的文件用类型图标（方案 2.10） -->
    <span v-else class="team-thumb-type" :style="typeStyle">{{ typeLetter }}</span>
  </div>
</template>

<script setup lang="ts">
/** 一个内容哈希的缩略图；删除的置灰（方案 2.9） */
import { computed } from 'vue'
import { factOf } from './teamFacts'
import { useTeamStore } from '@renderer/store/modules/teamStore'

const props = withDefaults(
  defineProps<{
    hash: string | null | undefined
    path?: string
    library?: string | null
    deleted?: boolean
    size?: 'small' | 'medium' | 'large'
    title?: string
  }>(),
  { path: '', library: null, deleted: false, size: 'medium', title: undefined }
)

const teamStore = useTeamStore()
const large = computed(() => props.size === 'large')
const fact = computed(() => factOf(teamStore.key, props.hash, props.library))

const ext = computed(() => (props.path.split('.').pop() ?? '').toLowerCase())
const typeLetter = computed(() => {
  const cls = fact.value?.classCn ?? fact.value?.class
  if (cls) return cls.slice(0, 1)
  return ext.value ? ext.value.slice(0, 3).toUpperCase() : '?'
})
const typeStyle = computed(() =>
  fact.value?.classColor ? { color: fact.value.classColor } : undefined
)
</script>

<style scoped lang="less">
.team-thumb {
  position: relative;
  flex: none;
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border-subtle);

  &.small {
    width: 32px;
    height: 32px;
  }

  &.large {
    width: 100%;
    height: auto;
    aspect-ratio: 1;
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  &.deleted {
    filter: grayscale(1);
    opacity: 0.55;
  }
}

.team-thumb-type {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
}
</style>
