import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import McpSettings from './McpSettings.vue'

/**
 * MCP 设置页。
 *
 * 这里盯两类东西：
 *
 *   1. **渐进披露**：第一次进来只该看到一个开关和一行字。端口、写工具开关、
 *      那段客户端 JSON、令牌，全部收在折叠区里。上一版把它们平铺在一屏，
 *      用户要先读完六段文字才知道该点哪儿。
 *   2. **功能没被重排弄丢**：端口用持久化的那个、非法端口不让启动、
 *      重置令牌要确认、复制的是整段配置。
 */

const status = vi.fn()
const start = vi.fn()
const stop = vi.fn()
const rotateToken = vi.fn()
const saveConfig = vi.fn()
const writeText = vi.fn().mockResolvedValue(undefined)
const getSettings = vi.fn()
const epicStatus = vi.fn()
const reconnect = vi.fn()

const TOKEN = '643fc00c1621ac16897808a3ce7551d056c9d9de127e6c6c'

const HOST_VIEW = {
  running: false,
  exposedTools: 0,
  url: 'http://127.0.0.1:17861/',
  // 和主进程 clientConfigSnippet() 生成的形状一致
  clientConfig: JSON.stringify(
    {
      mcpServers: {
        'unreal-box': {
          type: 'http',
          url: 'http://127.0.0.1:17861/',
          headers: { Authorization: `Bearer ${TOKEN}` }
        }
      }
    },
    null,
    2
  ),
  settings: { enabled: false, port: 17861, token: TOKEN, includeMutating: false }
}

const RUNNING = { ...HOST_VIEW, running: true, exposedTools: 69 }

/**
 * 有状态的假主进程。
 *
 * 界面在启停之后会回主进程再问一次真实状态（不信任本次操作自己回的结果），
 * 所以 `status` 不能是个固定值 —— 那样刚开起来的服务会被下一次 status
 * 打回「未启动」，测试和真实行为都对不上。
 */
let current: typeof HOST_VIEW

beforeEach(() => {
  vi.clearAllMocks()
  current = { ...HOST_VIEW }

  status.mockImplementation(async () => ({ ...current }))
  start.mockImplementation(async () => {
    current = { ...RUNNING, settings: { ...current.settings } }
    return { success: true, status: { ...current } }
  })
  stop.mockImplementation(async () => {
    current = { ...HOST_VIEW, settings: { ...current.settings } }
    return { success: true, status: { ...current } }
  })
  rotateToken.mockImplementation(async () => {
    current = {
      ...current,
      settings: { ...current.settings, token: 'tok-new' },
      clientConfig: 'Bearer tok-new'
    }
    return { success: true, status: { ...current } }
  })
  saveConfig.mockImplementation(async (patch: Record<string, unknown>) => {
    current = { ...current, settings: { ...current.settings, ...patch } }
    return { success: true, status: { ...current } }
  })

  getSettings.mockResolvedValue({
    settings: { version: 1, mcpServers: {} },
    path: 'C:/fake/mcp.json',
    statuses: []
  })
  epicStatus.mockResolvedValue({ success: true, projects: [] })
  reconnect.mockResolvedValue({ success: true, statuses: [] })

  // 只替 window.api，不动 window 本身 —— 整个换掉会把 happy-dom 的
  // Event 构造器一起换没，@vue/test-utils 的 trigger 会炸在
  // 「SupportedEventInterface is not a constructor」
  window.api = {
    ...window.api,
    agentV3: {
      mcp: { getSettings, saveSettings: vi.fn(), reconnect, epicStatus, epicSetup: vi.fn() },
      mcpServer: { status, start, stop, rotateToken, saveConfig }
    }
  } as unknown as typeof window.api

  // happy-dom 的 navigator.clipboard 是不可重定义的，只能打在方法上
  vi.spyOn(window.navigator.clipboard, 'writeText').mockImplementation(writeText)
})

type Wrapper = ReturnType<typeof mount>

async function mountPanel(): Promise<Wrapper> {
  const wrapper = mount(McpSettings)
  await flushPromises()
  return wrapper
}

