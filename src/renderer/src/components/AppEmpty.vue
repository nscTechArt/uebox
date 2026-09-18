<script setup lang="ts">
/**
 * 空状态。接替 ant-design-vue 的 `<a-empty>`（10 处）。
 *
 * 图标用 `aria-hidden` 藏掉，说明文字才是读屏软件唯一该念的东西 ——
 * 念一遍「图片」再念「暂无数据」是噪音。
 *
 * 不给默认插图：a-empty 那张灰色小盒子是 antd 的品牌资产，
 * 换过来正好把它甩掉。需要更具体的图（比如录屏库的场记板）就用 #icon 插槽。
 */
interface Props {
  /** 一行标题。给了就比 description 大一号、颜色深一档 */
  title?: string
  description?: string
}

withDefaults(defineProps<Props>(), { title: undefined, description: undefined })
</script>

<template>
  <div class="app-empty">
    <div class="app-empty__icon" aria-hidden="true">
      <slot name="icon">
        <svg viewBox="0 0 48 48" fill="none">
          <rect x="8" y="14" width="32" height="24" rx="3" stroke="currentColor" stroke-width="2" />
          <path d="M8 22h32" stroke="currentColor" stroke-width="2" />
          <path d="M18 30h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </slot>
    </div>
    <p v-if="title" class="app-empty__title">{{ title }}</p>
    <p v-if="description || $slots.default" class="app-empty__text">
      <slot>{{ description }}</slot>
    </p>
  </div>
</template>

<style scoped>
/*
 * 字号写死，不靠继承。
 * 只给颜色的话，「比说明大一号」纯粹是它继承了正文 14px、而说明钉在 12px ——
 * 宿主随便在祖先上设一个 font-size 就塌成同一号，而且没有字重把它们分开。
 */
.app-empty__title {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  line-height: 1.5;
}

.app-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* 标题和说明是一组，贴着走；和图标之间的距离由图标自己的 margin 拉开 */
  gap: var(--space-1);
  padding: var(--space-6) var(--space-4);
  text-align: center;
}

.app-empty__icon {
  margin-bottom: var(--space-2);
  color: var(--color-text-muted);
  opacity: 0.6;
}

.app-empty__icon :deep(svg) {
  display: block;
  width: 48px;
  height: 48px;
}

.app-empty__text {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}
</style>
