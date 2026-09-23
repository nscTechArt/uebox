<script setup lang="ts">
/**
 * 对象存储面板：配置、查看、清理。
 *
 * ## 这页管什么
 *
 * 聊天里带的音视频，配了这里就传进用户**自己的**桶、换一个链接交给模型直接看；
 * 没配就只给本地路径，由 agent 调工具去看。多模态厂商对本地文件只收 base64，
 * 而 base64 会跟着对话每轮重传 —— 链接只有几百字节，能一直留在对话里。
 *
 * ## 渐进式披露
 *
 * 三层，用到哪层才露哪层：开关 → 连接（配好后收成一行摘要）→ 已上传的文件。
 * 连接里只摆必填的；Endpoint 按服务商和 Region 自动算，前缀、公开域名、
 * 寻址方式收进「高级设置」—— 绝大多数人一辈子不用碰。
 *
 * ## 密钥
 *
 * Secret 只进不出：保存时交给主进程的安全存储，读回来只有「有没有」。
 * 输入框留空表示不改，不会把已存的清掉。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  objectStorageAPI,
  type ObjectStorageConfigView,
  type ObjectStorageEntry,
  type ObjectStorageRemoveResult,
  type ObjectStorageUsage
} from '@renderer/api/objectStorage'
import {
  DEFAULT_OBJECT_STORAGE_CONFIG,
  OBJECT_STORAGE_PRESETS,
  PLAN_OBJECT_STORAGE_PRESET,
  type ObjectStorageConfig,
  type ObjectStoragePreset
} from '@core/shared/objectStorage'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import AppButton from '@renderer/components/AppButton.vue'
import AppSwitch from '@renderer/components/AppSwitch.vue'

const { t } = useI18n()

const form = reactive<ObjectStorageConfig>({ ...DEFAULT_OBJECT_STORAGE_CONFIG })
const secretInput = ref('')
const hasSecret = ref(false)
const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)

const objects = ref<ObjectStorageEntry[]>([])
const listing = ref(false)
const listError = ref('')
const removing = ref(false)
/** 已经配好时连接表单收起，点「修改」才展开 */
const editing = ref(false)
const showAdvanced = ref(false)

/**
 * 这几家的 Endpoint 没法从 Region 推出来（R2 要账户 ID，自建的地址各不相同）。
 * 套餐存储没有 Endpoint，也不许推：开关一存就会把留着的自己桶的地址冲掉
 */
const MANUAL_ENDPOINT_PRESETS: ObjectStoragePreset[] = [
  'r2',
  'minio',
  'custom',
  PLAN_OBJECT_STORAGE_PRESET
]
const needsEndpoint = computed(() => MANUAL_ENDPOINT_PRESETS.includes(form.preset))

/** 必填的都有了、Secret 也存过了 —— 以存下来的为准，不看表单里正在改的 */
const configured = ref(false)
/**
 * Box Plan 提供的存储：没有表单可填，只由套餐卡片的导入开启 / 断开时还原。
 * 这时连接那一层换成一行说明和用量，文件那一层照旧。
 */
const planManaged = computed(() => form.preset === PLAN_OBJECT_STORAGE_PRESET)
const planUsage = ref<ObjectStorageUsage | null>(null)
const showForm = computed(
  () => form.enabled && !planManaged.value && (!configured.value || editing.value)
)
const showFiles = computed(
  () => form.enabled && (configured.value || planManaged.value) && !editing.value
)
const connectionSummary = computed(() =>
  t('profile.objectStorage.connectedSummary', {
    provider: t(`profile.objectStorage.presets.${form.preset}`),
    bucket: form.bucket,
    region: form.region
  })
)

const presetOptions = computed(() =>
  (Object.keys(OBJECT_STORAGE_PRESETS) as ObjectStoragePreset[])
    .filter((value) => value !== PLAN_OBJECT_STORAGE_PRESET)
    .map((value) => ({
      value,
      label: t(`profile.objectStorage.presets.${value}`)
    }))
)

const totalSize = computed(() => objects.value.reduce((sum, item) => sum + item.size, 0))

/**
 * 当前 endpoint 是按哪个 Region 从预设模板推出来的。只有 endpoint 还是「模板 + 这个 Region」
 * 原样时才跟着 Region 改；高级设置里手填的（中国区、内网、加速域名）一律不碰。
 */
let derivedRegion = ''

function applyView(view: ObjectStorageConfigView): void {
  const { hasSecret: secretSaved, ...config } = view
  Object.assign(form, config)
  derivedRegion = config.region
  hasSecret.value = secretSaved
  secretInput.value = ''
  configured.value = Boolean(
    secretSaved && config.endpoint && config.region && config.bucket && config.accessKeyId
  )
}

