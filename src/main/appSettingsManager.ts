import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { logger } from './services'
import { START_HIDDEN_ARG } from './startupVisibility'
import { projectComparisonKey } from './utils/projectPath'
import { setMainLanguage } from './i18n'

/**
 * Agent 浏览器窗口的显示方式。
 *
 * - `window`：独立窗口。看得最清楚，也最容易被用户接管，但它会抢焦点、
 *   盖在虚幻上面 —— 用户正在编辑器里干活时，这是一次打断。
 * - `embedded`：嵌在助手页面右侧分屏，聊天和网页同屏看。**这是默认档**：
 *   一样看得见（安全前提不变），但不抢窗口。
 * - `hidden`：不显示。**这一档会削弱这套能力的核心安全性质** ——
 *   「用户能看到 agent 在操作什么」不再成立，只剩审批弹窗和台账。
 *   给的是明确知道自己在做什么的用户，不做默认。
 */
export type AgentBrowserMode = 'window' | 'embedded' | 'hidden'

/**
 * agent 能读写这台电脑上的哪些位置。
 *
 * - `ue-only`：只剩虚幻相关的位置 —— 装好的引擎、导入盒子的工程、素材库。
 *   想把 agent 圈在虚幻这一摊里的用户自己去设置里选它。
 * - `full`：除凭据、密钥、浏览器数据（见 `pathBoundary.ts`）之外，哪儿都能碰。
 *   **这是默认档。** 真实用法里「把 D:/素材 整理一下 / 导进来」「看一眼这份
 *   导出的 FBX」是常态而不是例外，默认收窄的结果是绝大多数人第一次用就撞墙，
 *   而挡下来的那件事本身完全正当。收窄这一层挡的从来不是恶意（shell 不受它
 *   限制，见 `accessScope.ts`），真正兜底的是黑名单加每步审批。
 *
 * 这一档存在应用设置里而不是 aiConfig store：判定发生在主进程的工具里，
 * 渲染层那个 store 主进程读不到。
 */
export type AgentFileAccessScope = 'ue-only' | 'full'

/**
 * 一轮跑完了要不要弹系统通知。
 *
 * - `unfocused`：**默认**。只有盒子不在前台时才提醒。用户正盯着屏幕看它干活，
 *   右下角再弹一条「完成了」是纯噪音。
 * - `always`：始终提醒。多显示器 / 盒子开在副屏时有用 —— 窗口「在前台」，
 *   但用户的眼睛不在那块屏上。
 * - `off`：不提醒。
 */
export type TurnCompleteNotification = 'off' | 'unfocused' | 'always'

/**
 * 应用设置接口
 */
interface AppSettings {
  /** 开机自启 */
  autoLaunch: boolean
  /** 启用智能追加提问建议 */
  enableFollowUpSuggestions: boolean
  /** 应用语言设置 */
  language: 'zh-CN' | 'en-US'
  /** 启动项目时自动启用 UnrealAgentLink 插件 */
  autoEnableUnrealAgentLink: boolean
  /**
   * 明确拒绝安装 UnrealAgentLink 的项目（规范化后的 .uproject 路径）。
   *
   * 用户在项目上点过「移除 UnrealAgentLink」就进这个名单。没有它的话，
   * 用户手动删掉插件、下次从盒子打开项目又会被装回去 —— 在用户眼里就是
   * 「这东西删不掉」。
   */
  ualinkOptOutProjects: string[]
  /** Agent 浏览器怎么显示。见 `AgentBrowserMode` */
  agentBrowserMode: AgentBrowserMode
  /** agent 能读写哪些位置。见 `AgentFileAccessScope` */
  agentFileAccessScope: AgentFileAccessScope
  /** 实验性工具搜索。默认关闭，每次启动 Agent 时读取。 */
  agentToolSearchEnabled: boolean
  /**
   * 全量模式下用户关掉的工具名。默认一个都没关。
   *
   * 记「关掉的」而不是「开着的」：以后每加一个工具，老用户的配置里没有它，
   * 于是它默认开着 —— 反过来存白名单的话，新工具对所有老用户都是静默消失的。
   */
  agentDisabledTools: string[]
  /**
   * 工具搜索模式下，偏离内置常驻清单的那些工具。`true` = 强行常驻，`false` = 改成搜索加载。
   *
   * 同样只存**差量**：内置常驻清单会随实验结论调整（见 `toolSearch.ts` 的
   * `RESIDENT_TOOL_NAMES`），存全量的话，用户点过一次开关就永远停在那一版清单上。
   */
  agentResidentTools: Record<string, boolean>
  /** 一轮跑完要不要弹系统通知。见 `TurnCompleteNotification` */
  notifyTurnComplete: TurnCompleteNotification
  /** agent 卡在审批上时，窗口不在前台就弹一条通知 */
  notifyApprovalRequired: boolean
  /** agent 反问用户时，窗口不在前台就弹一条通知 */
  notifyQuestionRequired: boolean
  /**
   * 从盒子里打开工程之后，把主界面收进托盘。
   *
   * 默认关着。收进托盘之后窗口在任务栏里也不见了，不知道有托盘图标的人
   * 会以为盒子自己退出了 —— 这个代价只该由主动去开它的人承担。
   */
  hideWindowOnProjectLaunch: boolean
}

