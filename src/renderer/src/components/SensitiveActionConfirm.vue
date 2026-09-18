<template>
  <!--
    内容一定要 Teleport 出去，不能就地渲染。
    组件挂在 `MainLayout` 上，而 `.main-layout` 是 `display: flex` ——
    一个没定位的 `div` 待在那儿就成了最后一个 flex 子项，横向硬占掉自己的
    `max-width`，把侧边栏和整个内容区挤到窗口左边一条。

    停靠位在（助手页）就顶在输入框上方，跟以前一样；不在就退回窗口底部的
    浮层。两种形态的差别只有定位，见 `useApprovalDock.ts`。
  -->
  <Teleport :to="dockTarget">
    <div v-if="pendingAction" class="sensitive-action-confirm" :class="{ floating: !dock }">
      <div class="confirm-header">
        <div class="header-left">
          <PhWarning class="warning-icon" />
          <span class="header-title">{{ t('assistant.sensitiveAction.title') }}</span>
        </div>
        <div v-if="queueLength > 1" class="queue-badge">
          {{ t('assistant.sensitiveAction.queued', { count: queueLength - 1 }) }}
        </div>
      </div>
      <div class="confirm-body">
        <div class="action-type">
          <span class="label">{{ t('assistant.sensitiveAction.actionType') }}:</span>
          <span class="value">{{ pendingAction.typeLabel }}</span>
        </div>
        <div class="action-description">
          {{ pendingAction.description }}
          <span v-if="aiExplanation" class="ai-explanation">{{ aiExplanation }}</span>
          <span v-if="isExplaining" class="explaining-indicator">
            <PhCircleNotch class="icon-spin" />
          </span>
        </div>
        <div v-if="pendingAction.details" class="action-details">
          <code>{{ formatDetails(pendingAction.details) }}</code>
        </div>
      </div>
      <div class="confirm-footer">
        <div class="footer-left">
          <AppButton
            variant="text"
            class="btn-explain"
            :loading="isExplaining"
            :disabled="isExplaining"
            @click="handleExplain"
          >
            <template #icon><PhQuestion /></template>
            {{ t('assistant.sensitiveAction.whatIsThis') }}
          </AppButton>
        </div>
        <div class="footer-right">
          <AppButton variant="default" class="btn-reject" @click="handleReject">
            <template #icon><PhX /></template>
            {{ t('assistant.sensitiveAction.reject') }}
          </AppButton>
          <AppButton
            v-if="pendingAction.allowAlways !== false"
            variant="default"
            class="btn-allow-session"
            @click="handleAllowForSession"
          >
            <template #icon><PhShieldCheck /></template>
            {{ t('assistant.sensitiveAction.allowForSession') }}
          </AppButton>
          <AppButton variant="primary" class="btn-confirm" @click="handleConfirm">
            <template #icon><PhCheck /></template>
            {{ t('assistant.sensitiveAction.confirm') }}
          </AppButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
/**
 * 敏感操作确认组件
 * 当 Agent 执行敏感操作（如删除资产、运行控制台命令等）时，
 * 从输入框上方顶起一个确认卡片，用户可以选择执行或拒绝
 *
 * **它只是视图**：待审批本身存在 `pendingApprovals` store 里，监听器挂在全局
 * 事件分发器上。原因见那个 store 的注释 —— 助手页没有 keep-alive，状态和监听
 * 一旦跟着组件走，切个标签页这次审批就只能等超时了。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  PhCheck,
  PhCircleNotch,
  PhQuestion,
  PhShieldCheck,
  PhWarning,
  PhX
} from '@phosphor-icons/vue'
import { useI18n } from 'vue-i18n'
import { aiAPI, ChatAbortedError } from '@renderer/api/ai'
import { clampOutputTokens } from '@core/shared/tokenBudget'
import { getModelLimits } from '@renderer/services/notebook/contextBudget'
import { useApprovalDisplay } from '@renderer/components/useApprovalDisplay'
import { useApprovalDock } from '@renderer/components/useApprovalDock'

const { t, locale } = useI18n()

const { current: pendingAction, queueLength, reply } = useApprovalDisplay()

/**
 * 停靠位。助手页会登记它输入框上方那块地方；没有登记就退回 `body`，
 * 走浮层形态（库页面点「放进当前工程」这类，用户此刻不在对话里）。
 */
const dock = useApprovalDock()
const dockTarget = computed<HTMLElement | string>(() => dock.value ?? 'body')

/** AI 解释内容 */
const aiExplanation = ref('')
/** 是否正在请求 AI 解释 */
const isExplaining = ref(false)
/** 正在跑的那次解释。换卡片或组件销毁时用它掐断 */
let explainAbort: AbortController | null = null

