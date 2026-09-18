/**
 * 把待审批队列翻译成界面认识的形状。
 *
 * 主窗口的确认框和 MiniChat 的精简版共用这一份：两边措辞不同是可以的，
 * 但「这一步到底要干什么」的判断不该有两套 —— 一边说得清、另一边说不清，
 * 用户在小窗口里就是在盲批。
 */

import { computed, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'

import { usePendingApprovalsStore } from '@renderer/store/modules/pendingApprovals'
import { changeLabelKey, isMcpChange } from '@renderer/views/Assistant/composables/changeSummary'

/**
 * 敏感操作类型。
 *
 * V3 按 risk 分级（safe / mutating / destructive），没有 V2 那套动作分类 ——
 * 除了上网单独成一类，其余一律归到 other，按通用文案展示工具名和参数。
 */
export type SensitiveActionType =
  /**
   * 在网页上点击 / 输入。
   *
   * 单独一类，因为它要确认的理由和别的**不一样**：别的是「这一步会破坏东西」，
   * 而这一步是**把数据发到外面去**、在带登录态的页面上按按钮 —— 每次的参数
   * 都不一样，参数本身就是风险。沿用「即将执行写入操作」那句通用文案是错的，
   * 用户看了会以为盒子要改什么。
   *
   * 打开网页不在此列：那是 safe，不弹框（见 builtin/browser.ts）。
   */
  'browser_action' | 'other'

/** 界面上那一条待确认操作 */
export interface DisplayApproval {
  toolCallId: string
  actionType: SensitiveActionType
  /**
   * 「操作类型」那一行显示什么。
   *
   * 原先两个确认框各写了一份 `getActionTypeName`，各自把 actionType 映成
   * 「访问网页 / 其他操作」—— 而非上网的全归 other，于是那一行**恒为「其他操作」**，
   * 一个字的信息量都没有，占着卡片上最显眼的位置。
   *
   * 改成按 risk 说话：不可撤销 / 会改动工程 / 访问网页。用户要判断的就是这个。
   * 放在这里而不是各视图里，是因为「这一步有多危险」不该有两套判断（见文件头）。
   */
  typeLabel: string
  description: string
  details?: Record<string, unknown>
  /**
   * 能不能「本次会话都允许」。
   *
   * 在网页上点击/输入这类工具是 false：批准一次不能代表批准下一次。
   * 主进程那边也拦着（见 `core/approval.ts`），界面只负责别把按钮摆出来。
   */
  allowAlways: boolean
}

export interface ApprovalDisplay {
  /** 当前该让用户看的那一条 */
  current: ComputedRef<DisplayApproval | null>
  /** 队列里一共几条：并行执行时可能同时有好几条在等 */
  queueLength: ComputedRef<number>
  /** 用户表态。出队和回传都在 store 里做 */
  reply: (verdict: AgentV3ApprovalVerdict) => void
}

export function useApprovalDisplay(): ApprovalDisplay {
  const { t } = useI18n()
  const approvals = usePendingApprovalsStore()

  /**
   * 上网这一步到底要做什么。
   *
   * 通用文案（「即将执行写入操作：browser_interact」）在这里是**错的**：
   * 用户读完只会更糊涂。他真正要判断的是「让它点这个按钮、往这个框里发这段话，
   * 行不行」—— 所以直接把元素名写在第一行。
   */
  function describeBrowserAction(toolName: string, args: unknown): string {
    const params = (args ?? {}) as Record<string, unknown>
    const label = typeof params.label === 'string' ? params.label : ''

    if (toolName === 'browser_interact') {
      const action = params.action === 'click' ? 'click' : 'input'
      return label
        ? t(`assistant.sensitiveAction.browser.${action}`, { label })
        : t('assistant.sensitiveAction.browser.interactUnknown')
    }
    return t('assistant.sensitiveAction.browser.generic', { tool: toolName })
  }

  /**
   * 工具名 → 用户认得的说法。
   *
   * 「即将执行不可撤销的操作：ue_content_delete」这句话里，用户唯一需要判断的那部分
   * （到底要删什么）恰好是他读不懂的那部分。而「本轮改动」那一栏早就把八十多个工具
   * 翻好了（`assistant.changes.tools.*`），审批卡没用上纯粹是漏了。
   *
   * 查不到就退回工具名 —— 和那张表一样的规矩：新工具忘了配文案时退化成今天的样子，
   * 而不是冒出个 `undefined`。
   */
  function describeTool(toolName: string, args: unknown): string {
    /*
     * MCP 来的先归一。`mcp_ue-official_call_tool` 这种名字表里查不到，退回原样显示
     * 就成了「即将执行写入操作：mcp_ue-official_call_tool」—— 恰恰是全仓最难读的
     * 一批名字，而这张卡片存在的意义就是让用户看懂自己在批什么。
     *
     * 「本轮改动」那一栏的 `AIBubble.changeLabel` 第一句就是这个判断，
     * 这里漏掉它等于两处对同一件事有两套说法。
     */
    if (isMcpChange({ toolName })) return t('assistant.changes.tools.mcpEngineToolset')

    /*
     * 插件管理的启停方向在参数里，一个工具拆成两句话说清「到底要启还是要停」。
     * 审批卡尤其需要：用户要判断的正是方向，而「启用/停用插件」这句含糊话
     * 等于没说。方向读不出来时退回那句含糊的（同 `AIBubble.changeLabel`）。
     */
    if (toolName === 'ue_manage_plugin') {
      const action = (args as { action?: unknown } | null)?.action
      if (action === 'Enable' || action === 'Disable') {
        return t(
          `assistant.changes.tools.ue_manage_plugin_${action === 'Disable' ? 'disable' : 'enable'}`
        )
      }
    }

    const key = changeLabelKey(toolName)
    const label = t(key)
    return label === key ? toolName : label
  }

  const current = computed<DisplayApproval | null>(() => {
    const request = approvals.current
    if (!request) return null

    const browser = request.namespace === 'browser'
    const action = browser ? '' : describeTool(request.toolName, request.args)
    return {
      toolCallId: request.toolCallId,
      actionType: browser ? 'browser_action' : 'other',
      typeLabel: browser
        ? t('assistant.sensitiveAction.types.browserAction')
        : request.risk === 'destructive'
          ? t('assistant.sensitiveAction.types.destructive')
          : t('assistant.sensitiveAction.types.mutating'),
      description: browser
        ? describeBrowserAction(request.toolName, request.args)
        : request.risk === 'destructive'
          ? t('assistant.sensitiveAction.destructive', { action })
          : t('assistant.sensitiveAction.mutating', { action }),
      // 参数原样显示，绝不脱敏：用户批准的是「把这段文字发给这个网站」，
      // 看不到文字就是在盲批（见设计文档 §5.3）
      details: (request.args as Record<string, unknown>) ?? undefined,
      allowAlways: request.allowAlways
    }
  })

  const queueLength = computed(() => approvals.queue.length)

  function reply(verdict: AgentV3ApprovalVerdict): void {
    const action = current.value
    if (!action) return
    approvals.reply(action.toolCallId, verdict)
  }

  return { current, queueLength, reply }
}