/**
 * 默认设置值
 */
const DEFAULT_SETTINGS: AppSettings = {
  autoLaunch: true,
  enableFollowUpSuggestions: false,
  language: 'zh-CN',
  autoEnableUnrealAgentLink: true,
  ualinkOptOutProjects: [],
  // 默认嵌入助手：安全前提「用户看得见 agent 在操作什么」照样成立，
  // 但不会弹一个独立窗口盖在虚幻上面打断用户。默认值不该是把它藏起来的那一档
  agentBrowserMode: 'embedded',
  // 默认整台电脑。收窄档挡下的第一件事往往是「把 D:/素材 导进来」这种完全正当的
  // 需求，而这一层本来就挡不住 shell（见 accessScope.ts），兜底靠的是凭据黑名单
  // 加每步审批 —— 拿它当默认，换来的只是所有人第一次用都撞一次墙
  agentFileAccessScope: 'full',
  agentToolSearchEnabled: false,
  // 默认全部打开。设置页里那一长串开关，起手状态就该等于「什么都没设置过」
  agentDisabledTools: [],
  agentResidentTools: {},
  // 默认开着，但只在窗口不在前台时响。盒子干的是长活，用户派完就切回虚幻里
  // 接着做自己的事 —— 而审批**超时五分钟按拒绝算**，不提醒的话他回来只看到
  // 一句「这一步被拒绝了」，从头到尾没人问过他
  notifyTurnComplete: 'unfocused',
  notifyApprovalRequired: true,
  notifyQuestionRequired: true,
  // 默认不藏。用户开着盒子的窗口是他自己的决定，一次「打开工程」不该顺手收走它
  hideWindowOnProjectLaunch: false
}

/** 只保留字符串项；不是数组就当空名单 */
function sanitizeToolNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string')
    : []
}

/** 只保留 `工具名 → 布尔` 这种项，其余丢掉 */
function sanitizeResidentTools(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, boolean> = {}
  for (const [name, resident] of Object.entries(value as Record<string, unknown>)) {
    if (typeof resident === 'boolean') result[name] = resident
  }
  return result
}

/**
 * 应用设置管理器
 * 负责持久化存储用户的应用设置
 */
class AppSettingsManager {
  private configPath: string
  private settings: AppSettings

  constructor() {
    this.configPath = join(app.getPath('userData'), 'app-settings.json')
    this.settings = this.loadSettings()
    // 主进程那几句（托盘菜单、原生对话框标题）跟着这份设置走。
    // 方向是这边推过去的：`i18n.ts` 一个 import 都不能有，理由见那个文件的头。
    setMainLanguage(this.settings.language)
  }