/** 换预设：填上那家的默认 endpoint / region / 寻址方式。用户已经填过的 endpoint 也换掉 —— 换预设就是想换家 */
function onPresetChange(value: ObjectStoragePreset): void {
  const preset = OBJECT_STORAGE_PRESETS[value]
  form.preset = value
  form.region = preset.region
  form.endpoint = preset.endpoint.replace('{region}', preset.region)
  derivedRegion = preset.region
  form.forcePathStyle = preset.forcePathStyle
}

/** 改 region 时，endpoint 若还是按模板推出来的原样就跟着换，免得两处对不上签名就错 */
function onRegionChange(): void {
  const template = OBJECT_STORAGE_PRESETS[form.preset]?.endpoint
  const region = form.region.trim()
  if (!template?.includes('{region}') || !region) return
  if (!form.endpoint || form.endpoint === template.replace('{region}', derivedRegion)) {
    form.endpoint = template.replace('{region}', region)
    derivedRegion = region
  }
}

function saveInput(): Parameters<typeof objectStorageAPI.save>[0] {
  // Endpoint 能推出来的就推一遍：用户改了 Region 没离开输入框就点保存，也不会两处对不上
  if (!needsEndpoint.value) onRegionChange()
  return {
    ...form,
    // 留空 = 不改。只有真填了才带过去
    ...(secretInput.value.trim() ? { secretAccessKey: secretInput.value.trim() } : {})
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    applyView(await objectStorageAPI.get())
  } catch (error) {
    message.error(t('profile.objectStorage.loadFailed', { error: (error as Error).message }))
  } finally {
    loading.value = false
  }
  if (showFiles.value) void refreshList()
}

async function save(options: { quiet?: boolean } = {}): Promise<boolean> {
  saving.value = true
  try {
    const result = await objectStorageAPI.save(saveInput())
    if (!result.success || !result.view) {
      message.error(result.error ?? t('profile.objectStorage.saveFailed'))
      return false
    }
    applyView(result.view)
    if (!options.quiet) message.success(t('profile.objectStorage.saved'))
    return true
  } finally {
    saving.value = false
  }
}

/** 连接表单上的「保存」：存完收起成摘要，顺手把文件列表拉出来 */
async function saveConnection(): Promise<void> {
  if (!(await save())) return
  if (configured.value) {
    editing.value = false
    testResult.value = null
    void refreshList()
  }
}

function startEdit(): void {
  editing.value = true
  testResult.value = null
}

/** 放弃修改：按存下来的那份重新读 */
async function cancelEdit(): Promise<void> {
  editing.value = false
  testResult.value = null
  applyView(await objectStorageAPI.get())
}

async function toggleEnabled(next: boolean): Promise<void> {
  form.enabled = next
  await save({ quiet: true })
  if (showFiles.value) void refreshList()
}

/** 自动清理的天数改了就存，不用再去找「保存」按钮 */
async function saveAutoClean(value: number | null): Promise<void> {
  form.autoCleanDays = Math.max(0, Math.floor(Number(value) || 0))
  await save({ quiet: true })
}

async function test(): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await objectStorageAPI.test(saveInput())
  } finally {
    testing.value = false
  }
}

async function refreshList(): Promise<void> {
  listing.value = true
  listError.value = ''
  try {
    const result = await objectStorageAPI.list()
    if (!result.success) {
      listError.value = result.error ?? t('profile.objectStorage.listFailed')
      objects.value = []
      return
    }
    objects.value = result.objects ?? []
    planUsage.value = result.usage ?? null
  } finally {
    listing.value = false
  }
}

function reportRemoval(result: ObjectStorageRemoveResult): void {
  if (!result.success) {
    message.error(result.error ?? t('profile.objectStorage.removeFailed'))
    return
  }
  const failed = result.failed?.length ?? 0
  if (failed > 0) {
    message.warning(
      t('profile.objectStorage.removedPartly', { removed: result.removed ?? 0, failed })
    )
  } else {
    message.success(t('profile.objectStorage.removed', { count: result.removed ?? 0 }))
  }
}

async function runRemoval(action: () => Promise<ObjectStorageRemoveResult>): Promise<void> {
  removing.value = true
  try {
    reportRemoval(await action())
    await refreshList()
  } finally {
    removing.value = false
  }
}

function removeAll(): void {
  const keys = objects.value.map((item) => item.key)
  if (keys.length === 0) return
  confirmDialog({
    title: t('profile.objectStorage.removeAllTitle', { count: keys.length }),
    content: t('profile.objectStorage.removeHint'),
    okText: t('profile.objectStorage.removeOk'),
    cancelText: t('common.cancel'),
    danger: true,
    onOk: () => runRemoval(() => objectStorageAPI.remove(keys))
  })
}