/** 主开关：section.host 里唯一那个直接子级 setting-item 的 toggle */
async function flipMainToggle(wrapper: Wrapper): Promise<void> {
  await wrapper.find('.host [role="switch"]').trigger('click')
  await flushPromises()
}

/** 现在有两个 `.disclosure`（连接配置 / 高级），按文案挑 */
async function openDisclosure(wrapper: Wrapper, label: string): Promise<void> {
  const button = wrapper.findAll('.disclosure').find((b) => b.text().includes(label))
  expect(button, `没找到「${label}」折叠入口`).toBeTruthy()
  await button!.trigger('click')
  await flushPromises()
}

async function openAdvanced(wrapper: Wrapper): Promise<void> {
  await openDisclosure(wrapper, '端口和权限')
}

/** 权限开关。收在「端口和权限」里，是展开后 `.host` 的第二个开关 */
async function flipScopeToggle(wrapper: Wrapper): Promise<void> {
  const toggles = wrapper.findAll('.host [role="switch"]')
  await toggles[toggles.length - 1].trigger('click')
  await flushPromises()
}

describe('渐进披露', () => {
  /**
   * 第一屏的全部内容：一个开关 + 一行说明 + 两个折叠条。
   * 多一样都是在用户还没决定开不开的时候塞信息给他。
   */
  it('服务没开时，端口、权限开关、客户端配置都不出现', async () => {
    const wrapper = await mountPanel()

    expect(wrapper.findAll('.host [role="switch"]')).toHaveLength(1)
    expect(wrapper.find('input[type="number"]').exists()).toBe(false)
    expect(wrapper.find('.config').exists()).toBe(false)
    expect(wrapper.text()).not.toContain(TOKEN)
  })

  it('长安全警告默认不出现 —— 常驻的警告等于没有警告', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('.warning').exists()).toBe(false)

    await openAdvanced(wrapper)
    // 展开也还不出现：风险没变
    expect(wrapper.find('.warning').exists()).toBe(false)
  })

  it('打开权限开关时才展开那段警告', async () => {
    const wrapper = await mountPanel()
    await openAdvanced(wrapper)

    await flipScopeToggle(wrapper)

    expect(wrapper.find('.warning').exists()).toBe(true)
  })

  /**
   * 风险可以折起来，但不能藏在一个叫「高级」的抽屉里。
   *
   * 真正的毛病一直是**标签不预告里面有什么**，不是它折起来了。所以标题直接写
   * 「端口和权限」，当前档位挂在标题上 —— 不展开也看得见是只读还是可写。
   */
  it('折叠标题点名说出里面有权限，并把当前档位写在标题上', async () => {
    const wrapper = await mountPanel()

    const label = wrapper.findAll('.disclosure').map((b) => b.text())
    expect(label.some((l) => l.includes('权限'))).toBe(true)
    expect(wrapper.find('.scope-tag').text()).toBe('只读')
  })

  it('端口和权限都收在折叠区里，展开才有', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('input[type="number"]').exists()).toBe(false)

    await openAdvanced(wrapper)

    const portInput = wrapper.find('input[type="number"]')
    expect(portInput.exists()).toBe(true)
    expect((portInput.element as HTMLInputElement).value).toBe('17861')
    expect(wrapper.findAll('.host [role="switch"]')).toHaveLength(2)
  })

  // 刚开启时用户正要去配外部客户端，这一步不该还要他自己点开
  it('开启服务后自动摊开连接配置', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)

    expect(wrapper.find('.config').exists()).toBe(true)
    expect(wrapper.find('.config').text()).toContain('mcpServers')
  })

  /**
   * 用户报的第 3 条：「缺少复制配置、令牌等的按钮」。
   *
   * 上一版把「连接配置」这个入口塞在 `v-if="host.running"` 里面，
   * 服务没开时整块够不着。而端口和令牌是持久化的、停着也算得出来，
   * 用户的典型顺序恰恰是先配好客户端再回来开服务。
   */
  it('服务没开也能展开连接配置，拿到 JSON 和复制按钮', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('.dot').exists()).toBe(false)

    await openDisclosure(wrapper, '连接配置')

    expect(wrapper.find('.config').text()).toContain('mcpServers')
    const labels = wrapper.findAll('.drawer button').map((b) => b.text())
    expect(labels).toContain('复制配置')
    expect(labels).toContain('复制令牌')
    expect(labels).toContain('重置')
  })

  /**
   * 令牌是凭据，没理由一直摊在屏幕上（身边有人、录屏、共享桌面）。
   * 头尾够核对，要用就点复制。
   */
  it('令牌只显示头尾，完整值不出现在界面上', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)

    const token = wrapper.find('.token').text()
    expect(token).toContain('643fc00c')
    expect(token).toContain('7e6c6c')
    expect(token).not.toBe(TOKEN)
    expect(token.length).toBeLessThan(TOKEN.length)
  })

  it('运行中给出状态点和工具数', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)

    expect(wrapper.find('.dot').exists()).toBe(true)
    expect(wrapper.text()).toContain('69')
  })

  /**
   * 面板标题和页面 Header 是同一句，重复两遍是上一版最刺眼的地方。
   *
   * 但**两节都得有自己的小标题**：下半页写着「共享虚幻引擎能力」，上半页却
   * 什么都没有，手配的那几条就裸在页面上，用户分不清哪块是盒子自动接的。
   */
  it('两节各有小标题，且都不重复页面 Header 那句', async () => {
    const wrapper = await mountPanel()
    const titles = wrapper.findAll('.section-title').map((n) => n.text())

    expect(titles).toHaveLength(2)
    for (const title of titles) expect(title).not.toContain('接入外部 MCP 服务')
  })

  // 一条 server 都没有时，「保存并连接」「重新连接」没有意义
  it('没有第三方 server 时只给「添加服务」一个按钮', async () => {
    const wrapper = await mountPanel()
    const buttons = wrapper.findAll('.settings-section:first-child .actions button')
    expect(buttons).toHaveLength(1)
  })
})

