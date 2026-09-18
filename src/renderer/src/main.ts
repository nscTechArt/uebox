/**
 * -- Browser Environment Polyfill --
 * This prevents the application from crashing when running in a standard browser
 * by mocking the Electron IPC and API objects.
 */
if (typeof window !== 'undefined' && !window.electron) {
  console.warn('[Polyfill] Non-Electron environment detected. Injecting mock APIs.')
  ;(window as any).electron = {
    ipcRenderer: {
      on: (channel: string, _func: Function) => console.log(`[IPC Mock] Listen on: ${channel}`),
      removeListener: (_channel: string, _func: Function) => {},
      send: (channel: string, ...args: any[]) =>
        console.log(`[IPC Mock] Send to: ${channel}`, args),
      invoke: (channel: string, ...args: any[]) => {
        console.log(`[IPC Mock] Invoke: ${channel}`, args)
        return Promise.resolve()
      }
    }
  }
  ;(window as any).api = {
    on: (_channel: string, _func: Function) => {},
    off: (_channel: string, _func: Function) => {},
    send: (_channel: string, ..._args: any[]) => {},
    invoke: (_channel: string, ..._args: any[]) => Promise.resolve(),
    system: { getInfo: () => Promise.resolve({ isWindows11: true }) },
    oauth: {
      startWechat: () => Promise.resolve(),
      onWechatCallback: (_cb: any) => () => {},
      startGoogle: () => Promise.resolve(),
      onGoogleCallback: (_cb: any) => () => {},
      startGithub: () => Promise.resolve(),
      onGithubCallback: (_cb: any) => () => {}
    },
    window: {
      minimize: () => {},
      maximize: () => {},
      close: () => {},
      onMaximized: () => () => {},
      onUnmaximized: () => () => {}
    },
    screenshot: {
      enterMode: () => Promise.resolve(),
      onModeChanged: () => () => {},
      onEnterViaShortcut: () => () => {}
    },
    appSettings: {
      getLanguage: () => Promise.resolve('zh-CN'),
      setLanguage: () => Promise.resolve(),
      setThemeIcon: () => Promise.resolve({ success: true, data: true }),
      getColorTheme: () => Promise.resolve('default')
    }
  }
}

if (window.location.hash.includes('spotlight')) {
  document.documentElement.classList.add('spotlight-window')
}

import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
// 导入pinia实例
import pinia from './store'
// 导入路由类型定义
import './types/router'
// 导入i18n配置
import i18n, { setLocale, getLocale } from './i18n'
// 导入ant-design-vue
import Antd from 'ant-design-vue'
import 'ant-design-vue/dist/reset.css'
// 导入 Ant Design 样式覆盖
import './assets/styles/antd-override.css'
// 导入 Agent 事件分发器
import { initAgentEventDispatcher } from './views/Assistant/composables/agentEventDispatcher'
import { initApprovalModeSync } from './views/Assistant/composables/approvalModeSync'
import { initAgentReattach } from './views/Assistant/composables/agentReattach'
import { chatHistoryStorage } from './utils/chatHistoryStorage'
import { syncAppIconTheme } from './hooks/useTheme'
import { initMotionPreference } from './hooks/useMotionPreference'

const app = createApp(App)

/**
 * Phosphor 图标的全局默认尺寸。
 *
 * 换掉 Ant Design 之后不能只换形状 —— 两套图集的「墨迹占框比例」不一样：
 * 实测同样标称尺寸下，antd 平均占到框的 0.957，Phosphor 只占 0.818。
 * 也就是说照搬原来的字号，每个图标都会小掉约 17%，整个界面看着都虚了。
 *
 * Phosphor 组件用 `inject('size')` 取默认值（默认 '1em'），显式传 :size 的地方不受影响，
 * 用 CSS 写死 width/height 的地方也不受影响 —— 所以这一行只补偿那些「跟着字号走」的位置。
 */
app.provide('size', '1.15em')

// 初始化 Agent 事件分发器（全局单例，只注册一次 IPC 监听器）
initAgentEventDispatcher()

// 使用路由
app.use(router)
// 使用pinia
app.use(pinia)

// 使用i18n
app.use(i18n)
// 使用ant-design-vue
app.use(Antd)

// 初始化ant-design-vue语言包
const savedLocale = getLocale()
setLocale(savedLocale)

// 任务栏和托盘图标跟随实际生效的亮/暗主题（含“跟随系统”）。
syncAppIconTheme()

// 动效开关写到 <html data-motion> 上。必须在 mount 之前 —— 晚一步首帧就会
// 带着动画闪一下，而「减少动效」的用户看到的正是他想避开的那个东西
initMotionPreference()

// 同步语言设置到 main 进程，供 Agent 使用
// 这确保即使用户在之前的会话中更改了语言，main 进程也能获取到正确的设置
window.api?.appSettings?.setLanguage(savedLocale as 'zh-CN' | 'en-US').catch((err: Error) => {
  console.warn('初始化时同步语言设置到主进程失败:', err)
})

// 对话历史存在磁盘上（见 utils/chatHistoryStorage.ts），而 pinia 的 storage 接口
// 是同步的 —— 必须先把它读进内存，再让任何人碰 store。initAgentReattach 起手就读
// 对话缓存，顺序错了它只会看到一片空历史，然后把还在跑的会话判成中断。
void chatHistoryStorage.preload().finally(() => {
  // 审批档位改动实时送到主进程，让运行中的会话也跟着变（必须在 pinia 之后）
  initApprovalModeSync()
  // 刷新页面不会停掉 agent（它跑在主进程）—— 问一次主进程谁还活着，把界面接回去
  void initAgentReattach()

  app.mount('#app')
})

// 避免“窗口置前/聚焦”时把上一次聚焦的控件高亮（聚焦框）也一并带出来（尤其是 Windows）。
// 主进程在 second-instance 等场景会发送该事件，这里统一 blur 掉当前 activeElement。
window.api?.on?.('app:blur-active-element', () => {
  const el = document.activeElement as HTMLElement | null
  if (el && typeof (el as unknown as { blur?: () => void }).blur === 'function') {
    ;(el as unknown as { blur: () => void }).blur()
  }
})
