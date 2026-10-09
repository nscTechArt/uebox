<script setup lang="ts">
/**
 * 顶栏的状态监控：这条对话归属的工程，编辑器现在的状况。
 *
 * - 工程没连着编辑器：整个按钮不出现
 * - 一切正常：灰色图标
 * - 有项偏离预期：图标变黄，带个数
 *
 * 数据什么时候读：工程连上时、盒子窗口重新拿到焦点时（用户刚从编辑器切回来）、
 * 点开面板时，外加面板里的手动刷新。不定时轮询 —— 这些数字大多在启动和进 PIE 时
 * 才定下来，一直刷没有意义。
 *
 * 判定（预期值、好坏）在 shared/editorHealth.ts，这里只负责显示。
 */
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhArrowClockwise, PhHeartbeat, PhWarning } from '@phosphor-icons/vue'
import { useConnectedProjects } from '@renderer/composables/useBridgeStatus'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { listConnectedProjects } from '../composables/ueProjectContext'
import { getEditorHealth } from '@renderer/api/editorHealth'
import type {
  EditorHealthGroup,
  EditorHealthItem,
  EditorHealthResult
} from '@core/shared/editorHealth'

const props = withDefaults(
  defineProps<{
    chatSid?: string
    /** 对话还没进 store 时的待定归属，同 SessionProjectChip */
    pendingProjectName?: string
  }>(),
  { chatSid: '', pendingProjectName: '' }
)

const { t } = useI18n()
const chatStore = useChatSessionsStore()
const connectedRaw = useConnectedProjects()

/** 归属判定照 SessionProjectChip：`null` 是用户明说了不归属，不回落到待定值 */
const projectName = computed<string>(() => {
  const stored = props.chatSid ? chatStore.sessionById(props.chatSid)?.project : undefined
  if (stored === undefined) return props.pendingProjectName.trim()
  return stored?.projectName ?? ''
})

const liveProject = computed(() => {
  const name = projectName.value.toLowerCase()
  if (!name) return null
  return (
    listConnectedProjects(connectedRaw.value ?? []).find(
      (p) => p.projectName.trim().toLowerCase() === name
    ) ?? null
  )
})

const result = ref<EditorHealthResult | null>(null)
const updatedAt = ref<Date | null>(null)
const loading = ref(false)
/** 正在读的是哪个工程。读到一半换了工程，旧的那份回来就不能再写进来 */
let loadingPath: string | null = null

async function refresh(): Promise<void> {
  const path = liveProject.value?.projectPath
  if (!path || loadingPath === path) return
  loadingPath = path
  loading.value = true
  try {
    const health = await getEditorHealth(path)
    if (liveProject.value?.projectPath !== path) return
    result.value = health
    updatedAt.value = new Date()
  } finally {
    if (loadingPath === path) {
      loadingPath = null
      loading.value = false
    }
  }
}

watch(
  () => liveProject.value?.projectPath,
  (path) => {
    result.value = null
    if (path) void refresh()
  },
  { immediate: true }
)

function onWindowFocus(): void {
  void refresh()
}
onMounted(() => window.addEventListener('focus', onWindowFocus))
onBeforeUnmount(() => window.removeEventListener('focus', onWindowFocus))

const report = computed(() => (result.value?.status === 'ok' ? result.value.report : null))
const issueCount = computed(() => report.value?.issueCount ?? 0)
const badItems = computed(() => report.value?.items.filter((i) => i.status === 'bad') ?? [])

const GROUPS: EditorHealthGroup[] = ['startup', 'pie', 'cache', 'memory']
const groups = computed(() =>
  GROUPS.map((group) => ({
    group,
    items: report.value?.items.filter((i) => i.group === group) ?? []
  })).filter((g) => g.items.length > 0)
)

function formatValue(item: EditorHealthItem, value = item.value): string {
  if (value == null) return '—'
  switch (item.unit) {
    case 'seconds':
      return value >= 60
        ? t('assistantTopNav.statusMonitor.unit.minutesSeconds', {
            m: Math.floor(value / 60),
            s: Math.round(value % 60)
          })
        : t('assistantTopNav.statusMonitor.unit.seconds', { n: value.toFixed(1) })
    case 'percent':
      return `${value.toFixed(1)}%`
    case 'gb':
      return `${value.toFixed(1)} GB`
    case 'bytes':
      return `${(value / 1024 ** 3).toFixed(1)} GB`
    default:
      return String(Math.round(value))
  }
}

function displayValue(item: EditorHealthItem): string {
  if (item.status === 'unsupported') return t('assistantTopNav.statusMonitor.unsupported')
  if (item.status === 'pending') return t('assistantTopNav.statusMonitor.pending')
  return formatValue(item)
}

function expectText(item: EditorHealthItem): string {
  if (!item.expect) return ''
  return `${item.expect.op} ${formatValue(item, item.expect.value)}`
}

function label(item: EditorHealthItem): string {
  return t(`assistantTopNav.statusMonitor.item.${item.id}`)
}

/** 把问题填进这条对话的输入框，发不发由用户决定 */
function askAi(item: EditorHealthItem): void {
  if (!props.chatSid) return
  chatStore.setDraft(
    props.chatSid,
    t('assistantTopNav.statusMonitor.askPrompt', {
      label: label(item),
      value: formatValue(item),
      expect: expectText(item)
    })
  )
}

const updatedText = computed(() =>
  updatedAt.value
    ? t('assistantTopNav.statusMonitor.updatedAt', {
        // 精确到秒：只到分钟的话，同一分钟里点刷新时间纹丝不动，看起来像没刷新
        time: updatedAt.value.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })
      })
    : ''
)