  /**
   * 加载设置
   */
  private loadSettings(): AppSettings {
    try {
      if (existsSync(this.configPath)) {
        const data = readFileSync(this.configPath, 'utf8')
        const savedSettings = JSON.parse(data) as Partial<AppSettings>

        // 只保留当前仍支持的设置项，旧版本遗留字段不会继续透传或写回。
        const mergedSettings = { ...DEFAULT_SETTINGS, ...savedSettings }
        return {
          autoLaunch: mergedSettings.autoLaunch,
          enableFollowUpSuggestions: mergedSettings.enableFollowUpSuggestions,
          language: mergedSettings.language,
          autoEnableUnrealAgentLink: mergedSettings.autoEnableUnrealAgentLink,
          ualinkOptOutProjects: mergedSettings.ualinkOptOutProjects,
          agentBrowserMode: mergedSettings.agentBrowserMode,
          agentFileAccessScope: mergedSettings.agentFileAccessScope,
          agentToolSearchEnabled: mergedSettings.agentToolSearchEnabled === true,
          // 配置文件被手改坏（写成对象、混进数字）时退回「什么都没关」。
          // 这两份名单只会让模型少拿到工具，读坏了宁可全给，不能让人对着一个
          // 空空如也的助手查半天
          agentDisabledTools: sanitizeToolNames(mergedSettings.agentDisabledTools),
          agentResidentTools: sanitizeResidentTools(mergedSettings.agentResidentTools),
          notifyTurnComplete: mergedSettings.notifyTurnComplete,
          notifyApprovalRequired: mergedSettings.notifyApprovalRequired,
          notifyQuestionRequired: mergedSettings.notifyQuestionRequired,
          hideWindowOnProjectLaunch: mergedSettings.hideWindowOnProjectLaunch
        }
      }
    } catch (error) {
      logger.warn('加载应用设置失败:', error)
    }

    return { ...DEFAULT_SETTINGS }
  }

  /**
   * 保存设置
   */
  saveSettings(settings: Partial<AppSettings>): void {
    try {
      this.settings = { ...this.settings, ...settings }
      writeFileSync(this.configPath, JSON.stringify(this.settings, null, 2))
      logger.info('应用设置已保存:', this.settings)
    } catch (error) {
      logger.error('保存应用设置失败:', error)
    }
  }

  /**
   * 获取当前设置
   */
  getSettings(): AppSettings {
    return { ...this.settings }
  }

  /** 先落盘再更新内存，保存失败时让设置页显示错误并保留原值。 */
  setAgentToolSearchEnabled(enabled: boolean): void {
    const next = { ...this.settings, agentToolSearchEnabled: enabled }
    writeFileSync(this.configPath, JSON.stringify(next, null, 2))
    this.settings = next
  }

  /**
   * 全量模式下关掉的那些工具。同样先落盘 —— 用户看到开关弹回去，
   * 好过看到它停在新位置而下一轮那个工具照常出现。
   */
  setAgentDisabledTools(names: string[]): void {
    const next = { ...this.settings, agentDisabledTools: sanitizeToolNames(names) }
    writeFileSync(this.configPath, JSON.stringify(next, null, 2))
    this.settings = next
  }

  /** 工具搜索模式下偏离内置常驻清单的那些 */
  setAgentResidentTools(overrides: Record<string, boolean>): void {
    const next = { ...this.settings, agentResidentTools: sanitizeResidentTools(overrides) }
    writeFileSync(this.configPath, JSON.stringify(next, null, 2))
    this.settings = next
  }

  /**
   * 设置开机自启
   * 使用 Electron 的 setLoginItemSettings API
   */
  private applyAutoLaunchSetting(enabled: boolean, persist: boolean): boolean {
    try {
      // Windows 下使用 args 参数添加 --hidden 标志
      // 因为 Electron 的 wasOpenedAtLogin 只在 macOS 下可靠
      // 注意：在 Windows 上，需要同时指定 path 和 args 才能正确设置带参数的启动命令
      const args = enabled ? [START_HIDDEN_ARG] : []

      if (process.platform === 'win32') {
        // Windows: 需要显式指定 path 才能让 args 生效
        app.setLoginItemSettings({
          openAtLogin: enabled,
          path: process.execPath,
          args
        })
      } else {
        // macOS/Linux
        app.setLoginItemSettings({
          openAtLogin: enabled,
          args
        })
      }

      if (persist) {
        this.saveSettings({ autoLaunch: enabled })
      }
      logger.info(
        `开机自启已${enabled ? '启用' : '禁用'}，启动参数: ${args.join(' ')}, 路径: ${process.execPath}`
      )
      return true
    } catch (error) {
      logger.error('设置开机自启失败:', error)
      return false
    }
  }