describe('对外暴露的功能本身', () => {
  it('按持久化的端口启动', async () => {
    status.mockResolvedValue({
      ...HOST_VIEW,
      settings: { ...HOST_VIEW.settings, port: 18999, includeMutating: true }
    })
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)

    expect(start).toHaveBeenCalledWith({ includeMutating: true, port: 18999 })
  })

  it('端口非法时开关点不动 —— 否则请求发出去只会拿回一句底层报错', async () => {
    const wrapper = await mountPanel()
    await openAdvanced(wrapper)
    await wrapper.find('input[type="number"]').setValue(80)
    await flushPromises()

    expect(wrapper.find('.host [role="switch"]').attributes('disabled')).toBeDefined()
    await flipMainToggle(wrapper)
    expect(start).not.toHaveBeenCalled()
  })

  /**
   * 用户报的第 2 条：「开关只能开不能关」。
   *
   * 根因在主进程（`McpServerHost.stop()` 等一个永远不来的 close 回调，
   * 见那边的测试）。界面这边守住的是：关掉之后开关真的回到关，
   * 状态点消失 —— 而不是弹回「开」。
   */
  it('再点一次开关停止服务，开关回到关', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)
    expect(wrapper.find('.dot').exists()).toBe(true)

    await wrapper.find('.host [role="switch"]').trigger('click')
    await flushPromises()

    expect(stop).toHaveBeenCalled()
    expect(wrapper.find('.dot').exists()).toBe(false)
    expect(wrapper.find('.host [role="switch"]').attributes('aria-checked')).toBe('false')
  })

  /**
   * 用户报的第 1 条：「配置没有持久化」。
   *
   * 端口和「开放写操作工具」原来**只有点开启时才写盘**。用户在高级里改完
   * 不点开启就切走，下次回来全变回默认值。
   */
  it('改端口后失焦就落盘，不用等点开启', async () => {
    const wrapper = await mountPanel()
    await openAdvanced(wrapper)

    const input = wrapper.find('input[type="number"]')
    await input.setValue(18888)
    await input.trigger('blur')
    await flushPromises()

    expect(saveConfig).toHaveBeenCalledWith({ port: 18888, includeMutating: false })
    expect(start).not.toHaveBeenCalled()
  })

  it('改权限档也立刻落盘', async () => {
    const wrapper = await mountPanel()
    await openAdvanced(wrapper)
    await flipScopeToggle(wrapper)

    expect(saveConfig).toHaveBeenCalledWith({ port: 17861, includeMutating: true })
  })

  /**
   * 主进程比渲染层旧的时候不能整个废掉。
   *
   * 开发时改渲染层是热更新的，Electron 主进程不会跟着重启 —— 新界面配上
   * 旧主进程，`status` 里没有 `settings`，`view.settings.includeMutating`
   * 直接抛 TypeError：`load()` 挂掉、面板停在初始状态、开关按下去没反应、
   * 连接配置那块也出不来。用户报的三条症状都能由这一个异常解释。
   */
  it('主进程回的状态缺字段时，面板照样能用', async () => {
    status.mockResolvedValue({ running: false, exposedTools: 0 })
    const wrapper = await mountPanel()

    expect(wrapper.find('.host [role="switch"]').exists()).toBe(true)
    await openDisclosure(wrapper, '连接配置')
    expect(wrapper.find('.config').exists()).toBe(true)
    await openAdvanced(wrapper)
    expect((wrapper.find('input[type="number"]').element as HTMLInputElement).value).toBe('17861')
  })

  it('status 整个失败时也不把面板打挂', async () => {
    status.mockRejectedValue(new Error('IPC 没这个 handler'))
    const wrapper = await mountPanel()

    expect(wrapper.find('.host [role="switch"]').exists()).toBe(true)
    expect(wrapper.findAll('.disclosure').length).toBe(2)
  })

  // 不信任 start/stop 自己回的结果：以主进程报的实际状态为准
  it('启停之后回主进程再确认一次真实状态', async () => {
    const wrapper = await mountPanel()
    status.mockClear()
    await flipMainToggle(wrapper)

    expect(status).toHaveBeenCalled()
  })

  // 非法端口写进去，下次开机自启会拿一个必然失败的端口
  it('端口非法时不落盘', async () => {
    const wrapper = await mountPanel()
    await openAdvanced(wrapper)

    const input = wrapper.find('input[type="number"]')
    await input.setValue(80)
    await input.trigger('blur')
    await flushPromises()

    expect(saveConfig).not.toHaveBeenCalled()
  })

  /**
   * 重置令牌会让所有已配好的外部客户端立刻失效，不能手滑触发。
   */
  it('重置令牌要先确认，取消就什么都不做', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)
    window.confirm = vi.fn().mockReturnValue(false)

    await wrapper.find('.drawer button.app-button--danger').trigger('click')
    await flushPromises()
    expect(rotateToken).not.toHaveBeenCalled()
  })

  it('确认之后换新令牌，配置片段跟着更新', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)
    window.confirm = vi.fn().mockReturnValue(true)

    await wrapper.find('.drawer button.app-button--danger').trigger('click')
    await flushPromises()

    expect(rotateToken).toHaveBeenCalled()
    expect(wrapper.find('.config').text()).toContain('tok-new')
  })

  it('「复制配置」复制的是整段 JSON，不是只有令牌', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)
    await wrapper.find('.drawer button.app-button--primary').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith(HOST_VIEW.clientConfig)
  })
})

