import { afterEach, expect, it, vi } from 'vitest'
const store = vi.hoisted(() => ({
  shortcuts: [] as Array<{
    enabled: boolean
    type: string
    accelerator: string
    action_key: string
  }>,
  fetchShortcuts: vi.fn()
}))
vi.mock('@renderer/store/modules/shortcut', () => ({ useShortcutStore: () => store }))
import { useLocalShortcuts } from './useLocalShortcuts'

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['darwin', 'Control+R', true, false],
  ['darwin', 'CommandOrControl+R', false, true],
  ['win32', 'CommandOrControl+R', true, false]
])(
  'triggers the recorded %s shortcut %s with its actual modifier',
  (platform, accelerator, ctrlKey, metaKey) => {
    const reload = vi.fn()
    const add = vi.fn()
    const remove = vi.fn()
    vi.stubGlobal('window', {
      api: { platform },
      location: { reload },
      addEventListener: add,
      removeEventListener: remove
    })
    store.shortcuts = [{ enabled: true, type: 'local', accelerator, action_key: 'app.reload' }]
    const hook = useLocalShortcuts()
    hook.init()
    const handle = add.mock.calls[0][1]
    const event = {
      key: 'r',
      ctrlKey,
      metaKey,
      altKey: false,
      shiftKey: false,
      target: { tagName: 'DIV' },
      preventDefault: vi.fn()
    }
    handle(event)
    expect(reload).toHaveBeenCalledOnce()
    if (platform === 'darwin') {
      handle({ ...event, ctrlKey: !ctrlKey, metaKey: !metaKey })
      expect(reload).toHaveBeenCalledOnce()
    }
    hook.destroy()
    expect(remove).toHaveBeenCalledWith('keydown', handle)
  }
)

/**
 * 正式包里 Ctrl+Shift+R 不许还能刷新。
 *
 * View 菜单和偏好设置里那两处入口早就只在开发环境出现了，但真正会触发的是这里 ——
 * 之前漏了这一处，结果正式包里键照样管用，而用户已经找不到地方解绑它：
 * 一按就把正在跑的对话和导入连同渲染进程一起扔掉。
 */
it('生产构建里刷新快捷键不生效', () => {
  vi.stubEnv('DEV', false)
  const reload = vi.fn()
  const add = vi.fn()
  vi.stubGlobal('window', {
    api: { platform: 'win32' },
    location: { reload },
    addEventListener: add,
    removeEventListener: vi.fn()
  })
  store.shortcuts = [
    { enabled: true, type: 'local', accelerator: 'CommandOrControl+R', action_key: 'app.reload' }
  ]
  const hook = useLocalShortcuts()
  hook.init()
  const preventDefault = vi.fn()
  add.mock.calls[0][1]({
    key: 'r',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: { tagName: 'DIV' },
    preventDefault
  })

  expect(reload).not.toHaveBeenCalled()
  // 也不该吞掉这个按键 —— 我们不处理它，就别拦着别人处理
  expect(preventDefault).not.toHaveBeenCalled()
  hook.destroy()
  vi.unstubAllEnvs()
})
