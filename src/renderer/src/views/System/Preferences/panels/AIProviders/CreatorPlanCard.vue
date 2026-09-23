<script setup lang="ts">
/**
 * 创作者 Token Plan 卡片：连接、导入预览、套餐状态、断开。
 *
 * 没连接时打开设置页不会联网 —— 主进程的 state 在没有套餐来源时直接返回。
 * 应用、断开之后发 `changed`，由父组件重读模型配置（来源列表和角色绑定都变了）。
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
  CreatorPlanDevicePrompt,
  CreatorPlanErrorCode,
  CreatorPlanPreview,
  CreatorPlanState
} from '@core/shared/creatorPlan'

const emit = defineEmits<{ (e: 'changed'): void }>()

const { t, locale } = useI18n()

const state = ref<CreatorPlanState | null>(null)
const connecting = ref(false)
const prompt = ref<CreatorPlanDevicePrompt | null>(null)
const preview = ref<CreatorPlanPreview | null>(null)
const selected = ref<ModelRole[]>([])
const applying = ref(false)
const confirmingDisconnect = ref(false)

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
  await load()
  emit('changed')
}

async function openManage(): Promise<void> {
  if (summary.value) await window.api.shell.openExternal(summary.value.manageUrl)
}

async function copyCode(): Promise<void> {
  if (prompt.value) await navigator.clipboard.writeText(prompt.value.userCode)
}

const formatNumber = (value: number): string => new Intl.NumberFormat(locale.value).format(value)
const formatDate = (iso: string | null): string =>
  iso ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(iso)) : ''

const summary = computed(() => state.value?.summary ?? null)
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
          <span v-if="summary.textTokens" class="plan-desc">
            {{
              $t('aiProvider.creatorPlan.textTokens', {
                used: formatNumber(summary.textTokens.used),
                limit: formatNumber(summary.textTokens.limit)
              })
            }}
            <template v-if="summary.quotaResetsAt">
              ·
              {{
                $t('aiProvider.creatorPlan.resetsAt', { date: formatDate(summary.quotaResetsAt) })
              }}
            </template>
          </span>
          <span class="plan-desc">
            {{ $t('aiProvider.creatorPlan.managedCount', { count: state.managedRoles.length }) }}
          </span>
        </template>
        <span v-else-if="state.error" class="plan-desc plan-warn">
          {{ errorText(state.error, '') }}
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