/**
 * 上半页：接入第三方 server 的状态胶囊。
 *
 * 停用的 server 也会带一条状态回来（agent 要能区分「停用」和「没配过」），
 * 界面得跟着分开显示 —— 把用户自己关掉的东西报成「连接失败」，
 * 只会让人去排查一个根本不存在的故障。
 */
describe('第三方 server 的状态胶囊', () => {
  function withServers(statuses: unknown[]): void {
    getSettings.mockResolvedValue({
      settings: {
        version: 1,
        mcpServers: { filesystem: { type: 'stdio', command: 'npx', args: ['-y', 'srv'] } }
      },
      path: 'C:/fake/mcp.json',
      statuses
    })
  }

  it('连上时显示工具数', async () => {
    withServers([{ id: 'filesystem', connected: true, toolCount: 7 }])
    const chip = (await mountPanel()).find('.status')

    expect(chip.classes()).toContain('ok')
    expect(chip.text()).toContain('7')
  })

  // 原因不再放 tooltip：会去排查的人不会想到悬停，见 `errorOf`
  it('连不上时显示失败，原因直接写在行下面', async () => {
    withServers([{ id: 'filesystem', connected: false, toolCount: 0, error: 'spawn npx ENOENT' }])
    const wrapper = await mountPanel()

    expect(wrapper.find('.status').classes()).toContain('bad')
    expect(wrapper.find('.row-error').text()).toBe('spawn npx ENOENT')
  })

  it('停用时显示「已停用」而不是「连接失败」', async () => {
    withServers([{ id: 'filesystem', connected: false, toolCount: 0, disabled: true }])
    const chip = (await mountPanel()).find('.status')

    expect(chip.classes()).toContain('muted')
    expect(chip.classes()).not.toContain('bad')
  })

  it('有 server 时才出现「保存并连接」和「重新连接」', async () => {
    withServers([{ id: 'filesystem', connected: true, toolCount: 1 }])
    const wrapper = await mountPanel()

    expect(wrapper.findAll('.settings-section:first-child .actions button')).toHaveLength(3)
  })
})

