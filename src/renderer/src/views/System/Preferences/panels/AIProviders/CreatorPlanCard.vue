<script setup lang="ts">
/**
 * 创作者 Token Plan 卡片：连接、导入预览、套餐状态、断开。
 *
 * 没连接时打开设置页不会联网 —— 主进程的 state 在没有套餐来源时直接返回。
 * 应用、断开之后发 `changed`，由父组件重读模型配置（来源列表和角色绑定都变了）。
 *
 * 额度按清单 quotas 逐项列；续费失败（past_due）常驻一条提醒；清单说要下线的
 * 模型正在用时列出来。断开时服务端没吊销成功，留一句话和去网页端的链接。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/components/AppButton.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import AppModal from '@renderer/components/AppModal.vue'
import { message } from '@renderer/utils/messageManager'
import { creatorPlanAPI } from '@renderer/api/creatorPlan'
import type { ModelRole } from '@core/shared/aiProvider'
import type {
  CreatorPlanDeprecationHit,
  CreatorPlanDevicePrompt,
  CreatorPlanErrorCode,
  CreatorPlanPreview,
  CreatorPlanQuota,
  CreatorPlanState
} from '@core/shared/creatorPlan'

const emit = defineEmits<{ (e: 'changed'): void }>()

const { t, te, locale } = useI18n()

const state = ref<CreatorPlanState | null>(null)
const connecting = ref(false)
const prompt = ref<CreatorPlanDevicePrompt | null>(null)
const preview = ref<CreatorPlanPreview | null>(null)
const selected = ref<ModelRole[]>([])
const applying = ref(false)
const confirmingDisconnect = ref(false)
/** 断开时服务端没吊销成功：网页端 Key 列表的地址，提示用户手动吊销 */
const revokeFailedUrl = ref<string | null>(null)

function errorText(code: CreatorPlanErrorCode, raw: string): string {
  if (code === 'unknown') return t('aiProvider.creatorPlan.errors.unknown', { error: raw })
  // 连不上时带上地址和原因，一眼看出是服务挂了还是地址不对
  if (code === 'network' && raw)
    return t('aiProvider.creatorPlan.errors.networkDetail', { error: raw })
  return t(`aiProvider.creatorPlan.errors.${code}`)
}

async function load(): Promise<void> {
  const result = await creatorPlanAPI.state()
  if (result.ok) state.value = result.data
}

function openPreview(data: CreatorPlanPreview): void {
  preview.value = data
  selected.value = data.changes.filter((c) => c.defaultSelected).map((c) => c.role)
}

async function connect(): Promise<void> {
  connecting.value = true
  const result = await creatorPlanAPI.connect()
  connecting.value = false
  prompt.value = null
  if (result.ok) openPreview(result.data)
  else if (result.code !== 'cancelled') message.error(errorText(result.code, result.error))
}

async function cancel(): Promise<void> {
  await creatorPlanAPI.cancel()
}

async function reimport(): Promise<void> {
  const result = await creatorPlanAPI.preview()
  if (result.ok) openPreview(result.data)
  else message.error(errorText(result.code, result.error))
}

function toggle(role: ModelRole, checked: boolean): void {
  selected.value = checked
    ? [...selected.value, role]
    : selected.value.filter((item) => item !== role)
}

async function apply(): Promise<void> {
  applying.value = true
  const result = await creatorPlanAPI.apply(selected.value)
  applying.value = false
  if (!result.ok) {
    message.error(errorText(result.code, result.error))
    return
  }
  state.value = result.data
  preview.value = null
  message.success(t('aiProvider.creatorPlan.applied'))
  emit('changed')
}

async function disconnect(): Promise<void> {
  confirmingDisconnect.value = false
  const result = await creatorPlanAPI.disconnect()
  if (!result.ok) {
    message.error(errorText(result.code, result.error))
    return
  }
  revokeFailedUrl.value = result.data.revoked ? null : result.data.keysUrl
  await load()
  emit('changed')
}

async function openManage(): Promise<void> {
  if (summary.value) await window.api.shell.openExternal(summary.value.manageUrl)
}

async function openKeys(): Promise<void> {
  if (revokeFailedUrl.value) await window.api.shell.openExternal(revokeFailedUrl.value)
}

async function copyCode(): Promise<void> {
  if (prompt.value) await navigator.clipboard.writeText(prompt.value.userCode)
}

const formatNumber = (value: number): string => new Intl.NumberFormat(locale.value).format(value)
const formatDate = (iso: string | null): string =>
  iso ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(iso)) : ''

