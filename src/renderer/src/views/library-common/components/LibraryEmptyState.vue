<script setup lang="ts">
/**
 * 库整个是空的时候显示的引导块。
 *
 * 语气按规范走「邀请」而不是「道歉」：标题说这块地方是干什么的，
 * 副文案说下一步做什么，不要「这里什么都没有」。
 */
defineProps<{
  /** 标题，如「材质库还是空的」 */
  title: string
  /** 一句话说明下一步 */
  hint: string
}>()
</script>

<template>
  <div class="library-empty-state">
    <div class="empty-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path
          d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"
        />
      </svg>
    </div>
    <h2>{{ title }}</h2>
    <p>{{ hint }}</p>
    <slot />
  </div>
</template>

<style scoped lang="less">
.library-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px var(--space-6);
  text-align: center;
}

.empty-icon {
  width: 48px;
  height: 48px;
  color: var(--color-text-muted);
  margin-bottom: var(--space-4);

  svg {
    width: 100%;
    height: 100%;
  }
}

h2 {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-secondary);
}

p {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-muted);
  max-width: 380px;
  line-height: var(--line-height-normal);
}
</style>
