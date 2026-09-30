<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { PhArrowClockwise } from '@phosphor-icons/vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
import { formatUpdateVersion, useUpdateStore } from '@renderer/store/modules/updateStore'
import { useUpdateInstall } from '@renderer/composables/useUpdateInstall'
import { message } from '@renderer/utils/messageManager'
import { useI18n } from '@renderer/hooks/useI18n'

/**
 * 更新角标，挂在侧边栏左下角版本号的右边。
 *
 * 状态本身在全局 Store 里（store/modules/updateStore.ts），这里只负责画和点。
 * 可更新 / 下载中 / 待重启三态共用这一枚按钮。
 */
const { t } = useI18n()
const updateStore = useUpdateStore()
const { confirmInstall } = useUpdateInstall()
const { phase, latestVersion, downloadPercent } = storeToRefs(updateStore)

const versionLabel = computed(() => formatUpdateVersion(latestVersion.value))

const text = computed(() => {
  if (phase.value === 'downloading') {
    return t('update.downloadingPercent', { percent: downloadPercent.value })
  }
  if (phase.value === 'downloaded') return t('update.restartToUpdate')
  return t('update.newVersionAvailable')
})

const tooltip = computed(() => {
  if (phase.value === 'downloading') {
    return t('update.downloadingHint', { version: versionLabel.value })
  }
  if (phase.value === 'downloaded') return t('update.readyToInstall')
  return t('update.downloadHint', { version: versionLabel.value })
})

/**
 * 三种阶段三件事：可更新 → 开始下载；下载中 → 不响应；已下载 → 问一句再重启。
 */
function handleClick(): void {
  if (phase.value === 'downloading') return

  if (phase.value === 'downloaded') {
    // 弹窗和失败提示都在 useUpdateInstall 里 —— 关于页用的是同一份
    confirmInstall()
    return
  }

  // 下载几百 MB，不能 await 着它画 loading —— 进度走 downloadPercent
  message.info(t('update.downloadStarted'))
  void startDownload()
}

/**
 * 主进程真跑起来之后出的错走 update-error 事件，App.vue 统一报一次。
 * 但「压根没开始」（没配更新源、没有可用更新、已有下载在跑）没有任何事件会推过来，
 * 不在这儿报的话，用户刚被告知「开始下载」，角标却悄悄退回「新版本」。
 */
async function startDownload(): Promise<void> {
  const result = await updateStore.download()
  if (result.success) return
  message.error(result.errorKey ? t(result.errorKey) : result.error || t('update.unavailable'))
}
</script>

<template>
  <AppTooltip v-if="updateStore.hasUpdateNews" placement="top" :title="tooltip">
    <button
      type="button"
      class="update-badge"
      :class="`is-${phase}`"
      :aria-disabled="phase === 'downloading'"
      @click="handleClick"
    >
      <!-- 下载进度直接铺在按钮底色上，不另占一条进度条的位置 -->
      <span
        v-if="phase === 'downloading'"
        class="update-progress"
        :style="{ width: `${downloadPercent}%` }"
      />
      <span class="update-body">
        <PhArrowClockwise v-if="phase === 'downloaded'" class="update-icon" weight="bold" />
        <span class="update-text">{{ text }}</span>
      </span>
    </button>
  </AppTooltip>
</template>

<style scoped lang="less">
/* 反色实底：深色主题下白底黑字，浅色主题下黑底白字 */
.update-badge {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 18px;
  background: var(--color-bg-inverse);
  color: var(--color-text-inverse);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  overflow: hidden;
  transition:
    background var(--motion-fast) var(--easing-standard),
    transform var(--motion-fast) var(--easing-standard);

  /* 内容压在进度条之上 */
  .update-body {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .update-icon {
    font-size: 13px;
    flex-shrink: 0;
  }

  .update-text {
    white-space: nowrap;
    /* 下载中数字每秒都在跳，等宽数字能防止按钮宽度抖动 */
    font-variant-numeric: tabular-nums;
  }

  .update-progress {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 0;
    background: var(--color-text-inverse);
    opacity: 0.16;
    transition: width var(--motion-normal) var(--easing-standard);
  }

  &:not([aria-disabled='true']):hover {
    background: var(--color-bg-inverse-hover);
  }

  &:not([aria-disabled='true']):active {
    transform: scale(0.97);
  }

  /* 下载中用 aria-disabled 而不是 disabled：原生 disabled 会连鼠标事件一起吞掉，
     外面那层 Tooltip 就再也弹不出来了。点击本身在处理函数里已经挡住 */
  &[aria-disabled='true'] {
    cursor: default;
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .update-badge {
    transition: none;
  }
}
</style>
