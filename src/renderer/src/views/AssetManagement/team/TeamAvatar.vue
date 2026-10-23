<template>
  <span class="team-avatar" :class="{ small: size === 'small' }" :title="name">
    {{ initial }}
    <i v-if="online" class="team-avatar-online" />
  </span>
</template>

<script setup lang="ts">
/** 姓名首字圆标，在线时右下角一个小绿点（方案 2.4） */
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{ name: string; online?: boolean; size?: 'small' | 'medium' }>(),
  { online: false, size: 'medium' }
)
const initial = computed(() => Array.from(props.name.trim())[0] ?? '?')
</script>

<style scoped lang="less">
.team-avatar {
  position: relative;
  flex: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--color-accent-bg);
  color: var(--color-accent-text);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);

  &.small {
    width: 20px;
    height: 20px;
    font-size: var(--font-size-xs);
  }
}

.team-avatar-online {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-success-solid);
  border: 2px solid var(--color-bg-surface);
}
</style>