const tooltip = computed(() =>
  issueCount.value > 0
    ? t('assistantTopNav.statusMonitor.tooltipIssues', { n: issueCount.value })
    : t('assistantTopNav.statusMonitor.title')
)
</script>

<template>
  <AppDropdown
    v-if="liveProject"
    :trigger="['click']"
    placement="bottomRight"
    @update:open="(open: boolean) => open && refresh()"
  >
    <AppTooltip placement="bottom" :title="tooltip">
      <span class="monitor-btn" :class="{ bad: issueCount > 0 }" @click.stop>
        <PhHeartbeat class="monitor-icon" />
        <span v-if="issueCount > 0" class="monitor-count">{{ issueCount }}</span>
      </span>
    </AppTooltip>

    <template #overlay>
      <div class="monitor-panel" @click.stop>
        <div class="panel-head">
          <PhHeartbeat class="head-icon" />
          <span class="head-title">{{ t('assistantTopNav.statusMonitor.title') }}</span>
          <span class="head-meta">
            {{ liveProject.projectName
            }}<template v-if="liveProject.engineVersion">
              · UE {{ liveProject.engineVersion.split('-')[0] }}</template
            >
          </span>
        </div>

        <div v-if="result?.status === 'plugin_outdated'" class="panel-note">
          {{ t('assistantTopNav.statusMonitor.pluginOutdated') }}
        </div>
        <div v-else-if="result?.status === 'error'" class="panel-note">
          {{ t('assistantTopNav.statusMonitor.loadFailed') }}
        </div>
        <div v-else-if="!report" class="panel-note">
          {{ t('assistantTopNav.statusMonitor.loading') }}
        </div>

        <template v-else>
          <template v-if="badItems.length > 0">
            <div class="section-title">{{ t('assistantTopNav.statusMonitor.attention') }}</div>
            <div v-for="item in badItems" :key="`bad-${item.id}`" class="bad-item">
              <div class="row">
                <PhWarning class="warn-icon" />
                <span class="row-label">{{ label(item) }}</span>
                <span class="row-value warn">{{ formatValue(item) }}</span>
                <button type="button" class="ask-btn" @click="askAi(item)">
                  {{ t('assistantTopNav.statusMonitor.ask') }}
                </button>
              </div>
              <div class="row-hint">
                {{ t('assistantTopNav.statusMonitor.expect', { expect: expectText(item) }) }}
              </div>
            </div>
          </template>

          <template v-for="g in groups" :key="g.group">
            <div class="section-title">
              {{ t(`assistantTopNav.statusMonitor.group.${g.group}`) }}
            </div>
            <div v-for="item in g.items" :key="item.id" class="row">
              <span class="row-label">{{ label(item) }}</span>
              <span
                class="row-value"
                :class="{
                  warn: item.status === 'bad',
                  muted: item.status === 'pending' || item.status === 'unsupported'
                }"
                >{{ displayValue(item) }}</span
              >
            </div>
          </template>
        </template>

        <div class="panel-foot">
          <span>{{ updatedText }}</span>
          <button type="button" class="ask-btn" :disabled="loading" @click="refresh">
            <PhArrowClockwise class="refresh-icon" :class="{ spinning: loading }" />
            {{ t('assistantTopNav.statusMonitor.refresh') }}
          </button>
        </div>
      </div>
    </template>
  </AppDropdown>
</template>

<style scoped lang="less">
.monitor-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 4px 8px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  background: var(--color-bg-surface);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease;

  &:hover {
    border-color: var(--color-border-strong);
    color: var(--color-text-primary);
  }

  &.bad {
    color: var(--color-warning-text);
    border-color: var(--color-warning-border);
    background: var(--color-warning-bg);
  }
}

.monitor-icon {
  font-size: var(--font-size-base);
}

.monitor-count {
  font-variant-numeric: tabular-nums;
}

.monitor-panel {
  width: 340px;
  max-height: 70vh;
  overflow-y: auto;
  padding: var(--space-1) 0;
  border-radius: var(--radius-container);
  border: 1px solid var(--color-border);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-menu);
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
  cursor: default;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

.head-icon {
  color: var(--color-text-secondary);
  font-size: var(--font-size-base);
}

.head-title {
  flex: 1;
  font-size: var(--font-size-base);
  font-weight: 500;
}

.head-meta {
  color: var(--color-text-muted);
}

.panel-note {
  padding: var(--space-2) var(--space-3) var(--space-3);
  color: var(--color-text-secondary);
}

.section-title {
  padding: var(--space-2) var(--space-3) var(--space-1);
  color: var(--color-text-muted);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 3px var(--space-3);
}

.row-label {
  flex: 1;
  min-width: 0;
}

.row-value {
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;

  &.warn {
    color: var(--color-warning-text);
  }

  &.muted {
    color: var(--color-text-muted);
  }
}

.warn-icon {
  color: var(--color-warning-text);
}

.row-hint {
  padding: 0 var(--space-3) var(--space-1) calc(var(--space-3) + 20px);
  color: var(--color-text-muted);
}

.ask-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  border: 0;
  background: none;
  color: var(--color-accent-text);
  font-size: var(--font-size-sm);
  cursor: pointer;

  &:disabled {
    color: var(--color-text-muted);
    cursor: default;
  }
}

.panel-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-border);
  color: var(--color-text-muted);
}

.refresh-icon.spinning {
  animation: monitor-spin 0.8s linear infinite;
}

@keyframes monitor-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
