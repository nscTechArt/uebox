<template>
  <div v-if="pendingAction" class="mini-sensitive-confirm">
    <div class="confirm-header">
      <PhWarning class="warning-icon" />
      <span class="title">{{ $t('miniSensitiveConfirm.header.title') }}</span>
      <span v-if="queueLength > 1" class="queued">
        {{ $t('assistant.sensitiveAction.queued', { count: queueLength - 1 }) }}
      </span>
    </div>
    <div class="confirm-body">
      <div class="action-type">{{ pendingAction.typeLabel }}</div>
      <div class="description">{{ truncateDescription(pendingAction.description) }}</div>
    </div>
    <div class="confirm-footer">
      <AppButton size="small" @click="handleReject">{{
        $t('miniSensitiveConfirm.actions.reject')
      }}</AppButton>
      <AppButton
        v-if="pendingAction.allowAlways"
        size="small"
        variant="primary"
        class="btn-allow"
        @click="handleAllowForSession"
      >
        {{ $t('miniSensitiveConfirm.actions.allowSession') }}
      </AppButton>
      <AppButton size="small" variant="primary" class="btn-confirm" @click="handleConfirm">
        {{ $t('miniSensitiveConfirm.actions.confirm') }}
      </AppButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
/**
 * MiniChat 专用的简化版敏感操作确认组件
 * 相比主版本：
 * - 移除代码详情展示区（节省空间）
 * - 移除"这是什么"AI解释功能
 * - 简化按钮样式和布局
 * - 描述文字自动截断
 *
 * **它只是视图**：待审批本身存在 `pendingApprovals` store 里，监听器挂在全局
 * 事件分发器上（原因见那个 store 的注释）。原来这里自己听 V2 的
 * `agent:confirmation-required` —— 那条通道主进程早就没人发了，
 * 于是小窗口跑 agent 时的审批**根本不显示**，每次都只能等五分钟超时。
 */
import { PhWarning } from '@phosphor-icons/vue'

import { useApprovalDisplay } from '@renderer/components/useApprovalDisplay'

const { current: pendingAction, queueLength, reply } = useApprovalDisplay()

/**
 * 截断描述文字（MiniChat 空间有限）
 */
function truncateDescription(desc: string): string {
  const maxLen = 80
  if (desc.length <= maxLen) return desc
  return desc.slice(0, maxLen) + '...'
}

function handleConfirm(): void {
  reply('approve')
}

/** 「本次会话都允许」。V3 的 'always' 语义就是「本会话内该工具不再询问」，正好对上 */
function handleAllowForSession(): void {
  reply('always')
}

function handleReject(): void {
  reply('reject')
}
</script>

<style scoped lang="less">
.mini-sensitive-confirm {
  background: var(--color-warning-bg);
  border: 1px solid var(--color-warning-border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 8px 0;
  animation: slideIn 0.2s ease-out;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.confirm-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.warning-icon {
  color: var(--color-warning-text);
  font-size: 14px;
}

.title {
  flex: 1;
  font-weight: 600;
  color: var(--color-warning-text);
  font-size: 13px;
}

.queued {
  font-size: 11px;
  color: var(--color-warning-text);
}

.confirm-body {
  margin-bottom: 10px;
}

.action-type {
  font-size: 12px;
  color: var(--color-text-primary);
  font-weight: 500;
  margin-bottom: 4px;
}

.description {
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.4;
  word-break: break-all;
}

.confirm-footer {
  display: flex;
  justify-content: flex-end;
  gap: 6px;

  :deep(.app-button) {
    font-size: 12px;
    height: 26px;
    padding: 0 10px;
  }
}

.btn-allow {
  background: var(--color-success-bg) !important;
  border-color: var(--color-success-border) !important;
  color: var(--color-success-text) !important;

  &:hover {
    background: var(--color-success-bg) !important;
  }
}

.btn-confirm {
  background: var(--color-warning-solid) !important;
  border: none !important;
  color: var(--color-warning-on-solid) !important;
  font-weight: 500;

  &:hover {
    background: var(--color-warning-solid-hover) !important;
  }
}
</style>
