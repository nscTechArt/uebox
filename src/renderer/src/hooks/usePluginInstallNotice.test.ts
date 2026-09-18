/**
 * 插件没装上要说出来，而且给的下一步必须走得通。
 *
 * 红灯用例有两条：
 *
 *   1. 导入工程时 UnrealAgentLink 装不上，主进程只写 console.warn，照常返回
 *      「导入成功」。用户之后遇到的是「AI 连不上引擎」，而那时他早就不记得这跟
 *      导入那一步有关 —— 这条提示是这个故障唯一的线索。
 *   2. 提示给的下一步是「右键手动安装」，而右键走的是同一段代码，点了照样失败
 *      （2026-09-17 的 UTF-16 事故）。所以现在的下一步是把故障交给盒子自己的 AI，
 *      **并且必须把工程文件路径和原因码一起带过去** —— 少了路径，模型第一步就卡住。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const confirm = vi.fn()
const push = vi.fn()
const execute = vi.fn()
const ensureSession = vi.fn()
const errorToast = vi.fn()

vi.mock('@renderer/utils/dialog', () => ({
  confirmDialog: (...args: unknown[]) => confirm(...args)
}))

vi.mock('@renderer/router', () => ({
  default: {
    push: (...args: unknown[]) => push(...args),
    currentRoute: { value: { path: '/', fullPath: '/', query: {} } }
  }
}))

vi.mock('@renderer/utils/messageManager', () => ({
  message: { error: (...args: unknown[]) => errorToast(...args) }
}))

vi.mock('@renderer/store/modules/chatSessions', () => ({ useChatSessionsStore: () => ({}) }))
vi.mock('@renderer/store/modules/tabs', () => ({ useTabsStore: () => ({}) }))

vi.mock('@renderer/views/Assistant/composables/appAgentRunner', () => ({
  appExecuteAgent: (...args: unknown[]) => {
    execute(...args)
    return Promise.resolve()
  }
}))

vi.mock('@renderer/views/Assistant/composables/chatSendPrimitives', () => ({
  ensureSessionWithTitle: (...args: unknown[]) => ensureSession(...args)
}))

vi.mock('@renderer/i18n', () => ({
  default: {
    global: {
      // 原样回 key + 参数，断言时看得见到底用了哪条文案、填了什么
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}|${JSON.stringify(params)}` : key
    }
  }
}))

const { notifyPluginInstallFailure, notifyPluginUpgradeFailure } = await import(
  './usePluginInstallNotice'
)

/** 取这次弹窗的配置 */
function dialogOptions(): Record<string, unknown> {
  return confirm.mock.calls[0][0] as Record<string, unknown>
}

/** 点「让 AI 看看」，返回真正发给 AI 的那条消息 */
async function clickAskAi(): Promise<string> {
  await (dialogOptions().onOk as () => void | Promise<unknown>)()
  return String(execute.mock.calls[0][0])
}

describe('notifyPluginInstallFailure', () => {
  beforeEach(() => {
    confirm.mockReset()
    push.mockReset()
    execute.mockReset()
    ensureSession.mockReset()
    errorToast.mockReset()
  })

  it('装上了就不打扰用户', () => {
    expect(notifyPluginInstallFailure({})).toBe(false)
    expect(notifyPluginInstallFailure(null)).toBe(false)
    expect(notifyPluginInstallFailure(undefined)).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('认识的原因码翻成人话', () => {
    expect(notifyPluginInstallFailure({ pluginFailure: 'PLUGIN_FILES_MISSING' })).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(String(dialogOptions().content)).toContain('pluginFailure.filesMissing')
  })

  it('不认识的原因码把原文带上 —— 那多半是操作系统给的错误，是可搜的线索', () => {
    notifyPluginInstallFailure({ pluginFailure: 'EPERM: operation not permitted' })
    expect(String(dialogOptions().content)).toContain('EPERM: operation not permitted')
  })

  it('主按钮是「让 AI 看看」，不是让用户自己去点一条会失败的路', () => {
    notifyPluginInstallFailure({ pluginFailure: 'UPROJECT_UNREADABLE' })
    expect(String(dialogOptions().okText)).toContain('pluginFailure.askAi')
    expect(String(dialogOptions().cancelText)).toContain('pluginFailure.dismiss')
  })

  it('交给 AI 时带上工程文件路径和原因码', async () => {
    notifyPluginInstallFailure({
      pluginFailure: 'UPROJECT_UNREADABLE',
      data: { originPath: 'H:/UE/我的项目/我的项目.uproject', projectName: '我的项目' }
    })

    const prompt = await clickAskAi()
    expect(prompt).toContain('H:/UE/我的项目/我的项目.uproject')
    // 原因码不翻译 —— 模型认得 UPROJECT_UNREADABLE，用户不认得
    expect(prompt).toContain('UPROJECT_UNREADABLE')
    expect(prompt).toContain('我的项目')
  })

  /*
   * 这条盯的是「点了按钮什么都没发生」。
   *
   * `?initialMessage=` 那个入口只在助手页 onMounted 里读一次：用户此刻正开着助手页
   * 的话，同路径换 query 不重建组件，消息就悄无声息地没了。所以这里发的是应用级的
   * 那一轮，路由只负责把用户带到这条会话上。
   */
  it('这一轮由应用级运行器发起，不靠助手页挂没挂着', async () => {
    notifyPluginInstallFailure({
      pluginFailure: 'UPROJECT_UNREADABLE',
      data: { originPath: 'H:/UE/a/a.uproject', projectName: 'a' }
    })
    await clickAskAi()

    const chatSid = (execute.mock.calls[0][2] as { chatSid?: string }).chatSid
    expect(chatSid).toBeTruthy()
    expect(ensureSession).toHaveBeenCalledTimes(1)
    // 用户被带到的就是这条会话，不是一个空的助手页
    const route = push.mock.calls[0][0] as { path: string; query: Record<string, unknown> }
    expect(route.path).toBe('/dev-assistant')
    expect(route.query.sid).toBe(chatSid)
  })

  it('没点「让 AI 看看」就什么都不发生', () => {
    notifyPluginInstallFailure({ pluginFailure: 'UPROJECT_UNREADABLE' })
    expect(execute).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })
})

describe('notifyPluginUpgradeFailure', () => {
  beforeEach(() => {
    confirm.mockReset()
    push.mockReset()
    execute.mockReset()
    ensureSession.mockReset()
    errorToast.mockReset()
  })

  it('没有失败就不打扰用户', () => {
    expect(notifyPluginUpgradeFailure([])).toBe(false)
    expect(notifyPluginUpgradeFailure(null)).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('一批失败只弹一次，交给 AI 从第一条查起', async () => {
    expect(
      notifyPluginUpgradeFailure([
        { project: '我的项目', reason: 'EPERM', uprojectPath: 'H:/UE/a/a.uproject' },
        { project: '另一个', reason: 'EPERM', uprojectPath: 'H:/UE/b/b.uproject' }
      ])
    ).toBe(true)

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(await clickAskAi()).toContain('H:/UE/a/a.uproject')
  })
})
