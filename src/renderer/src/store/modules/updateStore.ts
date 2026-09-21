import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { updaterAPI } from '@renderer/api/updater'

/**
 * 应用更新状态，全局一份。
 *
 * ## 为什么要有这个 Store
 *
 * 主进程启动时就会静默查一次更新、之后每 4 小时再查一次
 * （src/main/services/updater/autoUpdater.ts）。但 `updater:update-available`
 * 以前全仓只有「设置 → 关于」那个面板在监听 —— 面板没挂载就没人收，
 * 于是自动检查查到了新版本也悄无声息，用户还是得自己去关于页点一下。
 *
 * 状态收在这里之后：监听只注册一次，谁都能读同一份状态，标题栏的角标和
 * 关于页的按钮不会各说各话。
 *
 * ## 为什么要在订阅之后再拉一次 getStatus()
 *
 * 启动检查可能跑在渲染进程加载完之前。主进程是 `webContents.send`，
 * 没人听就是丢了。主进程那边的 status 会留着结果，所以订阅完必须再问一次快照，
 * 否则启动时查到的新版本在这个会话里永远显示不出来。
 */

/** 更新流程所处的阶段。互斥，界面按它一个值决定显示什么 */
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded'

export interface UpdateErrorPayload {
  message?: string
  code?: string
}

/**
 * 一次手动检查问出了什么。
 *
 * `unknown` 是「没问出结果」，不是「没有更新」：主进程有三条分支什么都不做
 * 也返回成功（没配更新源、已经有检查在跑、开发环境 updater 未激活），
 * 那几条路上一个事件都不会来。调用方据此决定要不要报「已是最新版本」。
 */
export type UpdateCheckOutcome = 'available' | 'downloaded' | 'upToDate' | 'unknown'

export interface UpdateCheckResult {
  success: boolean
  error?: string
  /** api 层造的可翻译失败（桥不在等）。调用方优先翻它，再退回 error */
  errorKey?: string
  outcome: UpdateCheckOutcome
}

export interface UpdateInitHooks {
  onAvailable?: (version: string) => void
  onError?: (error: UpdateErrorPayload) => void
}

/** 版本号统一带上 v 前缀显示 —— 主进程给的是裸版本号 */
export function formatUpdateVersion(version: string): string {
  if (!version) return ''
  return /^v/i.test(version) ? version : `v${version}`
}

