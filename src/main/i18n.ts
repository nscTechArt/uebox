/**
 * 主进程自己的文案表。
 *
 * ## 为什么主进程需要一份
 *
 * 绝大多数文案都该走「主进程回错误码、渲染层查语言包」那条路（`ai/probe.ts` →
 * `AIProviders/probeCopy.ts` 是第一处落地）。但有两类东西**没有渲染层可以转交**：
 *
 * **一、操作系统画的控件**，渲染进程碰不到：
 *   - 托盘菜单与悬停提示（`Menu.buildFromTemplate` / `tray.setToolTip`）
 *   - 原生文件对话框（`dialog.showOpenDialog` / `showSaveDialog` 的标题兜底）
 *   - 启动失败的错误框（`dialog.showErrorBox` —— 那时窗口还没有）
 *
 * **二、要落盘的文案**，在写下去那一刻定稿：
 *   - 首次启动建的系统保管库名字与说明
 *
 * 第二类不是「没法交给渲染层」，而是**交过去也没用**：它写进数据库之后就不再
 * 更新，翻不翻都只会是首次启动时的那一种语言。放在这边至少能让首次启动的语言
 * 决定它，而不是永远中文。
 *
 * 表很小是有意的：能交给渲染层的就别写进来。
 *
 * ## 语言是**推**进来的，这个文件一个 import 都没有
 *
 * 语言的真源在 `appSettingsManager`，但这里不去读它 —— 反过来由它调
 * `setMainLanguage()` 推过来（启动时读完设置一次，用户改语言时再一次）。
 *
 * 方向反过来是被测试逼的，而那个报错指向一个真问题：`appSettingsManager`
 * 一路牵出 `services/config.ts`，那里在模块加载时就读 `app.isPackaged`。
 * 于是**任何**引了 `mt()` 的文件都会把整个 electron app 拖进自己的依赖图 ——
 * 十一个跟数据库有关的测试因此直接加载失败。一个文案表不该有这种引力。
 *
 * 没人推过就是中文。这也覆盖了启动失败那条路：那时候设置很可能正是读不出来
 * 的那个原因本身，而错误框还是得弹出来。
 */

type Lang = 'zh-CN' | 'en-US'

/** 主进程自己拥有的那些字符串。键名按归属分组，别往里塞渲染层能显示的东西 */
const STRINGS: Record<Lang, Record<string, string>> = {
  'zh-CN': {
    'tray.tooltip': '虚幻盒子',
    'tray.open': '打开虚幻盒子',
    // 和侧边栏按钮同一个叫法（渲染层 `menu.newChat`）
    'tray.newChat': '新对话',
    'tray.recentChats': '最近对话',
    'tray.untitledChat': '未命名对话',
    'tray.recentProjects': '最近项目',
    'tray.running': '{name}（运行中）',
    // 点了到插件连上来之间的那几十秒：还点不得，但得告诉用户它没在装死
    'tray.launching': '{name}（启动中）',
    'tray.quit': '退出',
    // 数的是 Agent session 的操作：AI 轮次和分叉 / 截断 / 压缩这类历史操作都算，
    // 但不是全部后台任务 —— 别让用户以为连导入也算
    'tray.quitConfirm': 'AI 还有 {count} 项操作在进行，退出会中断它们。',
    'tray.quitConfirmOk': '仍然退出',
    // 安装更新撞上 session 操作没收摊：同一个框，按钮说清楚是重启装包
    'tray.updateConfirmOk': '仍然重启安装',
    'tray.quitConfirmCancel': '取消',
    'tray.openFailedTitle': '打不开项目',
    'tray.openFailedBody': '{name}：{error}',
    'tray.openFailedMissing': '「{name}」的工程文件已经不在了',
    'tray.alreadyRunningTitle': '项目已经开着了',
    'tray.alreadyRunningBody': '「{name}」已经在虚幻编辑器里打开',
    'tray.pluginFailedTitle': '项目已打开，但 AI 暂时连不上',
    'tray.pluginFailedBody': 'UnrealAgentLink 没有装上，点这里查看原因',

    'startup.failedTitle': '虚幻盒子启动失败',
    // {reason} 是原始异常，{logDir} 是日志目录 —— 这两样是用户唯一能拿去求助的东西
    'startup.failedBody':
      '启动时发生错误，应用无法继续运行。\n\n原因：{reason}\n\n日志在：{logDir}',

    /*
     * 系统文件对话框的标题。
     *
     * 这些是**兜底**：调用方传了 title 就用调用方的（`...options` 排在后面）。
     * 但兜底照样会显示出来，而对话框是操作系统画的，渲染层碰不到 —— 所以在这边翻。
     */
    'dialog.open': '选择文件或文件夹',
    'dialog.save': '保存文件',
    'dialog.exportPdf': '导出 PDF',
    'dialog.saveRecording': '保存录制视频',
    'dialog.exportRecording': '导出录制视频',
    'dialog.pickLegacyDb': '选择旧版数据库文件',

    /*
     * 首次启动时建的两个系统保管库。
     *
     * 名字和说明会**落进数据库**，在创建那一刻定稿、之后不跟着语言变 ——
     * 这和文件名是一个道理：英文用户初始化出来的库就该是英文名。
     */
    'vault.defaultDesc': '系统默认创建的保管库',
    'vault.aigcDesc': '系统级 AI 创作资产保管库',

    // Spotlight 里「把这句话发给 AI」那一条
    'spotlight.askAi': '与 AI 对话：{query}',
    'spotlight.askAiDesc': '发送此消息给 AI 助手'
  },
  'en-US': {
    'tray.tooltip': 'Unreal Box',
    'tray.open': 'Open Unreal Box',
    'tray.newChat': 'New chat',
    'tray.recentChats': 'Recent chats',
    'tray.untitledChat': 'Untitled chat',
    'tray.recentProjects': 'Recent projects',
    'tray.running': '{name} (running)',
    'tray.launching': '{name} (starting)',
    'tray.quit': 'Quit',
    'tray.quitConfirm':
      'The AI still has {count} operation(s) in progress — quitting will interrupt them.',
    'tray.quitConfirmOk': 'Quit anyway',
    'tray.updateConfirmOk': 'Restart and install anyway',
    'tray.quitConfirmCancel': 'Cancel',
    'tray.openFailedTitle': 'Could not open project',
    'tray.openFailedBody': '{name}: {error}',
    'tray.openFailedMissing': 'The project file for "{name}" no longer exists',
    'tray.alreadyRunningTitle': 'Project already open',
    'tray.alreadyRunningBody': '"{name}" is already open in Unreal Editor',
    'tray.pluginFailedTitle': 'Project opened, but the AI cannot connect yet',
    'tray.pluginFailedBody': 'UnrealAgentLink was not installed — click to see why',

    'startup.failedTitle': 'Unreal Box failed to start',
    'startup.failedBody':
      'An error occurred during startup and the app cannot continue.\n\nReason: {reason}\n\nLogs are in: {logDir}',

    'dialog.open': 'Choose files or folders',
    'dialog.save': 'Save file',
    'dialog.exportPdf': 'Export PDF',
    'dialog.saveRecording': 'Save recording',
    'dialog.exportRecording': 'Export recording',
    'dialog.pickLegacyDb': 'Choose the legacy database file',

    'vault.defaultDesc': 'Vault created by Unreal Box',
    'vault.aigcDesc': 'System vault for AI-generated assets',

    'spotlight.askAi': 'Ask the AI: {query}',
    'spotlight.askAiDesc': 'Send this message to the AI assistant'
  }
}