/**
 * 引擎内置工具集那一块。
 *
 * 跑得好好的时候用户什么都不用做，摊开五行只是占地方；一旦连不上，
 * 里面就有原因要看、有按钮要点 —— 那时候藏起来等于没有。
 */
describe('引擎块：好的时候一行，坏的时候摊开', () => {
  function withEngine(status: Record<string, unknown>): void {
    getSettings.mockResolvedValue({
      settings: { version: 1, mcpServers: {} },
      path: 'C:/fake/mcp.json',
      statuses: [status]
    })
  }

  it('连上时收成一行，说明和提示都不出现', async () => {
    withEngine({ id: 'ue-official', connected: true, toolCount: 3 })
    const wrapper = await mountPanel()

    expect(wrapper.find('.discovered .engine-head').text()).toContain('虚幻引擎内置工具集')
    expect(wrapper.find('.discovered .engine-head .status.ok').text()).toContain('3')
    expect(wrapper.find('.discovered .engine-desc').exists()).toBe(false)
    expect(wrapper.find('.discovered .engine-hint').exists()).toBe(false)
  })

  it('点一下摊开，才有说明和条目', async () => {
    withEngine({ id: 'ue-official', connected: true, toolCount: 3 })
    const wrapper = await mountPanel()

    await wrapper.find('.discovered .row-toggle').trigger('click')
    await flushPromises()

    expect(wrapper.find('.discovered .engine-desc').exists()).toBe(true)
    expect(wrapper.find('.discovered .engine-row').text()).toContain('ue-official')
  })

  /**
   * 「连接失败」四个字不带原因，用户能做的只有瞪着它。
   * 原因原来只塞在 title 里 —— 这个文件自己写过：会去排查的人不会想到悬停。
   */
  it('连不上时强制摊开，把原因原样写出来', async () => {
    withEngine({
      id: 'ue-official',
      connected: false,
      toolCount: 0,
      error: 'connect ECONNREFUSED 127.0.0.1:30069'
    })
    const wrapper = await mountPanel()

    expect(wrapper.find('.discovered .engine-head .status.bad').exists()).toBe(true)
    expect(wrapper.find('.row-error').text()).toBe('connect ECONNREFUSED 127.0.0.1:30069')
  })

  it('连不上时给「重试连接」，点了就真去重连', async () => {
    withEngine({ id: 'ue-official', connected: false, toolCount: 0, error: 'boom' })
    const wrapper = await mountPanel()

    const retry = wrapper.find('.discovered .actions button')
    expect(retry.text()).toBe('重试连接')
    await retry.trigger('click')
    await flushPromises()

    expect(reconnect).toHaveBeenCalled()
  })

  // 好好跑着的时候没什么可重试的
  it('连上时不给重试按钮', async () => {
    withEngine({ id: 'ue-official', connected: true, toolCount: 3 })
    const wrapper = await mountPanel()
    await wrapper.find('.discovered .row-toggle').trigger('click')
    await flushPromises()

    expect(wrapper.find('.discovered .actions').exists()).toBe(false)
  })

  // 同一条毛病，手配的那几条也犯 —— 不能只修一半
  it('手配的服务连不上时，原因也写在行下面', async () => {
    getSettings.mockResolvedValue({
      settings: { version: 1, mcpServers: { filesystem: { type: 'stdio', command: 'npx' } } },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'filesystem', connected: false, toolCount: 0, error: 'spawn npx ENOENT' }]
    })
    const wrapper = await mountPanel()

    expect(wrapper.find('.server-row .row-error').text()).toBe('spawn npx ENOENT')
  })
})

