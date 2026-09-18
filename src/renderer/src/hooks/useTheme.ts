import { ref, computed, watch, type ComputedRef, type WatchStopHandle } from 'vue'
/**
 * 这里只要两个算法函数，就只引这两个模块 —— 别写 `import { theme } from 'ant-design-vue'`。
 *
 * 顶层桶文件会把整个组件库（几千个模块）拉进来。实测单测里
 * `import('ant-design-vue')` 要 11.4 秒，useTheme.test.ts 的第一条用例就因此撞上
 * 10 秒的 testTimeout —— 表现为「全量门禁偶尔红一条，单独重跑又是绿的」。
 *
 * 退一步引 `ant-design-vue/es/theme` 也不够：那个桶带着 useToken / ConfigProvider
 * 上下文那一整套（首次 1.4 秒，每次 vi.resetModules 之后还要 235 毫秒重跑一遍），
 * 而我们一个都用不上。直接引两个算法模块是 73 毫秒 / 52 毫秒。
 *
 * 引的就是 `es/theme/index.js` 里 `defaultAlgorithm` / `darkAlgorithm` 的同一份模块，
 * 运行时行为完全一致。
 */
import defaultAlgorithm from 'ant-design-vue/es/theme/themes/default'
import darkAlgorithm from 'ant-design-vue/es/theme/themes/dark'
import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context'

import { palette } from '@renderer/assets/styles/palette.generated'
import type { ThemeRoles } from '@renderer/assets/styles/palette.generated'
import { appSettingsAPI } from '@renderer/api/appSettings'
import {
  CUSTOM_THEME_VARIABLE_NAMES,
  DEFAULT_CUSTOM_THEME,
  resolveCustomTheme,
  validateCustomTheme,
  type CustomThemeColors
} from './customTheme'

type ThemeMode = 'light' | 'dark'
type ThemePreference = 'system' | ThemeMode | 'custom'
type RuntimeThemeRoles = { readonly [K in keyof ThemeRoles]: string }

interface ThemeState {
  mode: ThemeMode
  config: ThemeConfig
}

/**
 * ant-design-vue 的主题配置。
 *
 * 颜色一律从 palette.generated.ts 取，不在这里写第二份。
 * 以前这里手抄了一遍 —— 抄的时候把亮色主题的 colorText 抄成了 #FFFFFF，
 * 于是「明亮模式」是白底白字，切过去等于瞎了。共用一份就不会再出这种事。
 */
function buildTokens(c: RuntimeThemeRoles): ThemeConfig['token'] {
  return {
    // 字体
    fontFamily: "'Segoe UI Variable', 'Segoe UI', sans-serif",
    fontSize: 14,
    fontSizeLG: 18,
    fontSizeSM: 12,
    fontSizeXL: 20,
    fontWeightStrong: 600,
    lineHeight: 1.5,
    lineHeightLG: 1.5,
    lineHeightSM: 1.5,

    // 强调色。solid 是实心按钮底色（白字过 4.5:1），text 是链接和图标用的那档。
    colorPrimary: c.accentSolid,
    colorPrimaryBg: c.accentBg,
    colorPrimaryBgHover: c.accentBg,
    colorPrimaryBorder: c.accentBorder,
    colorPrimaryBorderHover: c.accentBorder,
    colorPrimaryHover: c.accentSolidHover,
    colorPrimaryActive: c.accentSolid,
    colorPrimaryText: c.accentText,
    colorPrimaryTextHover: c.accentText,
    colorPrimaryTextActive: c.accentText,

    // 状态色。info 单独一条色阶已经删了 —— 全仓库没有一处真的用它表示「提示」，并入强调色。
    colorSuccess: c.successText,
    colorSuccessBg: c.successBg,
    colorSuccessBorder: c.successBorder,
    colorWarning: c.warningText,
    colorWarningBg: c.warningBg,
    colorWarningBorder: c.warningBorder,
    colorError: c.dangerText,
    colorErrorBg: c.dangerBg,
    colorErrorBorder: c.dangerBorder,
    colorInfo: c.accentText,
    colorInfoBg: c.accentBg,
    colorInfoBorder: c.accentBorder,

    // 文字
    colorTextBase: c.textPrimary,
    colorText: c.textPrimary,
    colorTextSecondary: c.textSecondary,
    colorTextTertiary: c.textMuted,
    colorTextQuaternary: c.textDisabled,
    colorTextDisabled: c.textDisabled,

    // 表面
    colorBgBase: c.bgPage,
    colorBgContainer: c.bgSurface,
    colorBgElevated: c.bgRaised,
    colorBgLayout: c.bgPage,
    colorBgSpotlight: c.bgRaised,
    colorBgMask: c.scrim,

    // 描边。controls 的边界要过 3:1，所以用 border 而不是更淡的 borderSubtle。
    colorBorder: c.border,
    colorBorderSecondary: c.borderSubtle,

    // 填充
    colorFill: c.bgSurfaceHover,
    colorFillSecondary: c.bgSurfaceHover,
    colorFillTertiary: c.bgSurface,
    colorFillQuaternary: c.bgSurface,

    // 圆角
    borderRadius: 8,
    borderRadiusLG: 12,
    borderRadiusSM: 4,
    borderRadiusXS: 2,

    // 动效
    motionDurationFast: '150ms',
    motionDurationMid: '250ms',
    motionDurationSlow: '350ms',

    // 间距
    padding: 16,
    paddingLG: 24,
    paddingSM: 12,
    paddingXS: 8,
    paddingXXS: 4,
    margin: 16,
    marginLG: 24,
    marginSM: 12,
    marginXS: 8,
    marginXXS: 4
  }
}

