/**
 * 导入工程时 UnrealAgentLink 没装上，要当场说出来，并且给一条走得通的下一步。
 *
 * ## 为什么值得单独一个文件
 *
 * 导入工程有三个入口（首页拖拽、文件对话框、工程列表），主进程那边装插件失败是
 * 同一个原因码。之前三处都只判 `success`，而 `success` 说的是「工程进库了」——
 * 插件装没装上从来没人看，失败只写在主进程的 console 里。
 *
 * 后果是用户之后遇到「AI 连不上引擎」，而那时他早就不记得这跟导入那一步有关。
 * 这条提示不是锦上添花，它是这个故障唯一的线索。
 *
 * ## 为什么从一闪而过的 toast 换成了对话框
 *
 * 2026-09-17 的事故：一个中文工程的 `.uproject` 被引擎存成了 UTF-16，盒子读不动，
 * 用户看到的是一句 `Unexpected token '<?>', "<?><?>{..."`。两个问题 ——
 * 一是这句话他一个字也看不懂，二是提示里让他「右键手动安装」，而右键走的是同一段
 * 代码，点了照样失败。**给一个必然失败的下一步，比不给更糟。**
 *
 * 现在的下一步是把这件事交给盒子自己的 AI：它有读文件、改文件、开工程的工具，
 * 这类问题它自己就能查（很多时候能当场修好）。用户不必看懂任何一个原因码。
 * 这是盒子和普通软件的差别 —— 别的软件只能让用户自己去翻论坛。
 *
 * 导入本身仍然算成功：插件是可选能力，为它把整次导入判失败不成比例。工程可以正常
 * 用，只是 AI 那部分要补一下。
 */
import i18n from '@renderer/i18n'
import router from '@renderer/router'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { confirmDialog } from '@renderer/utils/dialog'
import { message } from '@renderer/utils/messageManager'
import { appExecuteAgent } from '@renderer/views/Assistant/composables/appAgentRunner'
import { ensureSessionWithTitle } from '@renderer/views/Assistant/composables/chatSendPrimitives'

/** 主进程给的原因码里，有专门文案的那几种 */
const KNOWN_REASONS: Record<string, string> = {
  NO_ENGINE_ASSOCIATION: 'page.home.project.pluginFailure.noEngineAssociation',
  PLUGIN_FILES_MISSING: 'page.home.project.pluginFailure.filesMissing',
  UPROJECT_UNREADABLE: 'page.home.project.pluginFailure.uprojectUnreadable'
}

/** 导入接口返回的那一坨里，这里用得上的部分 */
export interface PluginFailureResult {
  pluginFailure?: string
  data?: {
    /** `.uproject` 的绝对路径 —— 交给 AI 时它要去读这个文件 */
    originPath?: string | null
    projectName?: string | null
  } | null
}

/**
 * @param result 导入接口的返回值
 * @returns 有没有提示过（调用方一般不关心，留着方便测试）
 */
export function notifyPluginInstallFailure(result?: PluginFailureResult | null): boolean {
  const reason = result?.pluginFailure
  if (!reason) return false

  const { t } = i18n.global
  askUserOrHandOff({
    content: t('page.home.project.pluginFailure.title', { reason: describeReason(reason) }),
    reason,
    uprojectPath: result?.data?.originPath || '',
    projectName: result?.data?.projectName || ''
  })
  return true
}

/** 原因码翻成人话；不认识的就把原文带上 —— 那多半是操作系统给的错误，是可搜的线索 */
function describeReason(reason: string): string {
  const { t } = i18n.global
  const key = KNOWN_REASONS[reason]
  return key ? t(key) : reason
}