function quotaText(quota: CreatorPlanQuota): string {
  const values = { used: formatNumber(quota.used), limit: formatNumber(quota.limit) }
  const key = `aiProvider.creatorPlan.quotas.${quota.key}`
  // 服务端以后加的额度项（v1 只做加法）这边还没文案，照样列出来
  return te(key)
    ? t(key, values)
    : t('aiProvider.creatorPlan.quotaOther', { ...values, key: quota.key })
}

function deprecationText(hit: CreatorPlanDeprecationHit): string {
  const role = t(`aiProvider.roles.${hit.role}`)
  const parts = [
    hit.removedAt
      ? t('aiProvider.creatorPlan.deprecatedUntil', {
          role,
          model: hit.model,
          date: formatDate(hit.removedAt)
        })
      : t('aiProvider.creatorPlan.deprecated', { role, model: hit.model })
  ]
  if (hit.replacedBy) {
    parts.push(t('aiProvider.creatorPlan.deprecatedReplace', { replacement: hit.replacedBy }))
  }
  // 嵌入换模型，向量空间就变了，旧索引会悄悄失效
  if (hit.role === 'embedding') parts.push(t('aiProvider.creatorPlan.deprecatedReindex'))
  return parts.join(' ')
}

const summary = computed(() => state.value?.summary ?? null)
const deprecations = computed(() => state.value?.deprecations ?? [])
const tierLine = computed(() => {
  const s = summary.value
  if (!s?.tierName) return ''
  const interval =
    s.interval === 'year'
      ? t('aiProvider.creatorPlan.intervalYear')
      : t('aiProvider.creatorPlan.intervalMonth')
  return t('aiProvider.creatorPlan.tier', { tier: s.tierName, interval })
})