/**
 * 组件级 token。只有全局 token 会把别处带歪时才写到这里。
 *
 * Tooltip：它的文字色走的是 `colorTextLightSolid` —— 那个 token 的本意是
 * 「实心彩色填充上的字」（主按钮、徽标、开关），永远是白的。全局改成正文色的话，
 * 蓝色主按钮上的字会跟着变黑。所以只在 Tooltip 这一个组件上覆盖。
 *
 * 不改的后果实测过：底色被我们指到 `--color-bg-raised`（浅色主题下是纯白），
 * 文字还是白的 —— 浅色主题下的提示气泡就是一个空白方块。
 *
 * Checkbox：未选中的方框全靠一圈描边被看见。全局 `colorBorder` 走的是
 * `--color-border`，在深色卡片上只有 2.1:1，达不到 WCAG 1.4.11 对控件边界的 3:1 ——
 * 方框就那么消失了。这条以前是各页面自己打补丁的（侧边栏自定义、资产筛选、来源面板
 * 各写各的），其中一处顺手把**选中态**也改成了灰底，而对勾是白的 ——
 * 于是勾上了跟没勾一样。所以改成在这里修一次，各页面的补丁全删掉。
 * 全局 colorBorder 不能动：它同时管输入框、卡片描边，整体加重会显脏。
 */
function buildComponents(c: RuntimeThemeRoles): ThemeConfig['components'] {
  return {
    Tooltip: {
      colorBgSpotlight: c.bgRaised,
      colorTextLightSolid: c.textPrimary
    },
    Checkbox: {
      // 黑白灰主题里保留蓝色选中态，避免已勾选看起来像禁用。
      colorPrimary: c.switchChecked,
      colorPrimaryHover: c.switchCheckedHover,
      colorBorder: c.borderStrong,
      // 方框底色跟着行走。写死一个表面色的话，行 hover 变色时方框里会露出一块更暗的方。
      colorBgContainer: 'transparent'
    }
  }
}

function buildThemeConfig(mode: ThemeMode, colors: RuntimeThemeRoles): ThemeConfig {
  return {
    algorithm: mode === 'dark' ? darkAlgorithm : defaultAlgorithm,
    token: buildTokens(colors),
    components: buildComponents(colors)
  }
}

const themeConfigs: Record<ThemeMode, ThemeConfig> = {
  light: buildThemeConfig('light', palette.light),
  dark: buildThemeConfig('dark', palette.dark)
}

const STORAGE_KEY = 'app-theme'
const CUSTOM_STORAGE_KEY = 'app-custom-theme'

/**
 * 用户选的（偏好）和实际生效的（主题）是两件事。
 *
 *   ThemePreference  用户在设置里选的：跟随系统 / 浅色 / 深色 / 自定义
 *   ThemeMode        算出来实际用哪套：浅色 / 深色
 *
 * 选「跟随系统」时，实际主题由 prefers-color-scheme 决定，而且要能跟着变 ——
 * 用户在 Windows 设置里切了深浅色，应用得当场跟上，不能等重启。
 */
const preference = ref<ThemePreference>(loadPreference())
const customTheme = ref<CustomThemeColors>(loadCustomTheme())

function loadPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'system' || saved === 'light' || saved === 'dark' || saved === 'custom') {
      return saved
    }
  } catch (error) {
    console.warn('读取主题偏好失败，回退到跟随系统:', error)
  }
  return 'system'
}

function loadCustomTheme(): CustomThemeColors {
  try {
    const saved = localStorage.getItem(CUSTOM_STORAGE_KEY)
    if (saved) {
      const validation = validateCustomTheme(JSON.parse(saved))
      if (validation.valid && validation.normalized) return validation.normalized
    }
  } catch (error) {
    console.warn('读取自定义主题失败，回退到默认自定义主题:', error)
  }
  return { ...DEFAULT_CUSTOM_THEME }
}

