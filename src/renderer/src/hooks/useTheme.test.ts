import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 主题偏好有四个：跟随系统 / 浅色 / 深色 / 自定义。
 *
 * 这里守的是「跟随系统」那条 —— 它是唯一一个不能靠读一次配置就完事的：
 * 用户在 Windows 设置里切了深浅色，应用得当场跟上，不能等重启。
 * 所以 useTheme 必须挂上 prefers-color-scheme 的监听，而且监听触发后
 * data-theme 要真的跟着变。
 *
 * useTheme 的状态是模块级单例（主题是全局的），所以每个用例都要
 * resetModules + 重新 import，否则上一个用例的偏好会漏到下一个。
 */

type MediaListener = (event: { matches: boolean }) => void

function stubMatchMedia(prefersDark: boolean): { fire: (matches: boolean) => void } {
  const listeners: MediaListener[] = []
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: prefersDark,
      addEventListener: (_type: string, listener: MediaListener) => listeners.push(listener),
      removeEventListener: vi.fn()
    }))
  )
  return {
    fire: (matches: boolean) => listeners.forEach((listener) => listener({ matches }))
  }
}

async function loadTheme(): Promise<typeof import('./useTheme')> {
  vi.resetModules()
  return import('./useTheme')
}

describe('useTheme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    vi.unstubAllGlobals()
  })

  it('没存过偏好时跟随系统', async () => {
    stubMatchMedia(false)
    const { useTheme } = await loadTheme()
    const { themePreference, currentTheme } = useTheme()

    expect(themePreference.value).toBe('system')
    expect(currentTheme.value).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('跟随系统时，系统切换深浅色会当场跟上', async () => {
    const media = stubMatchMedia(false)
    const { useTheme } = await loadTheme()
    const { currentTheme, isDark } = useTheme()

    expect(currentTheme.value).toBe('light')

    media.fire(true)
    await Promise.resolve()

    expect(currentTheme.value).toBe('dark')
    expect(isDark.value).toBe(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('明确选了浅色/深色之后，系统怎么变都不跟了', async () => {
    const media = stubMatchMedia(true)
    const { useTheme } = await loadTheme()
    const { setTheme, currentTheme } = useTheme()

    setTheme('light')
    await Promise.resolve()
    expect(currentTheme.value).toBe('light')

    media.fire(false)
    media.fire(true)
    await Promise.resolve()

    expect(currentTheme.value).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('偏好存进 localStorage，下次启动直接读出来', async () => {
    stubMatchMedia(true)
    const first = await loadTheme()
    first.useTheme().setTheme('light')
    expect(localStorage.getItem('app-theme')).toBe('light')

    const second = await loadTheme()
    expect(second.useTheme().themePreference.value).toBe('light')
    expect(second.useTheme().currentTheme.value).toBe('light')
  })

  it('另一个窗口切换主题时，当前窗口立即跟上', async () => {
    stubMatchMedia(false)
    const { useTheme } = await loadTheme()
    const currentWindow = useTheme()

    expect(currentWindow.currentTheme.value).toBe('light')

    localStorage.setItem('app-theme', 'dark')
    window.dispatchEvent(new StorageEvent('storage', { key: 'app-theme' }))
    await Promise.resolve()

    expect(currentWindow.themePreference.value).toBe('dark')
    expect(currentWindow.currentTheme.value).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('另一个窗口修改自定义主题时，当前窗口同步语义色', async () => {
    stubMatchMedia(true)
    const { useTheme } = await loadTheme()
    const currentWindow = useTheme()
    const colors = { background: '#101820', foreground: '#F2F4F8', accent: '#1A73E2' }

    localStorage.setItem('app-custom-theme', JSON.stringify(colors))
    window.dispatchEvent(new StorageEvent('storage', { key: 'app-custom-theme' }))
    localStorage.setItem('app-theme', 'custom')
    window.dispatchEvent(new StorageEvent('storage', { key: 'app-theme' }))
    await Promise.resolve()

    expect(currentWindow.themePreference.value).toBe('custom')
    expect(document.documentElement.style.getPropertyValue('--color-bg-page')).toBe(
      colors.background
    )
    expect(document.documentElement.style.getPropertyValue('--color-accent-solid')).toBe(
      colors.accent
    )
  })

  it('自定义主题持久化颜色，并把语义色写到根元素', async () => {
    stubMatchMedia(true)
    const { useTheme } = await loadTheme()
    const theme = useTheme()
    const colors = { background: '#101820', foreground: '#F2F4F8', accent: '#1A73E2' }

    expect(theme.setCustomTheme(colors)).toBe(true)
    theme.setTheme('custom')
    await Promise.resolve()

    expect(theme.themePreference.value).toBe('custom')
    expect(localStorage.getItem('app-custom-theme')).toBe(JSON.stringify(colors))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.style.getPropertyValue('--color-bg-page')).toBe(
      colors.background
    )
    expect(document.documentElement.style.getPropertyValue('--color-accent-solid')).toBe(
      colors.accent
    )
  })

  it('离开自定义主题时清掉运行时颜色，恢复内置色板', async () => {
    stubMatchMedia(true)
    const { useTheme } = await loadTheme()
    const theme = useTheme()

    theme.setTheme('custom')
    await Promise.resolve()
    expect(document.documentElement.style.getPropertyValue('--color-bg-page')).not.toBe('')

    theme.setTheme('light')
    await Promise.resolve()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.style.getPropertyValue('--color-bg-page')).toBe('')
  })

  it('保存低对比度自定义主题，保留用户的颜色选择', async () => {
    stubMatchMedia(true)
    const { useTheme } = await loadTheme()
    const theme = useTheme()
    const colors = { background: '#FFFFFF', foreground: '#FFFFFF', accent: '#FFFFFF' }

    expect(theme.setCustomTheme(colors)).toBe(true)
    expect(localStorage.getItem('app-custom-theme')).toBe(JSON.stringify(colors))
    expect(theme.customTheme.value).toEqual(colors)

    const reloaded = await loadTheme()
    const reloadedTheme = reloaded.useTheme()
    expect(reloadedTheme.customTheme.value).toEqual(colors)

    reloadedTheme.setTheme('custom')
    await Promise.resolve()
    expect(document.documentElement.style.getPropertyValue('--color-bg-page')).toBe(
      colors.background
    )
  })

  it('存着的旧配色预设名一律回落到跟随系统', async () => {
    // 以前存的是 default/deep-blue/aurora 这些配色预设，那套已经删了。
    // 读到不认识的值不能原样用，否则 data-theme 会被写成一个没有样式的值。
    localStorage.setItem('app-theme', 'deep-blue')
    stubMatchMedia(true)
    const { useTheme } = await loadTheme()
    const { themePreference, currentTheme } = useTheme()

    expect(themePreference.value).toBe('system')
    expect(currentTheme.value).toBe('dark')
  })

  it('toggleTheme 从跟随系统切到跟系统相反的那个', async () => {
    stubMatchMedia(true)
    const { useTheme } = await loadTheme()
    const { toggleTheme, themePreference, currentTheme } = useTheme()

    expect(currentTheme.value).toBe('dark')
    toggleTheme()
    await Promise.resolve()

    expect(themePreference.value).toBe('light')
    expect(currentTheme.value).toBe('light')
  })

  it('把实际生效的主题实时同步给任务栏图标', async () => {
    const media = stubMatchMedia(false)
    const setThemeIcon = vi.fn().mockResolvedValue({ success: true, data: true })
    ;(window.api as unknown as { appSettings: unknown }).appSettings = { setThemeIcon }
    const { syncAppIconTheme } = await loadTheme()

    const stop = syncAppIconTheme()
    expect(setThemeIcon).toHaveBeenLastCalledWith('light')

    media.fire(true)
    await Promise.resolve()
    expect(setThemeIcon).toHaveBeenLastCalledWith('dark')
    stop()
  })

  it('图标同步失败不阻断主题切换', async () => {
    stubMatchMedia(true)
    const setThemeIcon = vi
      .fn()
      .mockResolvedValue({ success: false, data: false, error: 'setIcon failed' })
    ;(window.api as unknown as { appSettings: unknown }).appSettings = { setThemeIcon }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { syncAppIconTheme } = await loadTheme()

    const stop = syncAppIconTheme()
    await Promise.resolve()
    await Promise.resolve()

    expect(warn).toHaveBeenCalledWith('同步应用图标主题失败:', expect.any(Error))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    stop()
  })
})

const luminance = (hex: string): number => {
  const channel = (i: number): number => {
    const x = parseInt(hex.slice(i, i + 2), 16) / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/**
 * 提示气泡（tooltip）的底色和文字色是**成对**的，改一个不改另一个就出事。
 *
 * 实际发生过：全局 CSS 把 .ant-tooltip-inner 的背景 !important 成了
 * --color-bg-raised（浅色主题下是纯白），但文字色还是 antd 默认的
 * colorTextLightSolid（白）—— 浅色主题下的提示气泡就是一个空白方块，
 * 鼠标悬停上去什么都看不到。
 *
 * 这一组守两件事：配色必须成对给，而且给完要真的够读。
 */
describe('提示气泡配色', () => {
  it.each(['light', 'dark'] as const)('%s 主题下气泡文字压在气泡底上够读', async (mode) => {
    stubMatchMedia(mode === 'dark')
    const { themeConfigs } = await loadTheme()
    const tooltip = themeConfigs[mode].components?.Tooltip

    // 底色和文字色必须成对给 —— 只给一个正是当初那个空白方块的成因
    expect(tooltip?.colorBgSpotlight).toMatch(/^#[0-9a-f]{6}$/i)
    expect(tooltip?.colorTextLightSolid).toMatch(/^#[0-9a-f]{6}$/i)
    expect(
      contrast(tooltip!.colorTextLightSolid as string, tooltip!.colorBgSpotlight as string)
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('不把 colorTextLightSolid 改成全局 token —— 那会让主按钮上的白字跟着变', async () => {
    stubMatchMedia(false)
    const { themeConfigs } = await loadTheme()
    // 全局那个是给「实心彩色填充上的字」用的，必须保持 antd 默认的白
    expect(themeConfigs.light.token?.colorTextLightSolid).toBeUndefined()
    expect(themeConfigs.dark.token?.colorTextLightSolid).toBeUndefined()
  })
})

/**
 * 复选框只有一种长相 —— 而且未选中的时候必须看得见。
 *
 * 未选中的方框全靠一圈描边被看见。全局 colorBorder 走 --color-border，
 * 在深色卡片上只有 2.1:1，达不到 WCAG 1.4.11 对控件边界的 3:1，方框就那么没了。
 * 各页面于是各打各的补丁：侧边栏自定义、资产筛选面板、笔记来源面板三份。
 * 其中侧边栏那份顺手把**选中态**也改成了灰底 —— 而对勾是白的，
 * 于是勾上跟没勾长得一样。用户报的就是这个。
 *
 * 所以描边在 buildComponents 里修一次，页面里一处补丁都不留。
 */
describe('复选框', () => {
  it.each(['light', 'dark'] as const)('%s 主题下未选中的方框边界过 3:1', async (mode) => {
    stubMatchMedia(mode === 'dark')
    const { themeConfigs } = await loadTheme()
    const { palette } = await import('@renderer/assets/styles/palette.generated')
    const border = themeConfigs[mode].components?.Checkbox?.colorBorder as string

    expect(border).toMatch(/^#[0-9a-f]{6}$/i)
    // 方框底是透明的，所以它压在的是卡片和页面这两种底色
    expect(contrast(border, palette[mode].bgSurface)).toBeGreaterThanOrEqual(3)
    expect(contrast(border, palette[mode].bgPage)).toBeGreaterThanOrEqual(3)
  })

  it.each(['light', 'dark'] as const)('%s 主题下选中态的对勾压在填充上够看', async (mode) => {
    stubMatchMedia(mode === 'dark')
    const { themeConfigs } = await loadTheme()
    const { palette } = await import('@renderer/assets/styles/palette.generated')
    const checked = themeConfigs[mode].components?.Checkbox?.colorPrimary as string

    // 复选框保留蓝色选中态，不跟着全局中性 accent 变灰。
    expect(checked).toBe(palette[mode].switchChecked)
    const [red, green, blue] = [1, 3, 5].map((index) =>
      Number.parseInt(checked.slice(index, index + 2), 16)
    )
    expect(blue).toBeGreaterThan(red)
    expect(blue).toBeGreaterThan(green)
    expect(contrast('#ffffff', checked)).toBeGreaterThanOrEqual(3)
  })

  it('没有页面自己改复选框的方框样式，也没有原生 checkbox', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { execSync } = await import('node:child_process')
    const { resolve } = await import('node:path')
    const root = process.cwd()
    // -c 已跟踪 + -o 未跟踪，一次 spawn 拿全。分成两条命令跑的话在 Windows 上
    // 光进程启动就多花近 400ms，而这条用例本来就是这个文件里第二慢的。
    const files = execSync('git ls-files -c -o --exclude-standard src/renderer/src', {
      cwd: root,
      encoding: 'utf8'
    })
      .split('\n')
      .filter((p) => /\.(vue|css|less)$/.test(p) && existsSync(resolve(root, p)))

    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(resolve(root, file), 'utf8')
      // .ant-checkbox-inner 就是那个方框本身。改它 = 绕过统一的主题 token
      if (/\.ant-checkbox-inner/.test(text)) offenders.push(`${file}: 改了 .ant-checkbox-inner`)
      // 原生 checkbox 完全不认主题，深浅色下各长各的
      if (/type="checkbox"/.test(text)) offenders.push(`${file}: 原生 <input type="checkbox">`)
    }

    expect(offenders).toEqual([])
  })
})