/** `mt` 的签名 —— 托盘各模块注入翻译函数时共用这一个类型 */
export type MainTranslator = (key: string, params?: Record<string, string | number>) => string

/**
 * 取一句主进程文案。
 *
 * 查不到就原样返回 key —— 比返回空串好：界面上冒出个 `tray.open` 至少看得出
 * 是漏配了，空白则会被当成布局出了问题。
 */
export function mt(key: string, params?: Record<string, string | number>): string {
  const template = STRINGS[current][key] ?? STRINGS['zh-CN'][key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole
  )
}

/** 当前语言。没人推过就是中文 */
let current: Lang = 'zh-CN'

/**
 * 告诉主进程现在是什么语言。
 *
 * `appSettingsManager` 在两个时刻调它：启动读完设置、用户改了语言。
 * 认不出的值当中文处理 —— 设置文件是可以被手改坏的。
 */
export function setMainLanguage(language: string): void {
  const next: Lang = language === 'en-US' ? 'en-US' : 'zh-CN'
  if (next === current) return
  current = next
  notifyLanguageChanged()
}

/**
 * 当前界面语言。
 *
 * 原先只是为了可测才导出的，现在有产品路径在用：agent 的系统提示词要拿它当
 * 回复语言的兜底（见 `createAgent.ts` 的 `uiLanguage`）。所以这里是唯一真相 ——
 * 别在别处再读一遍设置文件，`appSettingsManager` 已经在启动和用户改语言时推过来了。
 */
export function currentMainLanguage(): Lang {
  return current
}

/**
 * 语言变了要重画的东西登记在这里。
 *
 * 托盘菜单和悬停提示是一次性交给操作系统的，语言换了它们不会自己变 —— 用户在设置里
 * 切成英文，托盘却一直是中文，直到下次启动。
 */
const listeners = new Set<() => void>()

export function onLanguageChanged(listener: () => void): void {
  listeners.add(listener)
}

function notifyLanguageChanged(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      // 一个订阅者炸了不该拖累别的（也不该拖累那次语言设置本身）
      console.warn('[i18n] 语言变更回调失败:', error)
    }
  }
}

/** 导出仅为可测 */
export const MAIN_STRINGS = STRINGS