/**
 * 上半页的渐进披露。
 *
 * 下半页守得挺好（端口、令牌、JSON 都折起来了），上半页却整个漏掉：每条 server
 * 把四个输入框 + 两行说明永久摊在屏幕上，一条就占掉半屏。可是「改启动命令」
 * 一辈子做一两次，而**每次进这个页面都是为了看一眼它通没通**。
 */
describe('已配好的服务默认只占一行', () => {
  function withBlender(): void {
    getSettings.mockResolvedValue({
      settings: {
        version: 1,
        mcpServers: { blender: { type: 'stdio', command: 'blender-mcp', env: { A: '1' } } }
      },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'blender', connected: true, toolCount: 26 }]
    })
  }

  it('默认收起：只有名字和状态，输入框一个都不出现', async () => {
    withBlender()
    const wrapper = await mountPanel()

    expect(wrapper.find('.row-summary').text()).toContain('blender')
    expect(wrapper.find('.row-summary .status').text()).toContain('26')
    expect(wrapper.find('.server-row input[type="text"]').exists()).toBe(false)
    expect(wrapper.find('.server-row textarea').exists()).toBe(false)
  })

  it('点一下才摊开成编辑态', async () => {
    withBlender()
    const wrapper = await mountPanel()

    await wrapper.find('.row-toggle').trigger('click')
    await flushPromises()

    expect(wrapper.find('.command-input').exists()).toBe(true)
    expect(wrapper.find('.env-field').exists()).toBe(true)
  })

  it('再点一下收回去', async () => {
    withBlender()
    const wrapper = await mountPanel()

    await wrapper.find('.row-toggle').trigger('click')
    await flushPromises()
    await wrapper.find('.row-toggle').trigger('click')
    await flushPromises()

    expect(wrapper.find('.command-input').exists()).toBe(false)
  })

  // 收起的行里报错等于没报错
  it('有错的行强制展开，藏不住', async () => {
    getSettings.mockResolvedValue({
      settings: {
        version: 1,
        mcpServers: { blender: { type: 'stdio', command: 'x', env: { A: '1' } } }
      },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'blender', connected: true, toolCount: 1 }]
    })
    const wrapper = await mountPanel()
    // 写一行认不出来的环境变量
    await wrapper.find('.row-toggle').trigger('click')
    await flushPromises()
    await wrapper.find('.env-field textarea').setValue('这不是环境变量')
    await flushPromises()
    // 就算这时候去点收起，也收不掉
    await wrapper.find('.row-toggle').trigger('click')
    await flushPromises()

    expect(wrapper.find('.server-row .error').exists()).toBe(true)
    expect(wrapper.find('.env-field').exists()).toBe(true)
  })

  it('存完就把编辑态收回去 —— 事办完了，屏幕该回到一行一个服务', async () => {
    withBlender()
    window.api.agentV3.mcp.saveSettings = vi
      .fn()
      .mockResolvedValue({ success: true, statuses: [{ id: 'blender', connected: true }] })
    const wrapper = await mountPanel()
    await wrapper.find('.row-toggle').trigger('click')
    await flushPromises()

    await wrapper
      .findAll('.settings-section:first-child .actions button')
      .find((b) => b.text().includes('保存'))!
      .trigger('click')
    await flushPromises()

    expect(wrapper.find('.command-input').exists()).toBe(false)
  })
})

