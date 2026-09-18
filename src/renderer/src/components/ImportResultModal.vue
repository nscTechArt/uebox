<script setup lang="ts">
/**
 * 导入没导全时的「下一层」。
 *
 * ## 为什么要有它
 *
 * 在此之前，一次导入失败用户能拿到的最深信息是一句
 * 「导入完成，7 条警告」——具体缺什么全被渲染层丢掉了。
 * 主进程明明拼出了「依赖不完整：找不到 3 个依赖（T_Wood、M_Base…）」，
 * 传过 IPC 之后没人显示。
 *
 * ## 这里刻意做了两件事
 *
 * 1. **按依赖聚合，不按资产**。一张缺失的贴图影响 300 个动画，是**一行**
 *    「缺 T_Wood，300 个资产用到它」，不是 300 行「XX 导入失败」。
 *    后者除了把弹窗撑爆之外，什么也没告诉用户。
 * 2. **区分「库里没有」和「库里有、源文件丢了」**。这两种的下一步完全不同：
 *    前者要去要素材，后者要去修保管库。都说成「找不到」等于把人堵在原地。
 *
 * 挂在 MainLayout 上（和 AssetLockIndicator、SensitiveActionConfirm 同一层）：
 * 导入是后台跑的，出结果时用户很可能已经在别的页面上了。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import type { ImportFailureReport, MissingDependencyState } from '@core/shared/projectImport'
import AppModal from './AppModal.vue'
import AppButton from './AppButton.vue'

const props = defineProps<{
  open: boolean
  /** 这批导的是什么，用于标题 */
  taskName?: string
  projectName?: string
  report?: ImportFailureReport
  /** 没有可重试的东西时（比如冲突而已）就不给重试按钮 */
  retryable?: boolean
  retrying?: boolean
  retryLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'retry'): void
  /** 去资产库里找这条依赖 */
  (e: 'search', keyword: string): void
}>()

const { t } = useI18n()

const planErrors = computed(() => props.report?.planErrors ?? [])
const missing = computed(() => props.report?.missingDependencies ?? [])
const fileFailures = computed(() => props.report?.fileFailures ?? [])
const conflicts = computed(() => props.report?.conflicts ?? [])
const unconfirmed = computed(() => props.report?.unconfirmed ?? [])
const truncated = computed(() => props.report?.truncated)

/** 一句话说清这次到底怎么了。用户读到的第一行必须是结论，不是分类标题 */
const headline = computed(() => {
  const parts: string[] = []
  if (planErrors.value.length > 0) {
    parts.push(t('importResultModal.headlinePlanErrors', { count: planErrors.value.length }))
  }
  if (missing.value.length > 0) {
    parts.push(t('importResultModal.headlineMissing', { count: missing.value.length }))
  }
  if (fileFailures.value.length > 0) {
    parts.push(t('importResultModal.headlineFiles', { count: fileFailures.value.length }))
  }
  if (unconfirmed.value.length > 0) {
    parts.push(t('importResultModal.headlineUnconfirmed', { count: unconfirmed.value.length }))
  }
  if (conflicts.value.length > 0) {
    parts.push(t('importResultModal.headlineConflicts', { count: conflicts.value.length }))
  }
  // 摊不到具体资产头上的那两类，前面几段都不会提到 —— 单独说，别让弹窗一片空白
  if ((props.report?.unattributedMissing ?? 0) > 0) {
    parts.push(
      t('importResultModal.headlineUnattributed', {
        count: props.report?.unattributedMissing ?? 0
      })
    )
  }
  if ((props.report?.orphanFileFailures ?? 0) > 0) {
    parts.push(
      t('importResultModal.headlineOrphans', { count: props.report?.orphanFileFailures ?? 0 })
    )
  }
  // 一条都凑不出来时别留个空段落 —— 宁可说「没有更多细节」
  return parts.length > 0
    ? parts.join(t('importResultModal.separator'))
    : t('importResultModal.noDetail')
})

const stateLabel = (state: MissingDependencyState): string => t(`importResultModal.state.${state}`)

/** 「库里有、源文件也在却没定位到」是我们这边的问题，别让它看着像用户的锅 */
const stateClass = (state: MissingDependencyState): string =>
  state === 'not-in-vault' ? 'is-absent' : state === 'source-missing' ? 'is-broken' : 'is-ours'

const affectedText = (row: { affectedCount: number; affectedSample: string[] }): string => {
  if (row.affectedCount === 0) return ''
  const sample = row.affectedSample.join(t('importResultModal.listSeparator'))
  const more = row.affectedCount - row.affectedSample.length
  return more > 0
    ? t('importResultModal.affectedMore', { count: row.affectedCount, sample, more })
    : t('importResultModal.affected', { count: row.affectedCount, sample })
}

const copyPath = async (softPath: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(softPath)
    message.success(t('importResultModal.copied'))
  } catch {
    message.error(t('importResultModal.copyFailed'))
  }
}

const close = (): void => emit('update:open', false)
</script>

