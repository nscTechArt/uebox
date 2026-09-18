<script setup lang="ts">
/**
 * Agent V3 调试面板。
 *
 * V3 内核（pi）已经跑通构建和单测，但 steer / 审批 / 压缩 / 子 agent
 * 都还没接触过真实模型和真实引擎。这个面板是**真机验证的入口**：
 * 发 prompt、看事件流、点审批、试插话，一处把这些验完。
 *
 * 它是开发工具不是产品功能 —— 正式对话界面接入 V3 之后，这个面板保留
 * 作为诊断入口（类似 devtools），不做美化。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { agentV3API, type AgentV3Event } from '@renderer/api/agentV3'

const { t } = useI18n()

interface LogLine {
  id: number
  kind: 'info' | 'text' | 'tool' | 'error' | 'meta'
  text: string
}

const sessionId = ref(`debug-${Date.now()}`)
const prompt = ref('')
const steerMessage = ref('')
const approvalMode = ref<AgentV3ApprovalMode>('ask')
const mode = ref<'agent' | 'ask'>('agent')

const running = ref(false)
const lines = ref<LogLine[]>([])
const usage = ref<{ tokens: number; contextWindow: number } | null>(null)
const pendingApproval = ref<{
  toolCallId: string
  toolName: string
  risk: string
  args: unknown
} | null>(null)

let lineSeq = 0
let unsubscribe: (() => void) | null = null

const usagePercent = computed(() => {
  if (!usage.value || usage.value.contextWindow <= 0) return 0
  return Math.min(100, Math.round((usage.value.tokens / usage.value.contextWindow) * 100))
})

function log(kind: LogLine['kind'], text: string): void {
  lines.value.push({ id: ++lineSeq, kind, text })
}

function handleEvent(event: AgentV3Event): void {
  switch (event.type) {
    case 'start':
      log('meta', t('agentV3Debug.log.start'))
      break
    case 'text':
      log('text', event.text)
      break
    case 'thinking':
      log('meta', `💭 ${event.text}`)
      break
    case 'tool-call':
      log('tool', `→ ${event.toolName} ${JSON.stringify(event.args)}`)
      break
    case 'tool-progress':
      log('meta', `  … ${event.toolName}`)
      break
    case 'tool-result':
      log(event.isError ? 'error' : 'tool', `← ${event.toolName}: ${event.text}`)
      break
    case 'step':
      log('meta', t('agentV3Debug.log.step'))
      break
    case 'done':
      log('meta', t('agentV3Debug.log.done'))
      break
    case 'error':
      log('error', event.message)
      break
    case 'context-usage':
      usage.value = { tokens: event.tokens, contextWindow: event.contextWindow }
      break
    case 'compacting':
      log('meta', t('agentV3Debug.log.compacting', { tokens: event.tokensBefore }))
      break
    case 'approval-required':
      pendingApproval.value = {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        risk: event.risk,
        args: event.args
      }
      break
  }
}

function ensureSubscribed(): void {
  unsubscribe?.()
  unsubscribe = agentV3API.subscribe(sessionId.value, handleEvent)
}

async function run(): Promise<void> {
  if (!prompt.value.trim() || running.value) return

  ensureSubscribed()
  running.value = true
  log('info', `> ${prompt.value}`)

  try {
    const result = await agentV3API.execute({
      sessionId: sessionId.value,
      prompt: prompt.value,
      mode: mode.value,
      approvalMode: approvalMode.value
    })
    if (result.success) {
      log(
        'meta',
        t('agentV3Debug.log.modelInfo', {
          provider: result.providerId ?? '-',
          model: result.modelId ?? '-',
          tools: result.toolCount ?? 0,
          restored: result.restoredMessages ?? 0
        })
      )
    } else {
      log('error', result.error ?? t('agentV3Debug.log.unknownError'))
    }
  } catch (error) {
    log('error', (error as Error).message)
  } finally {
    running.value = false
    prompt.value = ''
  }
}

async function steer(): Promise<void> {
  if (!steerMessage.value.trim()) return
  const result = await agentV3API.steer(sessionId.value, steerMessage.value)
  log(
    result.success ? 'info' : 'error',
    result.success
      ? t('agentV3Debug.log.steered', { message: steerMessage.value })
      : (result.error ?? '')
  )
  steerMessage.value = ''
}

async function stop(): Promise<void> {
  const result = await agentV3API.stop(sessionId.value)
  if (!result.success) log('error', result.error ?? '')
}

async function resume(): Promise<void> {
  ensureSubscribed()
  running.value = true
  try {
    const result = await agentV3API.continue(sessionId.value)
    log(
      result.success ? 'meta' : 'error',
      result.success
        ? t('agentV3Debug.log.resumed', { count: result.restoredMessages ?? 0 })
        : (result.error ?? '')
    )
  } finally {
    running.value = false
  }
}

function approve(verdict: AgentV3ApprovalVerdict): void {
  if (!pendingApproval.value) return
  agentV3API.replyApproval(pendingApproval.value.toolCallId, verdict)
  log('info', t('agentV3Debug.log.approvalReplied', { verdict }))
  pendingApproval.value = null
}

async function runSmoke(): Promise<void> {
  const report = await agentV3API.smoke()
  log(report.ok ? 'meta' : 'error', JSON.stringify(report))
}

function newSession(): void {
  unsubscribe?.()
  unsubscribe = null
  sessionId.value = `debug-${Date.now()}`
  lines.value = []
  usage.value = null
  pendingApproval.value = null
}

onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <div class="agent-v3-debug">
    <!-- 标题和描述由 Preferences/index.vue 的页头统一渲染，这里不重复 -->
    <section class="controls">
      <label class="field">
        <span>{{ t('agentV3Debug.sessionId') }}</span>
        <input v-model="sessionId" type="text" :disabled="running" />
      </label>

      <label class="field">
        <span>{{ t('agentV3Debug.mode') }}</span>
        <select v-model="mode" :disabled="running">
          <option value="agent">{{ t('agentV3Debug.modeAgent') }}</option>
          <option value="ask">{{ t('agentV3Debug.modeAsk') }}</option>
        </select>
      </label>

      <label class="field">
        <span>{{ t('agentV3Debug.approvalMode') }}</span>
        <select v-model="approvalMode" :disabled="running">
          <option value="ask">{{ t('agentV3Debug.approvalAsk') }}</option>
          <option value="auto-edit">{{ t('agentV3Debug.approvalAutoEdit') }}</option>
          <option value="yolo">{{ t('agentV3Debug.approvalYolo') }}</option>
        </select>
      </label>
    </section>

    <section v-if="usage" class="usage">
      <div class="usage-bar"><div class="usage-fill" :style="{ width: `${usagePercent}%` }" /></div>
      <span>{{
        t('agentV3Debug.usage', {
          tokens: usage.tokens,
          window: usage.contextWindow,
          percent: usagePercent
        })
      }}</span>
    </section>

    <section v-if="pendingApproval" class="approval">
      <p>
        {{
          t('agentV3Debug.approvalPrompt', {
            tool: pendingApproval.toolName,
            risk: pendingApproval.risk
          })
        }}
      </p>
      <pre>{{ JSON.stringify(pendingApproval.args, null, 2) }}</pre>
      <div class="approval-actions">
        <button @click="approve('approve')">{{ t('agentV3Debug.approve') }}</button>
        <button @click="approve('always')">{{ t('agentV3Debug.approveAlways') }}</button>
        <button class="danger" @click="approve('reject')">{{ t('agentV3Debug.reject') }}</button>
      </div>
    </section>

    <section class="log">
      <p v-if="lines.length === 0" class="empty">{{ t('agentV3Debug.empty') }}</p>
      <div v-for="line in lines" :key="line.id" class="line" :class="line.kind">
        {{ line.text }}
      </div>
    </section>

    <section class="composer">
      <textarea
        v-model="prompt"
        rows="3"
        :placeholder="t('agentV3Debug.promptPlaceholder')"
        :disabled="running"
        @keydown.ctrl.enter="run"
      />
      <div class="actions">
        <button :disabled="running || !prompt.trim()" @click="run">
          {{ running ? t('agentV3Debug.running') : t('agentV3Debug.send') }}
        </button>
        <button :disabled="!running" @click="stop">{{ t('agentV3Debug.stop') }}</button>
        <button :disabled="running" @click="resume">{{ t('agentV3Debug.resume') }}</button>
        <button :disabled="running" @click="newSession">{{ t('agentV3Debug.newSession') }}</button>
        <button :disabled="running" @click="runSmoke">{{ t('agentV3Debug.smoke') }}</button>
      </div>

      <div class="steer-row">
        <input
          v-model="steerMessage"
          type="text"
          :placeholder="t('agentV3Debug.steerPlaceholder')"
          @keydown.enter="steer"
        />
        <button :disabled="!running || !steerMessage.trim()" @click="steer">
          {{ t('agentV3Debug.steer') }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.agent-v3-debug {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
  color: var(--color-text-primary);
}

.controls {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.field input,
.field select {
  padding: var(--space-2);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
}

.usage {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.usage-bar {
  flex: 1;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-bg-surface-hover);
  overflow: hidden;
}

.usage-fill {
  height: 100%;
  background: var(--color-accent-solid);
}

.approval {
  padding: var(--space-3);
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-md);
  background: var(--color-warning-bg);
}

.approval p {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-sm);
}

.approval pre {
  margin: 0 0 var(--space-2);
  max-height: 160px;
  overflow: auto;
  font-size: var(--font-size-xs);
}

.approval-actions {
  display: flex;
  gap: var(--space-2);
}

.log {
  flex: 1;
  min-height: 220px;
  max-height: 420px;
  overflow-y: auto;
  padding: var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  font-family: monospace;
  font-size: var(--font-size-xs);
}

.empty {
  margin: 0;
  color: var(--color-text-muted);
}

.line {
  white-space: pre-wrap;
  word-break: break-word;
  padding: var(--space-1) 0;
}

.line.text {
  color: var(--color-text-primary);
}

.line.meta {
  color: var(--color-text-muted);
}

.line.tool {
  color: var(--color-accent-text);
}

.line.error {
  color: var(--color-danger-text);
}

.line.info {
  color: var(--color-text-secondary);
}

.composer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.composer textarea,
.steer-row input {
  width: 100%;
  padding: var(--space-2);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
  font-family: inherit;
  resize: vertical;
}

.actions,
.steer-row {
  display: flex;
  gap: var(--space-2);
}

.steer-row input {
  flex: 1;
}

button {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  cursor: pointer;
}

button:disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

button.danger {
  border-color: var(--color-danger-border);
  color: var(--color-danger-text);
}
</style>