/**
 * 开机后台升级插件失败了。
 *
 * 和导入那条分开，因为**没有对应的用户动作**可以挂：这件事发生在开机后的后台，
 * 用户什么都没点。不说的话他会一直停在旧版插件上，之后遇到「AI 连不上引擎」或者
 * 新功能用不了，完全对不上原因。
 *
 * 一条工程一句太吵（盒子一更新就是所有工程同时失败），所以按「N 个工程 + 第一条
 * 原因」汇总；交给 AI 也从第一条查起 —— 同一批失败几乎总是同一个原因。
 *
 * @returns 有没有提示过（调用方一般不关心，留着方便测试）
 */
export function notifyPluginUpgradeFailure(
  failures?: Array<{ project: string; reason: string; uprojectPath?: string }> | null
): boolean {
  if (!failures || failures.length === 0) return false

  const { t } = i18n.global
  const first = failures[0]
  askUserOrHandOff({
    content: t('page.home.project.pluginUpgradeFailure.title', {
      count: failures.length,
      project: first.project,
      reason: describeReason(first.reason)
    }),
    reason: first.reason,
    uprojectPath: first.uprojectPath || '',
    projectName: first.project
  })
  return true
}

interface HandOffContext {
  /** 给用户看的那句话 */
  content: string
  /** 原因码或异常原文，原样交给 AI —— 它比用户更认得出这是什么 */
  reason: string
  uprojectPath: string
  projectName: string
}

/**
 * 弹一次：要么用户自己知道了，要么把这件事交给 AI。
 *
 * 主按钮是「让 AI 看看」—— 它正是我们希望用户走的那条路：他不需要看懂原因码，
 * AI 看得懂。
 */
function askUserOrHandOff(context: HandOffContext): void {
  const { t } = i18n.global
  confirmDialog({
    title: t('page.home.project.pluginFailure.dialogTitle'),
    content: context.content,
    okText: t('page.home.project.pluginFailure.askAi'),
    cancelText: t('page.home.project.pluginFailure.dismiss'),
    onOk: () => handOffToAgent(context)
  })
}

/**
 * 把故障原样交给 AI 的一轮对话，并把用户带到那条会话上。
 *
 * 带上的三样东西缺一不可：工程文件的绝对路径（AI 要去读它）、原因码或异常原文
 * （不翻译，AI 认得），以及**查什么**。只丢一句「插件装不上」的话，模型会反过来
 * 问用户一串他答不上来的问题。
 *
 * ## 为什么不用 `?initialMessage=`
 *
 * 那个入口（Spotlight 在用）只在助手页 `onMounted` 里读一次。用户此刻正开着助手页
 * 的话，同路径换 query 不会重建组件，这条消息就**悄无声息地没了** ——
 * 而「点了按钮什么都没发生」正是这次要消灭的那类症状。
 *
 * 所以走和实时语音派活、蓝图库存片段同一条路：自己建一条会话，用应用级的
 * `appExecuteAgent` 发起（它不依赖助手页挂没挂着），再把用户带到 `?sid=` 上 ——
 * 那个 query 助手页是 watch 着的。用户中途切走也不影响 AI 把活干完。
 */
function handOffToAgent(context: HandOffContext): void {
  const { t } = i18n.global
  const prompt = t('page.home.project.pluginFailure.aiPrompt', {
    project: context.projectName || context.uprojectPath,
    path: context.uprojectPath || t('page.home.project.pluginFailure.pathUnknown'),
    reason: context.reason
  })

  const chatSid = `plugin-failure-${Date.now()}`
  try {
    ensureSessionWithTitle(chatSid, prompt, {
      chatStore: useChatSessionsStore(),
      tabsStore: useTabsStore(),
      route: router.currentRoute.value,
      unnamedTitle: t('assistant.chatFlow.unnamedSession')
    })
    void router.push({ path: '/dev-assistant', query: { sid: chatSid } })
    void appExecuteAgent(prompt, undefined, { chatSid })
  } catch (error) {
    message.error(
      t('page.home.project.pluginFailure.askAiFailed', {
        reason: error instanceof Error ? error.message : String(error)
      })
    )
  }
}