<template>
  <AppModal
    :open="open"
    :width="640"
    :title="t('importResultModal.title', { name: projectName || taskName || '' })"
    hide-footer
    @update:open="emit('update:open', $event)"
  >
    <p class="headline">{{ headline }}</p>

    <!-- 规划阶段就没能开始的：版本不符、源文件不在、库里没这条记录 -->
    <section v-if="planErrors.length > 0" class="group">
      <h4 class="group-title">{{ t('importResultModal.sectionPlanErrors') }}</h4>
      <ul class="rows">
        <li v-for="(row, i) in planErrors" :key="`${row.assetName}-${i}`" class="row">
          <div class="row-main">
            <span class="row-name">{{ row.assetName }}</span>
          </div>
          <div class="row-path">{{ row.error }}</div>
        </li>
      </ul>
      <p v-if="truncated && truncated.planErrors > 0" class="more">
        {{ t('importResultModal.andMore', { count: truncated.planErrors }) }}
      </p>
    </section>

    <!-- 缺失依赖：一条依赖一行，不是一个资产一行 -->
    <section v-if="missing.length > 0" class="group">
      <h4 class="group-title">{{ t('importResultModal.sectionMissing') }}</h4>
      <ul class="rows">
        <li v-for="row in missing" :key="row.softPath" class="row">
          <div class="row-main">
            <span class="row-name">{{ row.name }}</span>
            <span class="row-state" :class="stateClass(row.state)">{{
              stateLabel(row.state)
            }}</span>
          </div>
          <div class="row-path" :title="row.softPath">{{ row.softPath }}</div>
          <div v-if="row.affectedCount > 0" class="row-affected">{{ affectedText(row) }}</div>
          <div class="row-actions">
            <button type="button" class="link" @click="emit('search', row.name)">
              {{ t('importResultModal.findInVault') }}
            </button>
            <button type="button" class="link" @click="copyPath(row.softPath)">
              {{ t('importResultModal.copyPath') }}
            </button>
          </div>
        </li>
      </ul>
      <p v-if="truncated && truncated.missingDependencies > 0" class="more">
        {{ t('importResultModal.andMore', { count: truncated.missingDependencies }) }}
      </p>
    </section>

    <!-- 没写进工程的文件 -->
    <section v-if="fileFailures.length > 0" class="group">
      <h4 class="group-title">{{ t('importResultModal.sectionFiles') }}</h4>
      <ul class="rows">
        <li v-for="row in fileFailures" :key="row.target" class="row">
          <div class="row-main">
            <span class="row-name">{{ row.name }}</span>
          </div>
          <div class="row-path">{{ row.error }}</div>
          <div v-if="row.affectedCount > 0" class="row-affected">{{ affectedText(row) }}</div>
        </li>
      </ul>
      <p v-if="truncated && truncated.fileFailures > 0" class="more">
        {{ t('importResultModal.andMore', { count: truncated.fileFailures }) }}
      </p>
    </section>

    <!-- 没能确认是否导全 -->
    <section v-if="unconfirmed.length > 0" class="group">
      <h4 class="group-title">{{ t('importResultModal.sectionUnconfirmed') }}</h4>
      <p class="group-note">{{ t('importResultModal.unconfirmedNote') }}</p>
      <p class="row-affected">{{ unconfirmed.join(t('importResultModal.listSeparator')) }}</p>
      <p v-if="truncated && truncated.unconfirmed > 0" class="more">
        {{ t('importResultModal.andMore', { count: truncated.unconfirmed }) }}
      </p>
    </section>

    <!-- 目标路径冲突 -->
    <section v-if="conflicts.length > 0" class="group">
      <h4 class="group-title">{{ t('importResultModal.sectionConflicts') }}</h4>
      <ul class="rows">
        <li v-for="row in conflicts" :key="row.target" class="row">
          <div class="row-main">
            <span class="row-name">{{ row.name }}</span>
          </div>
          <div class="row-path">
            {{ t('importResultModal.conflictKept', { rejected: row.rejectedSource }) }}
          </div>
        </li>
      </ul>
      <p v-if="truncated && truncated.conflicts > 0" class="more">
        {{ t('importResultModal.andMore', { count: truncated.conflicts }) }}
      </p>
    </section>

    <div class="footer">
      <!--
        重试是这里唯一的主动作，也是安全的：导入是增量的，已经在的文件不会重搬，
        缺的会补上。没有任何破坏性动作 —— 那种东西不配放在这个位置。
      -->
      <AppButton v-if="retryable" variant="primary" :loading="retrying" @click="emit('retry')">
        {{ retryLabel || t('importResultModal.retry') }}
      </AppButton>
      <AppButton @click="close">{{ t('importResultModal.close') }}</AppButton>
    </div>
  </AppModal>
</template>

<style lang="less" scoped>
.headline {
  margin: 0 0 var(--space-4);
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.group {
  margin-bottom: var(--space-5);
}

.group-title {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: none;
}

.group-note {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.rows {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 280px;
  overflow-y: auto;
}

.row {
  padding: var(--space-2) 0;
  border-top: 1px solid var(--color-border);

  &:first-child {
    border-top: none;
  }
}

.row-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.row-name {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.row-state {
  flex-shrink: 0;
  padding: 1px var(--space-1);
  border-radius: var(--radius-xs);
  font-size: 10px;
  line-height: 1.6;

  &.is-absent {
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
    border: 1px solid var(--color-warning-border);
  }

  &.is-broken {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
    border: 1px solid var(--color-danger-border);
  }

  &.is-ours {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border-strong);
  }
}

.row-path {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  word-break: break-all;
}

.row-affected {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.row-actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-1);
}

.link {
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-size: var(--font-size-xs);
  color: var(--color-accent-text);
  text-decoration: underline;
  text-underline-offset: 2px;

  &:hover {
    opacity: 0.8;
  }
}

.more {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}
</style>