let unsubscribe: (() => void) | null = null
onMounted(() => {
  unsubscribe = creatorPlanAPI.onDeviceCode((next) => (prompt.value = next))
  void load()
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <div class="plan-card">
    <div class="plan-head">
      <div class="plan-info">
        <span class="plan-title">{{ $t('aiProvider.creatorPlan.title') }}</span>
        <span v-if="!state?.connected" class="plan-desc">
          {{ $t('aiProvider.creatorPlan.desc') }}
        </span>
        <template v-else-if="summary">
          <span class="plan-desc">
            <span v-if="tierLine">{{ tierLine }} · </span>
            <span :class="{ 'plan-warn': summary.status !== 'active' }">
              {{ $t(`aiProvider.creatorPlan.status.${summary.status}`) }}
            </span>
          </span>
          <ul v-if="summary.quotas.length > 0" class="plan-quotas">
            <li v-for="quota in summary.quotas" :key="quota.key" class="plan-desc">
              {{ quotaText(quota) }}
            </li>
          </ul>
          <span v-if="summary.quotaResetsAt" class="plan-desc">
            {{ $t('aiProvider.creatorPlan.resetsAt', { date: formatDate(summary.quotaResetsAt) }) }}
          </span>
          <span class="plan-desc">
            {{ $t('aiProvider.creatorPlan.managedCount', { count: state.managedRoles.length }) }}
          </span>
        </template>
        <span v-else-if="state.error" class="plan-desc plan-warn">
          {{ errorText(state.error, '') }}
        </span>
        <span v-if="!state?.connected && revokeFailedUrl" class="plan-desc plan-warn">
          {{ $t('aiProvider.creatorPlan.revokeFailed') }}
          <AppButton variant="link" size="small" class="plan-link" @click="openKeys">
            {{ $t('aiProvider.creatorPlan.revokeOpen') }}
          </AppButton>
        </span>
      </div>

      <div class="plan-actions">
        <template v-if="!state?.connected || state.error === 'unauthorized'">
          <AppButton v-if="connecting" variant="default" @click="cancel">
            {{ $t('aiProvider.creatorPlan.cancel') }}
          </AppButton>
          <AppButton variant="primary" :loading="connecting" @click="connect">
            {{
              connecting
                ? $t('aiProvider.creatorPlan.connecting')
                : $t('aiProvider.creatorPlan.connect')
            }}
          </AppButton>
        </template>
        <template v-else>
          <AppButton v-if="summary" variant="soft" @click="openManage">
            {{ $t('aiProvider.creatorPlan.manage') }}
          </AppButton>
          <AppButton variant="soft" @click="reimport">
            {{ $t('aiProvider.creatorPlan.reimport') }}
          </AppButton>
          <AppButton variant="text" danger @click="confirmingDisconnect = true">
            {{ $t('aiProvider.creatorPlan.disconnect') }}
          </AppButton>
        </template>
      </div>
    </div>

    <!-- 续费失败：宽限期内照常能用，但过了就停，所以常驻提醒，不收起来 -->
    <div v-if="state?.connected && summary?.status === 'past_due'" class="plan-alert" role="alert">
      <span>{{ $t('aiProvider.creatorPlan.pastDue') }}</span>
      <AppButton variant="primary" size="small" @click="openManage">
        {{ $t('aiProvider.creatorPlan.pastDueAction') }}
      </AppButton>
    </div>

    <!-- 清单说要下线、而且正在用的模型 -->
    <ul v-if="state?.connected && deprecations.length > 0" class="plan-deprecations">
      <li v-for="hit in deprecations" :key="hit.role" class="plan-desc plan-warn">
        {{ deprecationText(hit) }}
      </li>
    </ul>

    <!-- 设备授权：浏览器已自动打开，这里显示码供核对 -->
    <AppModal
      :open="prompt !== null"
      :title="$t('aiProvider.creatorPlan.codeTitle')"
      hide-footer
      centered
      @cancel="cancel"
    >
      <div v-if="prompt" class="code-box">
        <p class="plan-desc">{{ $t('aiProvider.creatorPlan.codeDesc') }}</p>
        <button
          type="button"
          class="code"
          :title="$t('aiProvider.creatorPlan.codeCopy')"
          @click="copyCode"
        >
          {{ prompt.userCode }}
        </button>
        <p class="plan-desc">
          {{ $t('aiProvider.creatorPlan.notOpened') }}
          <code>{{ prompt.verificationUri }}</code>
        </p>
      </div>
    </AppModal>

    <!-- 导入预览：选哪些角色交给套餐 -->
    <AppModal
      :open="preview !== null"
      :title="$t('aiProvider.creatorPlan.previewTitle')"
      :ok-text="$t('aiProvider.creatorPlan.apply')"
      :confirm-loading="applying"
      centered
      @ok="apply"
      @cancel="preview = null"
    >
      <div v-if="preview" class="preview">
        <p class="plan-desc">{{ $t('aiProvider.creatorPlan.previewDesc') }}</p>
        <div v-for="change in preview.changes" :key="change.role" class="preview-row">
          <AppCheckbox
            :checked="selected.includes(change.role)"
            @update:checked="(value: boolean) => toggle(change.role, value)"
          >
            {{ $t(`aiProvider.roles.${change.role}`) }}
          </AppCheckbox>
          <span class="preview-meta">
            <span>{{ change.modelDisplayName }}</span>
            <span v-if="change.managed">{{ $t('aiProvider.creatorPlan.previewManaged') }}</span>
            <span v-else-if="change.current">
              {{
                $t('aiProvider.creatorPlan.previewCurrent', {
                  name: `${change.current.modelId} · ${change.current.providerName}`
                })
              }}
            </span>
            <span v-else>{{ $t('aiProvider.creatorPlan.previewUnset') }}</span>
          </span>
        </div>
      </div>
    </AppModal>

    <AppModal
      :open="confirmingDisconnect"
      :title="$t('aiProvider.creatorPlan.disconnect')"
      :ok-text="$t('aiProvider.creatorPlan.disconnect')"
      ok-danger
      centered
      @ok="disconnect"
      @cancel="confirmingDisconnect = false"
    >
      <p class="plan-desc">{{ $t('aiProvider.creatorPlan.disconnectConfirm') }}</p>
    </AppModal>
  </div>
</template>

<style scoped>
.plan-card {
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-accent-border);
  border-radius: var(--radius-lg);
  background: var(--color-accent-bg);
}

.plan-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.plan-info {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.plan-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
}

.plan-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.plan-warn {
  color: var(--color-warning-text);
}

.plan-quotas,
.plan-deprecations {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plan-quotas {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  column-gap: var(--space-4);
}

.plan-deprecations {
  margin-top: var(--space-2);
}

.plan-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-md);
  background: var(--color-warning-bg);
  font-size: 12px;
  color: var(--color-warning-text);
}

.plan-link {
  height: auto;
  padding: 0;
}

.plan-actions {
  display: flex;
  flex: none;
  gap: var(--space-2);
}

.code-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  text-align: center;
}

.code {
  padding: var(--space-2) var(--space-4);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-sunken);
  font-family: var(--font-mono);
  font-size: 24px;
  letter-spacing: 0.15em;
  color: var(--color-text-primary);
  cursor: pointer;
}

.preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.preview-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--color-border-subtle);
}

.preview-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-size: 12px;
  color: var(--color-text-muted);
}
</style>