function cancelExplain(): void {
  explainAbort?.abort()
  explainAbort = null
}

/**
 * 换到下一条待审批时，重置 AI 解释状态 —— 上一条的解释配不上这一条。
 *
 * 光清空 ref 不够：上一条的请求还在流，它的 `onDelta` 会接着往
 * `aiExplanation` 里写 —— 用户看到的是「新卡片上挂着上一条的解释」。
 * 所以真的把它掐断，顺带也不再为一条没人看的解释烧 token。
 */
watch(
  () => pendingAction.value?.toolCallId,
  () => {
    cancelExplain()
    aiExplanation.value = ''
    isExplaining.value = false
  }
)

onBeforeUnmount(cancelExplain)

/**
 * 格式化操作详情
 */
function formatDetails(details: Record<string, unknown>): string {
  try {
    // 将 JSON 中的转义换行符 \n 替换为实际换行符，以便在界面上正确显示多行文本
    return JSON.stringify(details, null, 2).replace(/\\n/g, '\n')
  } catch {
    return String(details)
  }
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

/**
 * 一句解释而已，别让它写长文。真实模型的单次输出上限都远高于这个数，
 * 钳制只为兜住绑了小模型（本机 Ollama 之类）的情况。
 */
const EXPLAIN_MAX_TOKENS = 256

/**
 * 处理"这是什么？"按钮点击
 * 调用 AI API 流式请求解释当前敏感操作的含义和作用
 */
async function handleExplain(): Promise<void> {
  if (!pendingAction.value || isExplaining.value) {
    return
  }

  isExplaining.value = true
  aiExplanation.value = ''

  // 构建请求上下文
  const action = pendingAction.value
  const actionTypeName = action.typeLabel
  const detailsStr = action.details ? JSON.stringify(action.details, null, 2) : ''
  const isZh = locale.value === 'zh-CN'

  // 构建系统提示词
  const systemPrompt = isZh
    ? `你是一个 Unreal Engine 技术专家。用户正在 AI Agent 操作过程中遇到一个敏感操作确认请求。请用简洁易懂的语言（50-100字）解释这个操作的含义、作用和可能的影响。帮助用户理解这个操作是否安全，以及为什么 AI 想要执行它。`
    : `You are an Unreal Engine technical expert. The user encountered a sensitive operation confirmation during AI Agent execution. Please explain this operation's meaning, purpose, and potential effects in simple terms (50-100 words). Help the user understand if this operation is safe and why the AI wants to execute it.`

  // 构建用户提示词
  const userPrompt = isZh
    ? `AI Agent 想要执行以下敏感操作：

操作类型：${actionTypeName}
操作描述：${action.description}
${detailsStr ? `操作详情：\n${detailsStr}` : ''}

请解释这个操作的含义和作用。`
    : `AI Agent wants to execute the following sensitive operation:

Operation Type: ${actionTypeName}
Description: ${action.description}
${detailsStr ? `Details:\n${detailsStr}` : ''}

Please explain what this operation means and does.`

  cancelExplain()
  const abort = new AbortController()
  explainAbort = abort

  try {
    /*
     * **不绑任何厂商。** 这里原来写着 `provider: 'qwen', model: 'qwen-turbo'` ——
     * 那两个参数其实早就被 `aiAPI` 丢掉了（它只转发 role），但留着会让人以为
     * 这条路绑死在某一家。社区版走用户在设置里配的「轻量任务」模型，
     * 和知识库那条清洗/摘要线一样（见 services/notebookContent/SourceSummarizer.ts）。
     *
     * `level: 'fast'` 映射到的正是 summary 角色，所以上限也按它查。
     */
    const limits = await getModelLimits('summary')

    await aiAPI.chatText({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      // 解释一句话的事，用轻量档就够，别占用户的贵模型
      level: 'fast',
      callType: 'sensitive-action-explain',
      maxTokens: clampOutputTokens(EXPLAIN_MAX_TOKENS, limits),
      signal: abort.signal,
      // 边出边显示：审批框是拦着用户的，对着一个不动的转圈等几秒很难受
      onDelta: (_delta, text) => {
        aiExplanation.value = text
      }
    })
  } catch (error) {
    // 用户自己切走了（watch 里掐的），不是出错，不该在新卡片上留一句红字
    if (error instanceof ChatAbortedError) return

    console.error('[SensitiveActionConfirm] AI 解释请求失败:', error)
    aiExplanation.value = isZh
      ? '（无法获取 AI 解释，请稍后重试）'
      : '(Failed to get AI explanation, please try again later)'
  } finally {
    // 掐断之后 explainAbort 已经指向别人（或已清空），别把后来者的状态改掉
    if (explainAbort === abort) {
      explainAbort = null
      isExplaining.value = false
    }
  }
}
</script>

<style scoped lang="less">
.sensitive-action-confirm {
  background: var(--color-warning-bg);
  border: 1px solid var(--color-warning-border);
  border-radius: 8px;
  padding: 12px 16px;
  margin: 8px 0;
  width: 100%;
  max-width: 900px;
  box-sizing: border-box;
  animation: slideIn 0.2s ease-out;
}

/*
 * 没有停靠位时的形态（用户不在对话页，操作是从库页面之类发起的）。
 *
 * 必须是 `fixed`：它此刻的父节点是 `body`，不定位就成了页面末尾一块
 * 谁都看不见的东西。贴着窗口底部而不是正中，是为了跟「从输入框上面顶起来」
 * 保持同一个方向感 —— 同一个框，只是这次身下没有输入框。
 */
.sensitive-action-confirm.floating {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  /* 窄窗口下留出两边的边距，别顶到窗沿 */
  width: min(900px, calc(100vw - 48px));
  margin: 0;
  /* 压过导入进度挂件（1000）和资产锁提示（1100）：那两个是通知，这个拦着流程 */
  z-index: 1200;
  box-shadow: 0 8px 24px var(--shadow-color);
  animation: slideUp 0.2s ease-out;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 浮层那一版自带 translateX(-50%)，位移得连着写，否则动画会把它甩回左边 */
@keyframes slideUp {
  from {
    opacity: 0;
    transform: translate(-50%, 12px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

.confirm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }
}

.warning-icon {
  color: var(--color-warning-text);
  font-size: 18px;
  flex-shrink: 0;
}

.header-title {
  font-weight: 600;
  color: var(--color-warning-text);
  font-size: 14px;
}

.queue-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--color-warning-bg);
  padding: 2px 8px;
  border-radius: 12px;
  color: var(--color-warning-text);
  font-size: 12px;
  white-space: nowrap;
}

.confirm-body {
  margin-bottom: 12px;
}

.action-type {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 13px;

  .label {
    color: var(--color-text-secondary);
  }

  .value {
    color: var(--color-text-primary);
    font-weight: 500;
  }
}

.action-description {
  color: var(--color-text-primary);
  font-size: 13px;
  line-height: 1.5;
  margin-bottom: 8px;

  .ai-explanation {
    display: block;
    margin-top: 8px;
    padding: 8px 12px;
    background: var(--color-accent-bg);
    border-left: 3px solid var(--color-accent-border);
    border-radius: 0 6px 6px 0;
    color: var(--color-text-primary);
    font-size: 13px;
    line-height: 1.6;
    animation: fadeIn 0.2s ease-out;
  }

  .explaining-indicator {
    display: inline-block;
    margin-left: 8px;
    color: var(--color-accent-text);
    font-size: 14px;
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.action-details {
  background: var(--color-bg-surface-hover);
  border-radius: 4px;
  padding: 8px 10px;
  /*
   * `max-height` 而不是 `height`：写死 300px 的话，一条两行的命令也要顶着
   * 一个 300px 的空盒子，而一段长脚本又照样被截掉 —— 两头都不对。
   */
  max-height: 300px;
  overflow: auto;

  code {
    font-family: 'Consolas', 'Monaco', monospace;
    font-size: 12px;
    color: var(--color-text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
  }
}

.confirm-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;

  .footer-left {
    display: flex;
    align-items: center;
  }

  .footer-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
}

.btn-explain {
  color: var(--color-text-secondary);
  font-size: 13px;
  padding: 4px 8px;
  height: auto;

  &:hover {
    color: var(--color-accent-text);
    background: var(--color-accent-bg);
  }

  &:disabled {
    color: var(--color-text-muted);
    cursor: not-allowed;
  }
}

.btn-reject {
  background: var(--color-bg-surface-hover);
  border-color: var(--color-border);
  color: var(--color-text-primary);

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border);
    color: var(--color-text-primary);
  }
}

.btn-allow-session {
  background: var(--color-success-bg);
  border-color: var(--color-success-border);
  color: var(--color-success-text);

  &:hover {
    background: var(--color-success-bg);
    border-color: var(--color-success-border);
    color: var(--color-success-text);
  }
}

.btn-confirm {
  background: var(--color-warning-solid);
  border: none;
  color: var(--color-warning-on-solid);
  font-weight: 500;

  &:hover {
    background: var(--color-warning-solid-hover);
    color: var(--color-warning-on-solid);
  }
}
</style>