export const useUpdateStore = defineStore('update', () => {
  const phase = ref<UpdatePhase>('idle')
  const latestVersion = ref('')
  const downloadPercent = ref(0)
  const lastError = ref<UpdateErrorPayload | null>(null)

  /**
   * 这个版本的「发现新版本」提示弹过了没有。
   *
   * 只活在内存里，不持久化：重启一次再提醒一遍是对的 —— 下载没做完，
   * 提醒本来就该继续。持久化反而会让用户错过一次就再也看不到。
   */
  const announcedVersion = ref('')

  /** 有没有值得在标题栏上占个位置的事。idle / checking 都不算 */
  const hasUpdateNews = computed(
    () =>
      phase.value === 'available' || phase.value === 'downloading' || phase.value === 'downloaded'
  )

  const isChecking = computed(() => phase.value === 'checking')

  let cleanups: Array<() => void> = []
  let initialized = false
  /** init() 传进来的提示回调。syncFromMain 也要用，所以不能只活在 init 的闭包里 */
  let initHooks: UpdateInitHooks = {}

  /** 这个阶段是不是「已经有结论」。有结论的状态不该被下一轮检查打回去 */
  function isSettledPhase(value: UpdatePhase): boolean {
    return value === 'available' || value === 'downloading' || value === 'downloaded'
  }

  /**
   * 用户正站在关于页等这一轮检查的结果。
   *
   * 这一轮的结果由那个面板自己弹确认框说，全局 toast 就别再说一遍 ——
   * 否则一次点击同时出现「发现新版本 v1.3.0，点标题栏右上角即可下载」和
   * 一个已经摆在眼前的「现在下载吗？」，两句话让用户去做两件不同的事。
   */
  let manualCheckInFlight = false

  /**
   * 这一轮检查主进程到底推事件了没有。
   *
   * **不能拿 `phase !== 'checking'` 反推。** check() 对已经有结论的状态
   * （available / downloading / downloaded）刻意不进「检查中」，于是那种情况下
   * 一个事件都没来它也是真 —— finishCheck 会拿着上一轮的陈旧 phase 报出
   * 「本轮查到了 available」，正是它注释里说要防的假阳性。由事件处理器自己置位才作数。
   */
  let sawEventThisRound = false

  /**
   * 新发现的版本弹一次全局提示；同一个版本只弹一次。
   *
   * 手动检查那一轮不弹，**也不记名** —— 理由见函数体里的注释。
   */
  function announce(version: string): void {
    if (!version || announcedVersion.value === version) return
    /*
     * **抑制的那一轮不能记名。**
     *
     * 记了名就等于说「这个版本已经通知过了」，可实际上一个字都没说出去。
     * 抑制的前提是「关于页会自己弹确认框」，而那个面板是 v-else-if 挂载的：
     * 用户点完检查随手切到别的设置分页，面板卸载、它的 watch(phase) 一起没了，
     * 于是提示既没 toast 也没弹窗 —— 而之后每一次后台检查都会撞上
     * `announcedVersion === version` 提前返回，这个版本整个会话再也不会提示。
     * 那正是这个 Store 文件头说它要解决的毛病。
     */
    if (manualCheckInFlight) return
    announcedVersion.value = version
    initHooks.onAvailable?.(version)
  }

  /**
   * 注册主进程事件监听，全应用只做一次。
   *
   * 提示由调用方给回调，Store 自己不碰 UI —— 它在单元测试里要能脱离 i18n 跑。
   *
   * @param hooks.onAvailable 发现新版本时的一次性提示。同一个版本只会叫一次。
   * @param hooks.onError 更新出错。主进程只在非静默（用户主动触发）时才推这个事件，
   *   所以收到就该让用户看见，不必再判断来源。
   */
  function init(hooks: UpdateInitHooks = {}): void {
    if (initialized) return
    initialized = true
    initHooks = hooks

    // 订阅也走 api 层：桥在不在只在那一处判，别让 Store 再留第二套判断
    const off = updaterAPI.subscribe({
      onChecking: () => {
        sawEventThisRound = true
        // 已经有结果在手上就别退回「检查中」—— 那个角标是用户唯一的安装入口。
        // 「有新版本」也算结果：后台每 4 小时查一次，每次都把角标摘掉的话，
        // 用户刚看到的更新提示会无缘无故消失，而静默检查失败是不推事件的，
        // 摘掉了就再也装不回来。
        if (isSettledPhase(phase.value)) return
        lastError.value = null
        phase.value = 'checking'
      },
      onAvailable: (data) => {
        sawEventThisRound = true
        lastError.value = null
        // 下载中/已下载的状态比「有新版本」更靠后，不要被一次例行检查打回去。
        // 版本号也一起挡在外面：装的是已经落盘的那一个，这里改了就会出现
        // 弹窗说要装 1.3.0、实际装上 1.2.0
        if (phase.value === 'downloading' || phase.value === 'downloaded') return
        latestVersion.value = data.version
        phase.value = 'available'
        announce(data.version)
      },
      onNotAvailable: () => {
        sawEventThisRound = true
        if (phase.value === 'downloading' || phase.value === 'downloaded') return
        phase.value = 'idle'
        // 版本号也得跟着清掉。它是「当前有没有更新」的唯一凭据（onUpdateError 就是
        // 照它决定要不要把角标点亮），不清的话：1.2.0 被撤下 → 这里只把 phase 归零 →
        // 之后任何一次失败的检查都会拿着陈年的 1.2.0 把角标重新点亮，用户点下载，
        // 主进程那边 updateAvailable 早就是 false，直接返回成功却什么都不做，
        // 角标就永远停在「下载中 0%」。
        // announcedVersion 一并清：同一个版本要是又发回来，该重新提示一次。
        latestVersion.value = ''
        announcedVersion.value = ''
      },
      onProgress: (data) => {
        sawEventThisRound = true
        // 已下载之后还漏进来的进度事件不能把状态拽回「下载中」——
        // 那会让角标变成 aria-disabled，唯一的安装入口就此点不动
        if (phase.value === 'downloaded') return
        phase.value = 'downloading'
        downloadPercent.value = Math.max(0, Math.min(100, Math.round(data.percent)))
      },
      onDownloaded: (data) => {
        sawEventThisRound = true
        latestVersion.value = data.version
        downloadPercent.value = 100
        phase.value = 'downloaded'
      },
      onError: (data) => {
        sawEventThisRound = true
        lastError.value = data ?? null
        // 主进程理论上总带 payload，但事件签名是可选的；给个空对象，
        // 调用方仍能按「出错了」处理，不必各自判 undefined
        hooks.onError?.(data ?? {})
        /*
         * 退回「可更新」，不是「无事发生」。
         *
         * 这里原来写的是 idle，和上一行注释说的正好相反。`hasUpdateNews` 不含
         * idle，所以那等于**把标题栏角标摘掉**：后台查到了新版本（角标亮着）→
         * 用户去关于页点一次检查 → 这次是非静默的、网络又断了 → update-error
         * 到达 → 角标没了，而 latestVersion 还在，下一次成功检查之前（最长 4 小时）
         * 没有任何东西能把它装回来。
         *
         * 下载那条路看着没事，只是运气好：download() 的 revertToAvailable()
         * 恰好在事件之后一个微任务才跑。不经过 download() 的 update-error 没这个运气。
         *
         * 手上没有版本号就还是 idle —— 那时候亮一个不知道要更新到哪的角标才是错的。
         * latestVersion 在 update-not-available 里会被清掉，所以它非空就确实代表
         * 「现在有一个还没装的更新」，不是陈年残留。
         */
        if (phase.value !== 'downloaded') {
          phase.value = latestVersion.value ? 'available' : 'idle'
        }
        downloadPercent.value = 0
      }
    })
    cleanups = off ? [off] : []

    // 订阅之后补一次快照：启动检查很可能早于渲染进程加载完
    void syncFromMain()
  }

  /** 问主进程要一次当前状态。推送已经把阶段推到更靠后时不覆盖 */
  async function syncFromMain(): Promise<void> {
    try {
      const data = await updaterAPI.getStatus()
      if (!data) return

      if (data.latestVersion) latestVersion.value = data.latestVersion

      if (data.updateDownloaded) {
        phase.value = 'downloaded'
        downloadPercent.value = 100
        return
      }
      if (phase.value === 'downloading' || phase.value === 'downloaded') return
      if (data.updateAvailable) {
        phase.value = 'available'
        // 走到这里说明启动检查早于订阅、事件已经丢了。提示也得在这里补一次，
        // 否则这个 Store 存在的理由（自动检查到的新版本要全局提示）在它
        // 真正要救的那条路径上恰好不成立
        announce(data.latestVersion || latestVersion.value)
        return
      }
      // 主进程此刻正在查（data.checking）**不能**照搬进 phase。
      //
      // 那是个没有出口的入口：finishCheck 只兜得住经 check() 进去的那一次，
      // 而快照这条路没人收尾。启动时离线的话，主进程的启动检查是静默的，
      // 失败了不推任何事件（autoUpdater 的 handleUpdateError 只在非静默时通知），
      // 于是 phase 永远停在 checking：角标不显示（hasUpdateNews 不含 checking），
      // 关于页的 `if (isChecking.value) return` 又把按钮彻底堵死 —— 没提示、没报错，
      // 最长要等 4 小时后的下一次后台检查，断网就是一整个会话。
      //
      // 正在查这件事本来也没什么可显示的：真查出结果会推事件过来，那时再进状态。
    } catch (error) {
      console.warn('[update] 读取更新状态失败:', error)
    }
  }

  /** 手动检查。结果走事件回来，这里负责发起并收尾 */
  async function check(): Promise<UpdateCheckResult> {
    const before: UpdatePhase = phase.value
    lastError.value = null
    // 已经有结论的状态不进「检查中」，否则角标会在检查期间凭空消失一下
    if (!isSettledPhase(before)) phase.value = 'checking'
    manualCheckInFlight = true
    sawEventThisRound = false
    try {
      // 桥不在、抛异常都由 api 层收成 { success, error }，这里不必再 try
      return finishCheck(before, await updaterAPI.checkForUpdates())
    } finally {
      manualCheckInFlight = false
    }
  }

  /**
   * 收尾一次手动检查。
   *
   * 事件都是在主进程 handler resolve 之前推过来的，所以 await 回来时
   * `sawEventThisRound` 还是假，就说明这一轮一个事件都没发。主进程有三条这样的
   * 分支，而且它们全都返回 success —— 不自己退回去的话 phase 永远卡在 checking，
   * isChecking 永远为真，「检查更新」按钮这个会话就此报废。
   */
  function finishCheck(
    before: UpdatePhase,
    result: { success: boolean; error?: string; errorKey?: string }
  ): UpdateCheckResult {
    const answered = sawEventThisRound
    if (!answered) phase.value = before === 'checking' ? 'idle' : before

    if (!result.success) {
      // IPC 自己就失败了，主进程不会再推 update-error。这里补一条，
      // 否则靠 lastError 区分「已是最新」和「没查成」的地方会判成前者
      lastError.value = { message: result.error }
      return { success: false, error: result.error, errorKey: result.errorKey, outcome: 'unknown' }
    }

    let outcome: UpdateCheckOutcome = 'unknown'
    if (answered && !lastError.value) {
      if (phase.value === 'downloaded') outcome = 'downloaded'
      else if (phase.value === 'available') outcome = 'available'
      else if (phase.value === 'idle') outcome = 'upToDate'
    }
    return { success: true, outcome }
  }

  /**
   * 开始下载。
   *
   * 主进程的 `downloadUpdate()` 要等整个下载结束才 resolve（几百 MB），
   * 所以调用方不要 await 着它画 loading —— 进度看 `downloadPercent`。
   */
  async function download(): Promise<{ success: boolean; error?: string; errorKey?: string }> {
    if (phase.value === 'downloading' || phase.value === 'downloaded') {
      return { success: true }
    }
    phase.value = 'downloading'
    downloadPercent.value = 0

    // 下载失败退回「可更新」，让用户能再点一次。但这中间可能已经下载完了
    // （事件比 invoke 的返回早到），那时不能把状态从 downloaded 拽回去。
    // 读成局部变量是为了绕开 TS 的收窄：它不知道 await 期间事件改过 phase
    const revertToAvailable = (): void => {
      const current: UpdatePhase = phase.value
      if (current !== 'downloaded') phase.value = 'available'
    }

    const result = await updaterAPI.downloadUpdate()
    if (!result.success) {
      revertToAvailable()
      return result
    }

    /*
     * 报了成功也要确认它真的动了。
     *
     * 主进程的 `downloadUpdate()` 有三条什么都不做就返回的分支（没配更新源、
     * 当前没有可用更新、已经有下载在跑），IPC 一律包成 `{ success: true }`。
     * 而这个方法要等整个下载结束才 resolve —— 真下载过就必然先收到
     * `update-downloaded`，phase 已经是 downloaded。所以 await 回来还停在
     * downloading、一个字节都没走，就说明这一轮压根没开始。
     *
     * 不退回去的话：角标永远停在「下载中 0%」，而 TabsHeader 对 downloading
     * 直接 return —— 唯一的入口就此点不动，且没有任何提示。
     */
    const current: UpdatePhase = phase.value
    if (current === 'downloading' && downloadPercent.value === 0) {
      revertToAvailable()
      // 这是渲染层自己造的失败，主进程不会推 update-error —— 给 i18n key，
      // 写死中文的话英文用户会看到一句中文（AGENTS.md §5 规则 3）
      return { success: false, errorKey: 'update.downloadNotStarted' }
    }
    return result
  }

  /** 退出并安装。成功的话这个进程随即就没了 */
  function install(): Promise<{ success: boolean; error?: string; errorKey?: string }> {
    return updaterAPI.quitAndInstall()
  }

  /** 窗口卸载时摘掉订阅。正常情况下不会走到 —— 主窗口活到进程结束 */
  function dispose(): void {
    cleanups.forEach((fn) => fn())
    cleanups = []
    initialized = false
  }

  return {
    phase,
    latestVersion,
    downloadPercent,
    lastError,
    hasUpdateNews,
    isChecking,
    init,
    syncFromMain,
    check,
    download,
    install,
    dispose
  }
})
