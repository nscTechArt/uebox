<script setup lang="ts">
/**
 * 「有东西没存上」的常驻提示条。
 *
 * ## 为什么必须是常驻的，不能是一条 toast
 *
 * 写盘失败在真机上有两条常见成因，它们都**不会自己好**：用户在资产库切了保管库
 * （条目路径属于上一个库，主进程一律拒绝写入），或者在资源管理器里把包目录改了名。
 * 之后他的每一次编辑都还是「看起来成功」—— 界面照常，只有一行 console.warn。
 * 关掉应用，这段时间画的东西全没了。
 *
 * 一条三秒就消失的 toast 挡不住这个：用户可能正低头改图，抬头时它已经没了，
 * 而问题还在。所以这里是一条待在页面上、直到真的存进去才消失的横幅。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhWarningCircle } from '@phosphor-icons/vue'

import AppButton from '@renderer/components/AppButton.vue'
import type { LibrarySaveStateView } from '@renderer/store/modules/libraryPersistence'

const props = defineProps<{ saveState?: LibrarySaveStateView }>()

const visible = computed(() => props.saveState?.status === 'error')
const retrying = computed(() => props.saveState?.status === 'saving')
const failedCount = computed(() => props.saveState?.failedCount ?? 0)
const reason = computed(() => props.saveState?.lastError ?? '')

const { t } = useI18n()

async function retry(): Promise<void> {
  await props.saveState?.retry()
}
</script>

<template>
  <div v-if="visible" class="library-save-alert" role="alert">
    <PhWarningCircle :size="18" weight="fill" class="icon" />
    <div class="body">
      <div class="title">{{ t('libraryBrowser.saveAlert.title', { count: failedCount }) }}</div>
      <div class="desc">
        {{ t('libraryBrowser.saveAlert.desc') }}
        <span v-if="reason" class="reason">{{ reason }}</span>
      </div>
    </div>
    <AppButton size="small" :loading="retrying" @click="retry">
      {{ t('libraryBrowser.saveAlert.retry') }}
    </AppButton>
  </div>
</template>

<style scoped lang="less">
.library-save-alert {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-danger-bg);
  border: 1px solid var(--color-danger-border);
  border-radius: var(--radius-md);
}

.icon {
  color: var(--color-danger-text);
  flex-shrink: 0;
}

.body {
  flex: 1;
  min-width: 0;
}

.title {
  color: var(--color-text-primary);
  font-weight: 600;
}

.desc {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.reason {
  color: var(--color-text-muted);
}
</style>
