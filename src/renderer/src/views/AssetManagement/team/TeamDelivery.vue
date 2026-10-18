<template>
  <div class="team-page team-delivery" data-testid="team-delivery">
    <div v-if="loading && !delivery" class="card-grid">
      <span v-for="n in 4" :key="n" class="skeleton-card" />
    </div>
    <div v-else-if="error" class="page-state">
      {{ t('teamProject.activity.error') }}
      <AppButton size="small" @click="load">{{ t('teamProject.retry') }}</AppButton>
    </div>
    <template v-else-if="delivery">
      <!-- 工具栏：左「交付 7 · 300 个」；右 [通过] [打回] 作用于选中的；什么都没选时 [全部通过] -->
      <div class="delivery-bar">
        <span class="bar-title">
          {{ t('teamProject.outsource.toolbar', { n: delivery.n, count: delivery.counts.total }) }}
        </span>
        <span class="muted">{{ delivery.message }}</span>
        <span class="bar-actions">
          <template v-if="selected.size > 0">
            <AppButton
              size="small"
              variant="primary"
              :loading="busy"
              @click="approve([...selected])"
            >
              {{ t('teamProject.outsource.approve') }}
            </AppButton>
            <AppButton size="small" @click="reject([...selected])">
              {{ t('teamProject.outsource.reject') }}
            </AppButton>
          </template>
          <AppButton
            v-else-if="waitingItems.length > 0"
            size="small"
            variant="primary"
            :loading="busy"
            data-testid="team-approve-all"
            @click="approve(waitingItems.map((item) => item.path))"
          >
            {{ t('teamProject.outsource.approveAll') }}
          </AppButton>
        </span>
      </div>

      <div v-if="waitingItems.length === 0" class="muted">
        {{ t('teamProject.outsource.approveEmpty') }}
      </div>

      <div class="card-grid">
        <div
          v-for="item in items"
          :key="item.path"
          class="asset-card"
          :class="{
            selected: selected.has(item.path),
            missing: item.missingReferences.length > 0,
            done: item.state !== 'waiting'
          }"
          :title="cardTitle(item)"
          @click="toggle(item)"
        >
          <!-- 右上角检查结果「⚠ 2」：提醒是黄色，悬停写具体问题；被打回的写「打回」 -->
          <span v-if="item.state === 'rejected'" class="corner rejected">
            {{ t('teamProject.outsource.rejectedTag') }}
          </span>
          <span v-else-if="item.state === 'approved'" class="corner approved">
            {{ t('teamProject.outsource.approve') }}
          </span>
          <span v-else-if="warnCount(item) > 0" class="corner warn">⚠ {{ warnCount(item) }}</span>
          <TeamThumb :hash="item.hash" :path="item.path" :library="areaLibrary" size="large" />
          <div class="card-name">{{ assetNameOf(item.path) }}</div>
          <div class="card-sub">{{ folderOf(item.path) }}</div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 收交付（方案 4.13）：就是这个交付文件夹的网格，沿用多选。
 * - 缺引用的（参考里没有、交付里也没有、工程里也没有）卡片加红框，悬停「缺引用：M_Master_Rock」；
 * - [通过]：能进的进团队工程的相同路径，自动生成一次提交（「来自 某某外包 · 交付 7」）；
 *   进不了的合成一行「跳过 4 个：2 个缺引用，2 个 阿杰 已签出。」，留在这一批里等处理；
 * - [打回]：原因必填，挂在那一版上，对方看得到。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/components/AppButton.vue'
import type { TeamDelivery, TeamDeliveryItem } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { onTeamJob } from '@renderer/store/modules/assetLibraryStore'
import { message } from '@renderer/utils/messageManager'
import TeamThumb from './TeamThumb.vue'
import { assetNameOf, checkText, folderOf } from './teamFormat'
import { loadFacts } from './teamFacts'
import { openTeamDialog } from './teamDialogs'

const { t } = useI18n()
const teamStore = useTeamStore()

const delivery = ref<TeamDelivery | null>(null)
const items = ref<TeamDeliveryItem[]>([])
const selected = ref(new Set<string>())
const loading = ref(false)
const busy = ref(false)
const error = ref(false)

const areaLibrary = computed(() => {
  const companyId = delivery.value?.company.id
  return teamStore.companies.find((c) => c.id === companyId)?.area?.library ?? null
})
const waitingItems = computed(() => items.value.filter((item) => item.state === 'waiting'))