  setAutoLaunch(enabled: boolean): boolean {
    return this.applyAutoLaunchSetting(enabled, true)
  }

  ensureAutoLaunchSetting(): boolean {
    if (!this.settings.autoLaunch) {
      return true
    }

    return this.applyAutoLaunchSetting(true, false)
  }

  /**
   * 获取开机自启状态
   * 从系统获取实际状态
   */
  getAutoLaunchStatus(): boolean {
    try {
      const loginItemSettings = app.getLoginItemSettings()
      return loginItemSettings.openAtLogin
    } catch (error) {
      logger.error('获取开机自启状态失败:', error)
      return this.settings.autoLaunch
    }
  }

  /**
   * 设置启用智能追加提问建议
   */
  setEnableFollowUpSuggestions(enabled: boolean): void {
    this.saveSettings({ enableFollowUpSuggestions: enabled })
    logger.info(`智能追加提问建议已${enabled ? '启用' : '禁用'}`)
  }

  /**
   * 获取启用智能追加提问建议设置
   */
  getEnableFollowUpSuggestions(): boolean {
    return this.settings.enableFollowUpSuggestions
  }

  /**
   * 设置 Agent 浏览器的显示方式。
   *
   * 改了要通知服务把当前窗口收掉 —— 否则用户切到「嵌入」之后，
   * 眼前还杵着一个独立窗口，而设置页显示的是另一回事。
   */
  setAgentBrowserMode(mode: AgentBrowserMode): void {
    this.saveSettings({ agentBrowserMode: mode })
    logger.info(`Agent 浏览器显示方式已设置为: ${mode}`)
  }

  /** 获取 Agent 浏览器的显示方式 */
  getAgentBrowserMode(): AgentBrowserMode {
    return this.settings.agentBrowserMode ?? 'embedded'
  }

  /** 设置 agent 的文件访问范围 */
  setAgentFileAccessScope(scope: AgentFileAccessScope): void {
    this.saveSettings({ agentFileAccessScope: scope })
    logger.info(`Agent 文件访问范围已设置为: ${scope}`)
  }

  /**
   * 获取 agent 的文件访问范围。
   *
   * 只认 `ue-only` 这一个字面量，其余一律当默认档（`full`）。收窄是用户
   * **主动选出来**的一档，所以只有明确写着 `ue-only` 才收 —— 字段缺失、
   * 配置文件损坏、写进去一个不认识的值，都当没选过。
   *
   * 注意这和界面的兜底必须一字不差地一致（见 `ProfileAI.vue`），否则会出现
   * 最糟的错位：界面高亮着一档，实际生效的是另一档。
   */
  getAgentFileAccessScope(): AgentFileAccessScope {
    return this.settings.agentFileAccessScope === 'ue-only' ? 'ue-only' : 'full'
  }

  /** 设置「一轮跑完弹不弹通知」 */
  setNotifyTurnComplete(mode: TurnCompleteNotification): void {
    this.saveSettings({ notifyTurnComplete: mode })
    logger.info(`轮次完成通知已设置为: ${mode}`)
  }

  /**
   * 读「一轮跑完弹不弹通知」。
   *
   * 只认三个字面量，其余（配置文件损坏、旧版本没这个字段）一律回默认档。
   * 这里兜底成 `unfocused` 而不是 `off`：读不出来时宁可多响一声，
   * 也好过用户以为自己开着、结果一条通知都没等到。
   */
  getNotifyTurnComplete(): TurnCompleteNotification {
    const value = this.settings.notifyTurnComplete
    return value === 'off' || value === 'always' ? value : 'unfocused'
  }