/**
 * 令牌是凭据，屏幕上一处都不该有完整值。
 *
 * 底下那行头尾打码原来**完全是白做的**：同一把令牌一字不差地印在上方
 * 那块 JSON 预览里，字号还更大。屏幕上多一个人、或者正在录屏共享，
 * 泄露的是那一块。
 */
describe('令牌不摊在屏幕上', () => {
  it('预览里的令牌也打码，不是只有底下那行', async () => {
    const wrapper = await mountPanel()
    await openDisclosure(wrapper, '连接配置')

    const preview = wrapper.find('.config').text()
    expect(preview).toContain('mcpServers')
    expect(preview).not.toContain(TOKEN)
    expect(preview).toContain('643fc00c')
  })

  it('点「显示」才给完整值，这是一个明确的动作', async () => {
    const wrapper = await mountPanel()
    await openDisclosure(wrapper, '连接配置')

    const reveal = wrapper.findAll('.drawer button').find((b) => b.text() === '显示')
    expect(reveal, '没找到「显示」').toBeTruthy()
    await reveal!.trigger('click')
    await flushPromises()

    expect(wrapper.find('.config').text()).toContain(TOKEN)
  })

  // 打码是给眼睛看的，不能影响粘贴
  it('打码状态下复制到的仍然是完整配置', async () => {
    const wrapper = await mountPanel()
    await openDisclosure(wrapper, '连接配置')
    await wrapper.find('.drawer button.app-button--primary').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith(HOST_VIEW.clientConfig)
  })

  it('换了新令牌就收回明文 —— 上次「显示」是针对旧令牌的决定', async () => {
    const wrapper = await mountPanel()
    await openDisclosure(wrapper, '连接配置')
    await wrapper
      .findAll('.drawer button')
      .find((b) => b.text() === '显示')!
      .trigger('click')
    await flushPromises()

    window.confirm = vi.fn().mockReturnValue(true)
    await wrapper.find('.drawer button.app-button--danger').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.drawer button').some((b) => b.text() === '显示')).toBe(true)
  })
})

/**
 * 空行的那条规则。
 *
 * 点「添加服务」立刻蹦一句「标识不能为空」，那条红字又让「保存并连接」整个禁掉 ——
 * 用户连**刚在另一行改好的东西**都存不了。真正的语义很简单：加了没填就等于没加。
 */
describe('新增行不该立刻报错、更不该锁死保存', () => {
  function withOneServer(): void {
    getSettings.mockResolvedValue({
      settings: {
        version: 1,
        mcpServers: { blender: { type: 'stdio', command: 'blender-mcp' } }
      },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'blender', connected: true, toolCount: 26 }]
    })
  }

  async function clickAdd(wrapper: Wrapper): Promise<void> {
    await wrapper.findAll('.settings-section:first-child .actions button')[0].trigger('click')
    await flushPromises()
  }

  it('刚加出来的空行不报「标识不能为空」', async () => {
    withOneServer()
    const wrapper = await mountPanel()
    await clickAdd(wrapper)

    expect(wrapper.findAll('.server-row')).toHaveLength(2)
    expect(wrapper.find('.server-row .error').exists()).toBe(false)
  })

  it('空行不挡住保存另一条已经改好的配置', async () => {
    withOneServer()
    const wrapper = await mountPanel()
    await clickAdd(wrapper)

    const save = wrapper
      .findAll('.settings-section:first-child .actions button')
      .find((b) => b.text().includes('保存'))
    expect(save!.attributes('disabled')).toBeUndefined()
  })

  // 填了一半才算错 —— 这时候用户确实漏了东西
  it('填了命令却没填标识，才报错并说清楚挡了几条', async () => {
    withOneServer()
    const wrapper = await mountPanel()
    await clickAdd(wrapper)
    await wrapper.findAll('.server-row')[1].find('.command-input').setValue('npx -y some-server')
    await flushPromises()

    expect(wrapper.find('.server-row .error').text()).toContain('标识')
    expect(wrapper.text()).toContain('1 条配置填写不完整')
  })

  it('保存时把空行丢掉，不写进 mcp.json 也不留在界面上', async () => {
    withOneServer()
    const saveSettings = vi.fn().mockResolvedValue({ success: true, statuses: [] })
    window.api.agentV3.mcp.saveSettings = saveSettings
    const wrapper = await mountPanel()
    await clickAdd(wrapper)

    await wrapper
      .findAll('.settings-section:first-child .actions button')
      .find((b) => b.text().includes('保存'))!
      .trigger('click')
    await flushPromises()

    expect(Object.keys(saveSettings.mock.calls[0][0].settings.mcpServers)).toEqual(['blender'])
    expect(wrapper.findAll('.server-row')).toHaveLength(1)
  })
})

