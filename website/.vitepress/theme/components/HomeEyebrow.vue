<script setup lang="ts">
/**
 * 首屏大标题上面那一行小字。
 *
 * 它承担的是「这是什么、管哪几个版本」——默认主题的 hero 只有名字、一句话、
 * 一段说明三层，产品类别没有位置放，只能塞进 tagline 里把那句话撑长。
 *
 * 等宽字 + 字距是刻意的：它要读起来像一行规格，不像一句广告。
 */
</script>

<template>
  <p class="home-eyebrow">AGENT HARNESS · UNREAL ENGINE 5.0 – 5.8</p>
</template>

<style scoped>
.home-eyebrow {
  margin: 0 0 14px;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  line-height: 1.4;
  letter-spacing: 0.14em;
  color: var(--vp-c-text-3);
  white-space: nowrap;
}

@media (max-width: 959px) {
  .home-eyebrow {
    white-space: normal;
  }
}
</style>