function warnCount(item: TeamDeliveryItem): number {
  return item.checks.filter((check) => check.level === 'warn').length
}

function cardTitle(item: TeamDeliveryItem): string {
  const lines = [item.path]
  if (item.missingReferences.length > 0)
    lines.push(
      t('teamProject.outsource.missingRef', {
        name: item.missingReferences
          .map((ref) => ref.split('/').pop())
          .join(t('teamProject.nameSep'))
      })
    )
  for (const check of item.checks.filter((c) => c.rule !== 'no-broken-references'))
    lines.push(checkText(check, t))
  if (item.state === 'rejected' && item.reason)
    lines.push(
      t('teamProject.outsource.rejectedDetail', {
        reason: item.reason,
        who: item.rejectedBy?.name ?? ''
      })
    )
  return lines.join('\n')
}

async function load(): Promise<void> {
  const key = teamStore.key
  const id = teamStore.params.deliveryId
  if (!key || !id) return
  loading.value = true
  error.value = false
  try {
    const result = await teamAPI.delivery(key, id)
    delivery.value = result.delivery
    items.value = result.items
    selected.value = new Set(
      [...selected.value].filter((path) =>
        result.items.some((i) => i.path === path && i.state === 'waiting')
      )
    )
    void loadFacts(
      key,
      result.items.map((item) => item.hash),
      areaLibrary.value
    )
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

function toggle(item: TeamDeliveryItem): void {
  if (item.state !== 'waiting') return
  const next = new Set(selected.value)
  if (next.has(item.path)) next.delete(item.path)
  else next.add(item.path)
  selected.value = next
}

async function approve(paths: string[]): Promise<void> {
  const key = teamStore.key
  const current = delivery.value
  if (!key || !current) return
  const wanted = items.value.filter((item) => paths.includes(item.path) && item.state === 'waiting')
  const missing = wanted.filter((item) => item.missingReferences.length > 0)
  const held = wanted.filter((item) => {
    const checkout = teamStore.checkoutOf(item.path)
    return checkout && checkout.holder.id !== teamStore.me && item.missingReferences.length === 0
  })
  const ok = wanted.filter((item) => !missing.includes(item) && !held.includes(item))
  if (missing.length + held.length > 0) {
    const parts: string[] = []
    if (missing.length) parts.push(t('teamProject.outsource.skippedMissing', { n: missing.length }))
    if (held.length)
      parts.push(
        t('teamProject.outsource.skippedHeld', {
          n: held.length,
          who: teamStore.checkoutOf(held[0].path)?.holder.name ?? ''
        })
      )
    message.warning(
      t('teamProject.outsource.skipped', {
        n: missing.length + held.length,
        parts: parts.join(t('teamProject.listSep'))
      })
    )
  }
  if (ok.length === 0) return
  busy.value = true
  const result = await teamAPI.approveDelivery(key, {
    id: current.id,
    paths: ok.map((item) => item.path),
    message: t('teamProject.outsource.fromCompany', { company: current.company.name, n: current.n })
  })
  if (!result.success) {
    busy.value = false
    message.error(t('teamProject.dialogs.failed'))
  }
}

async function reject(paths: string[]): Promise<void> {
  const current = delivery.value
  if (!current) return
  const done = await openTeamDialog({ kind: 'rejectAssets', deliveryId: current.id, paths })
  if (done) {
    selected.value = new Set()
    void load()
  }
}

const stop = onTeamJob((job) => {
  if (job.type !== 'approve') return
  busy.value = false
  if (job.phase === 'failed') message.error(t('teamProject.dialogs.failed'))
  selected.value = new Set()
  void load()
})
onUnmounted(stop)

watch(
  () => teamStore.params.deliveryId,
  () => void load()
)
onMounted(() => void load())
</script>

<style scoped lang="less">
@import './teamPage.less';

.delivery-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.bar-title {
  color: var(--color-text-primary);
  font-weight: var(--font-weight-semibold);
}

.bar-actions {
  display: flex;
  gap: var(--space-2);
  margin-left: auto;
}

.muted {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.asset-card {
  &.missing {
    border-color: var(--color-danger-solid);
  }

  &.done {
    opacity: 0.6;
    cursor: default;
  }
}

.corner {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  z-index: 1;
  padding: 0 var(--space-1);
  border-radius: var(--radius-xs);
  font-size: var(--font-size-xs);

  &.warn {
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
  }

  &.rejected {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }

  &.approved {
    background: var(--color-success-bg);
    color: var(--color-success-text);
  }
}
</style>