/**
 * 主窗口和 Mini Chat 各有一份 Vue 运行时状态，但共用同一份 localStorage。
 * 主题在另一个窗口修改后，用浏览器原生 storage 事件把这一份状态也更新掉。
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === STORAGE_KEY) preference.value = loadPreference()
    if (event.key === null || event.key === CUSTOM_STORAGE_KEY) {
      customTheme.value = loadCustomTheme()
    }
  })
}

/** 系统当前是不是深色。matchMedia 在非浏览器环境（单测）里可能不存在。 */
const systemPrefersDark = ref(
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true
)

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', (event) => {
    systemPrefersDark.value = event.matches
  })
}

const resolvedCustomTheme = computed(() => resolveCustomTheme(customTheme.value))
const currentTheme = computed<ThemeMode>(() => {
  if (preference.value === 'system') return systemPrefersDark.value ? 'dark' : 'light'
  if (preference.value === 'custom') return resolvedCustomTheme.value.mode
  return preference.value
})

/**
 * 把主题写到根元素上。
 *
 * 全应用只有这一处写 data-theme —— 以前还有一套 data-color-theme 并行存在，
 * 两套机制同时改颜色，谁赢取决于 CSS 里谁写在后面，这是 bug 的温床。
 */
function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.setAttribute('data-theme', mode)
  for (const name of CUSTOM_THEME_VARIABLE_NAMES) root.style.removeProperty(name)
  if (preference.value === 'custom') {
    for (const [name, value] of Object.entries(resolvedCustomTheme.value.cssVariables)) {
      root.style.setProperty(name, value)
    }
  }
}

watch([currentTheme, preference, resolvedCustomTheme], () => applyTheme(currentTheme.value), {
  immediate: true
})

/** 把实际生效的主题同步给主进程，更新 Windows 任务栏与托盘图标。 */
export function syncAppIconTheme(): WatchStopHandle {
  return watch(
    currentTheme,
    (mode) => {
      void appSettingsAPI.setThemeIcon(mode).catch((error) => {
        console.warn('同步应用图标主题失败:', error)
      })
    },
    { immediate: true }
  )
}

interface UseThemeReturn {
  /** 实际生效的主题（'system' 已经解析成 light / dark） */
  currentTheme: ComputedRef<ThemeMode>
  /** 用户选的那个，含 'system'。设置面板要用它，别用 currentTheme。 */
  themePreference: ComputedRef<ThemePreference>
  customTheme: ComputedRef<CustomThemeColors>
  themeConfig: ComputedRef<ThemeConfig>
  themeState: ComputedRef<ThemeState>
  isDark: ComputedRef<boolean>
  isLight: ComputedRef<boolean>
  toggleTheme: () => void
  setTheme: (next: ThemePreference) => void
  setCustomTheme: (next: CustomThemeColors) => boolean
  getThemeIcon: () => 'sun' | 'moon'
  getThemeLabel: () => string
  initTheme: () => void
}

export const useTheme = (): UseThemeReturn => {
  const themeConfig = computed(() =>
    preference.value === 'custom'
      ? buildThemeConfig(resolvedCustomTheme.value.mode, resolvedCustomTheme.value.roles)
      : themeConfigs[currentTheme.value]
  )

  const themeState = computed<ThemeState>(() => ({
    mode: currentTheme.value,
    config: themeConfig.value
  }))

  /** 在浅色和深色之间切。当前是「跟随系统」时，切到跟系统相反的那个。 */
  const toggleTheme = (): void => {
    setTheme(currentTheme.value === 'light' ? 'dark' : 'light')
  }

  const setTheme = (next: ThemePreference): void => {
    preference.value = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch (error) {
      console.warn('保存主题偏好失败:', error)
    }
  }

  const setCustomTheme = (next: CustomThemeColors): boolean => {
    const validation = validateCustomTheme(next)
    if (!validation.valid || !validation.normalized) return false
    customTheme.value = validation.normalized
    try {
      localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(validation.normalized))
    } catch (error) {
      console.warn('保存自定义主题失败:', error)
    }
    return true
  }

  const isDark = computed(() => currentTheme.value === 'dark')
  const isLight = computed(() => currentTheme.value === 'light')

  const getThemeIcon = (): 'sun' | 'moon' => (currentTheme.value === 'light' ? 'sun' : 'moon')
  const getThemeLabel = (): string => (currentTheme.value === 'light' ? '明亮模式' : '暗黑模式')

  const initTheme = (): void => applyTheme(currentTheme.value)

  return {
    // 状态
    currentTheme: computed(() => currentTheme.value),
    /** 用户选的那个，含 'system'。设置面板要用它，别用 currentTheme。 */
    themePreference: computed(() => preference.value),
    customTheme: computed(() => customTheme.value),
    themeConfig,
    themeState,
    isDark,
    isLight,

    // 方法
    toggleTheme,
    setTheme,
    setCustomTheme,
    getThemeIcon,
    getThemeLabel,
    initTheme
  }
}

// 导出主题配置供其他地方使用
export {
  themeConfigs,
  type CustomThemeColors,
  type ThemeMode,
  type ThemePreference,
  type ThemeState
}
