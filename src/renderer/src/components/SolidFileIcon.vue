<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    class="solid-file-icon-svg"
  >
    <!-- 实心文件图标 -->
    <path
      d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z"
      :fill="color"
      stroke="none"
    />
    <!-- 折叠角 -->
    <path d="M14 2V8H20" :fill="color" stroke="none" />
  </svg>
</template>

<script setup lang="ts">
interface Props {
  size?: number | string
  color?: string
}

withDefaults(defineProps<Props>(), {
  size: 48,
  // 半透明白只在深色底上成立，亮色主题下是白底白图标。走中性语义色两边都对。
  color: 'var(--color-filetype-unknown)'
})
</script>

<style scoped>
.solid-file-icon-svg {
  display: block;
  filter: drop-shadow(0 2px 4px var(--shadow-color));
}
</style>