  /** 设置「需要审批时提醒」 */
  setNotifyApprovalRequired(enabled: boolean): void {
    this.saveSettings({ notifyApprovalRequired: enabled })
    logger.info(`权限通知已${enabled ? '启用' : '禁用'}`)
  }

  /** 读「需要审批时提醒」。缺值按开着算，理由同 `getNotifyTurnComplete` */
  getNotifyApprovalRequired(): boolean {
    return this.settings.notifyApprovalRequired !== false
  }

  /** 设置「需要回答时提醒」 */
  setNotifyQuestionRequired(enabled: boolean): void {
    this.saveSettings({ notifyQuestionRequired: enabled })
    logger.info(`问题通知已${enabled ? '启用' : '禁用'}`)
  }

  /** 读「需要回答时提醒」。缺值按开着算 */
  getNotifyQuestionRequired(): boolean {
    return this.settings.notifyQuestionRequired !== false
  }

  /** 设置「打开工程后隐藏主界面」 */
  setHideWindowOnProjectLaunch(enabled: boolean): void {
    this.saveSettings({ hideWindowOnProjectLaunch: enabled })
    logger.info(`打开工程后隐藏主界面已${enabled ? '启用' : '禁用'}`)
  }

  /**
   * 读「打开工程后隐藏主界面」。
   *
   * 只认 `true`。缺值（旧配置文件、文件损坏）一律按关着算 —— 界面还在，
   * 用户至多多点一下最小化；反过来兜底成开，他会突然找不到盒子的窗口。
   */
  getHideWindowOnProjectLaunch(): boolean {
    return this.settings.hideWindowOnProjectLaunch === true
  }

  /**
   * 设置应用语言
   */
  setLanguage(language: 'zh-CN' | 'en-US'): void {
    this.saveSettings({ language })
    // 托盘菜单要当场重建，而不是等下次启动才变成新语言
    setMainLanguage(language)
    logger.info(`应用语言已设置为: ${language}`)
  }

  /**
   * 获取应用语言设置
   */
  getLanguage(): 'zh-CN' | 'en-US' {
    return this.settings.language
  }

  /**
   * 设置启动项目时自动启用 UnrealAgentLink 插件
   */
  setAutoEnableUnrealAgentLink(enabled: boolean): void {
    this.saveSettings({ autoEnableUnrealAgentLink: enabled })
    logger.info(`启动项目自动启用 UnrealAgentLink 插件已${enabled ? '启用' : '禁用'}`)
  }

  /**
   * 获取启动项目时自动启用 UnrealAgentLink 插件设置
   */
  getAutoEnableUnrealAgentLink(): boolean {
    return this.settings.autoEnableUnrealAgentLink
  }

  /**
   * 这个项目是否明确拒绝过 UnrealAgentLink
   */
  isUALinkOptedOut(uprojectPath: string): boolean {
    if (!uprojectPath) return false
    const target = projectComparisonKey(uprojectPath)
    return (this.settings.ualinkOptOutProjects || []).some(
      (item) => projectComparisonKey(item) === target
    )
  }

  /**
   * 记住/撤销「这个项目不要装 UnrealAgentLink」
   *
   * @param uprojectPath .uproject 绝对路径
   * @param optOut true = 不再自动安装；false = 恢复自动安装
   */
  setUALinkOptOut(uprojectPath: string, optOut: boolean): void {
    if (!uprojectPath) return
    const target = projectComparisonKey(uprojectPath)
    const current = this.settings.ualinkOptOutProjects || []
    const without = current.filter((item) => projectComparisonKey(item) !== target)

    // 已经是想要的状态就不写盘，省得每次打开项目都刷一遍配置文件
    if (optOut && without.length === current.length) {
      this.saveSettings({ ualinkOptOutProjects: [...without, uprojectPath] })
    } else if (!optOut && without.length !== current.length) {
      this.saveSettings({ ualinkOptOutProjects: without })
    }

    logger.info(`UnrealAgentLink ${optOut ? '已加入' : '已移出'}项目黑名单: ${uprojectPath}`)
  }
}

export const appSettingsManager = new AppSettingsManager()