/**
 * 用户报的：「打开了 5.8 工程、也开了 MCP 插件，顶部那块反而不见了」。
 *
 * 根因是两块的判据来自两份不同步的数据：一键块看的是**每次实时探端口**的
 * `epicStatus`，自动发现块看的是 MCP manager **上次连接时的快照** `statuses`。
 * 用户开着盒子再去打开工程时两者必然错位 —— 一键块因为「已经好了」收起，
 * 自动发现块因为「还不知道好了」不出现，中间一片没有任何解释的空白。
 */
describe('一键块和自动发现块的交接', () => {
  const READY_PROJECT = {
    connectionId: 'c1',
    projectName: 'BIKEOUT',
    state: 'ready' as const,
    missingPlugins: [],
    autoStartEnabled: true,
    url: 'http://127.0.0.1:30069/mcp'
  }

  it('引擎已开启但盒子还没连上时，一键块不许消失', async () => {
    epicStatus.mockResolvedValue({ success: true, projects: [READY_PROJECT] })
    const wrapper = await mountPanel()

    // 两块至少要有一块在说话，否则用户看到的就是「坏了」
    expect(wrapper.find('.engine-block.setup').exists()).toBe(true)
    expect(wrapper.text()).toContain('BIKEOUT')
  })

  it('自动发现块接手报状态之后，一键块才收起来', async () => {
    epicStatus.mockResolvedValue({ success: true, projects: [READY_PROJECT] })
    getSettings.mockResolvedValue({
      settings: { version: 1, mcpServers: {} },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'ue-official', connected: true, toolCount: 3 }]
    })
    const wrapper = await mountPanel()

    expect(wrapper.find('.engine-block.setup').exists()).toBe(false)
    // 收起来的前提是接手的那块真的在
    expect(wrapper.find('.engine-block').exists()).toBe(true)
  })

  /**
   * `currentStatuses()` 只在 agent 跑过或用户手点「重新连接」时更新，没有任何东西
   * 会因为「用户刚打开了工程」去重新发现。不自动补的话，用户得自己猜到去点那个
   * 跟引擎看起来毫无关系的按钮。
   */
  it('探到已开启、缓存里却没有引擎 server 时自动补一次重连', async () => {
    epicStatus.mockResolvedValue({ success: true, projects: [READY_PROJECT] })
    reconnect.mockResolvedValue({
      success: true,
      statuses: [{ id: 'ue-official', connected: true, toolCount: 3 }]
    })
    const wrapper = await mountPanel()

    expect(reconnect).toHaveBeenCalled()
    // 补上之后自动发现块出现，一键块随之收起
    expect(wrapper.find('.engine-block.setup').exists()).toBe(false)
  })

  it('缓存里已经有引擎 server 就不多此一举地重连', async () => {
    epicStatus.mockResolvedValue({ success: true, projects: [READY_PROJECT] })
    getSettings.mockResolvedValue({
      settings: { version: 1, mcpServers: {} },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'ue-official', connected: true, toolCount: 3 }]
    })
    await mountPanel()

    expect(reconnect).not.toHaveBeenCalled()
  })

  it('还没开好的项目照旧给按钮，不受影响', async () => {
    epicStatus.mockResolvedValue({
      success: true,
      projects: [{ ...READY_PROJECT, state: 'needs-plugins' }]
    })
    const wrapper = await mountPanel()

    expect(wrapper.find('.engine-block.setup button').exists()).toBe(true)
    expect(reconnect).not.toHaveBeenCalled()
  })
})