/** 按「自动清理」的天数现在就清一次，不再另设一个天数框 */
function cleanNow(): void {
  const days = form.autoCleanDays
  if (days <= 0) return
  confirmDialog({
    title: t('profile.objectStorage.cleanTitle', { days }),
    content: t('profile.objectStorage.removeHint'),
    okText: t('profile.objectStorage.removeOk'),
    cancelText: t('common.cancel'),
    danger: true,
    onOk: () => runRemoval(() => objectStorageAPI.clean(days))
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

onMounted(load)
</script>

<template>
  <div class="settings-content">
    <!-- 第一层：开不开 -->
    <section class="settings-section">
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-label">{{ $t('profile.objectStorage.enable') }}</div>
          <div class="setting-desc">{{ $t('profile.objectStorage.enableDesc') }}</div>
        </div>
        <AppSwitch
          :checked="form.enabled"
          :disabled="loading || saving"
          @update:checked="toggleEnabled"
        />
      </div>
    </section>

    <!-- 第二层：连到哪。配好了收成一行 -->
    <section v-if="form.enabled && planManaged" class="settings-section">
      <h4 class="section-title">{{ $t('profile.objectStorage.connection') }}</h4>
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-label">{{ $t('aiProvider.creatorPlan.storage.provider') }}</div>
          <div v-if="planUsage" class="setting-desc">
            {{
              $t('aiProvider.creatorPlan.storage.usage', {
                used: formatSize(planUsage.usedBytes),
                quota: formatSize(planUsage.quotaBytes)
              })
            }}
            <template v-if="planUsage.retentionDays">
              ·
              {{
                $t('aiProvider.creatorPlan.storage.retention', { days: planUsage.retentionDays })
              }}
            </template>
          </div>
          <div class="setting-desc">{{ $t('aiProvider.creatorPlan.storage.switchBack') }}</div>
        </div>
      </div>
    </section>

    <section v-if="form.enabled && configured && !planManaged && !editing" class="settings-section">
      <h4 class="section-title">{{ $t('profile.objectStorage.connection') }}</h4>
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-label">{{ connectionSummary }}</div>
          <div class="setting-desc">{{ form.endpoint }}</div>
        </div>
        <AppButton variant="soft" @click="startEdit">
          {{ $t('profile.objectStorage.edit') }}
        </AppButton>
      </div>
    </section>

    <section v-if="showForm" class="settings-section">
      <h4 class="section-title">{{ $t('profile.objectStorage.connection') }}</h4>
      <a-form layout="vertical" class="storage-form">
        <div class="form-row">
          <a-form-item :label="$t('profile.objectStorage.preset')" class="form-grow">
            <a-select
              :value="form.preset"
              :options="presetOptions"
              @update:value="onPresetChange"
            />
          </a-form-item>
          <a-form-item :label="$t('profile.objectStorage.region')" class="form-grow">
            <a-input v-model:value="form.region" placeholder="cn-hangzhou" @blur="onRegionChange" />
          </a-form-item>
        </div>
        <a-form-item :label="$t('profile.objectStorage.bucket')">
          <a-input v-model:value="form.bucket" placeholder="my-bucket" />
        </a-form-item>
        <a-form-item v-if="needsEndpoint" :label="$t('profile.objectStorage.endpoint')">
          <a-input v-model:value="form.endpoint" />
          <div class="field-hint">{{ $t('profile.objectStorage.endpointHint') }}</div>
        </a-form-item>
        <div class="form-row">
          <a-form-item :label="$t('profile.objectStorage.accessKeyId')" class="form-grow">
            <a-input v-model:value="form.accessKeyId" autocomplete="off" />
          </a-form-item>
          <a-form-item :label="$t('profile.objectStorage.secret')" class="form-grow">
            <a-input-password
              v-model:value="secretInput"
              autocomplete="new-password"
              :placeholder="
                hasSecret
                  ? $t('profile.objectStorage.secretSaved')
                  : $t('profile.objectStorage.secretPlaceholder')
              "
            />
          </a-form-item>
        </div>

        <AppButton
          variant="link"
          size="small"
          class="advanced-toggle"
          @click="showAdvanced = !showAdvanced"
        >
          {{
            showAdvanced
              ? $t('profile.objectStorage.hideAdvanced')
              : $t('profile.objectStorage.advanced')
          }}
        </AppButton>

        <template v-if="showAdvanced">
          <a-form-item v-if="!needsEndpoint" :label="$t('profile.objectStorage.endpoint')">
            <a-input v-model:value="form.endpoint" />
          </a-form-item>
          <a-form-item :label="$t('profile.objectStorage.prefix')">
            <a-input v-model:value="form.prefix" placeholder="uebox-media/" />
          </a-form-item>
          <a-form-item :label="$t('profile.objectStorage.publicBaseUrl')">
            <a-input v-model:value="form.publicBaseUrl" placeholder="https://cdn.example.com" />
            <div class="field-hint">{{ $t('profile.objectStorage.publicBaseUrlHint') }}</div>
          </a-form-item>
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-label">{{ $t('profile.objectStorage.pathStyle') }}</div>
              <div class="setting-desc">{{ $t('profile.objectStorage.pathStyleDesc') }}</div>
            </div>
            <AppSwitch v-model:checked="form.forcePathStyle" />
          </div>
        </template>
      </a-form>

      <div v-if="testResult" class="test-result" :class="testResult.ok ? 'ok' : 'fail'">
        {{ testResult.message }}
      </div>

      <div class="form-footer">
        <span class="setting-desc">{{ $t('profile.objectStorage.privacyNote') }}</span>
        <div class="form-actions">
          <AppButton v-if="editing" variant="text" @click="cancelEdit">
            {{ $t('common.cancel') }}
          </AppButton>
          <AppButton variant="soft" :loading="testing" @click="test">
            {{ $t('profile.objectStorage.test') }}
          </AppButton>
          <AppButton variant="primary" :loading="saving" @click="saveConnection">
            {{ $t('profile.objectStorage.save') }}
          </AppButton>
        </div>
      </div>
    </section>

    <!-- 第三层：传上去的东西。配好了才有 -->
    <section v-if="showFiles" class="settings-section">
      <h4 class="section-title">
        {{ $t('profile.objectStorage.objects') }}
        <span v-if="objects.length" class="section-meta">
          {{
            $t('profile.objectStorage.summary', {
              count: objects.length,
              size: formatSize(totalSize)
            })
          }}
        </span>
        <span v-else-if="!listing && !listError" class="section-meta">
          {{ $t('profile.objectStorage.empty') }}
        </span>
        <span class="toolbar-spacer" />
        <AppButton
          v-if="objects.length"
          variant="text"
          size="small"
          danger
          :disabled="removing"
          @click="removeAll"
        >
          {{ $t('profile.objectStorage.removeAll') }}
        </AppButton>
        <AppButton variant="text" size="small" :loading="listing" @click="refreshList">
          {{ $t('profile.objectStorage.refresh') }}
        </AppButton>
      </h4>

      <div v-if="listError" class="list-state warn">{{ listError }}</div>

      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-label">{{ $t('profile.objectStorage.autoClean') }}</div>
          <div class="setting-desc">{{ $t('profile.objectStorage.autoCleanDesc') }}</div>
        </div>
        <div class="setting-actions">
          <a-input-number
            :value="form.autoCleanDays"
            :min="0"
            :max="3650"
            :precision="0"
            class="days-input"
            @change="saveAutoClean"
          />
          <AppButton
            variant="soft"
            :disabled="removing || form.autoCleanDays <= 0 || objects.length === 0"
            @click="cleanNow"
          >
            {{ $t('profile.objectStorage.cleanNow') }}
          </AppButton>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 通用设置项样式照 ProfileCli / ProfileGeneral 抄的 —— 各面板各自 scoped，没有共享样式表 */
.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.section-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
}

.section-meta {
  font-size: 12px;
  font-weight: var(--font-weight-normal);
  color: var(--color-text-muted);
}

.settings-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.setting-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.setting-desc {
  font-size: 12px;
  color: var(--color-text-muted);
}

.setting-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.storage-form {
  display: flex;
  flex-direction: column;
}

.form-row {
  display: flex;
  gap: var(--space-4);
}

.form-grow {
  flex: 1;
  min-width: 0;
}

.field-hint {
  margin-top: var(--space-1);
  font-size: 12px;
  color: var(--color-text-muted);
}

.advanced-toggle {
  align-self: flex-start;
  margin-bottom: var(--space-4);
}

.form-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.test-result {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: 12px;
  user-select: text;
}

.test-result.ok {
  background: var(--color-success-bg);
  color: var(--color-success-text);
}

.test-result.fail {
  background: var(--color-danger-bg);
  color: var(--color-danger-text);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.days-input {
  width: 80px;
}

.toolbar-spacer {
  flex: 1;
}

.list-state {
  font-size: 12px;
  color: var(--color-text-muted);
}

.list-state.warn {
  color: var(--color-warning-text);
}
</style>
