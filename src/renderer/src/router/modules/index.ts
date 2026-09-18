import { RouteRecordRaw } from 'vue-router'
import mainRoutes from './mainRoutes'
import systemRoutes from './systemRoutes'

/**
 * 首次启动语言必选门
 *
 * standalone: true 让全局守卫直接放行 —— 语言要在任何业务界面出现之前定下来，
 * 否则第一屏会用一个用户没选过的语言渲染。选完就落到项目库，没有下一道门。
 */
const languageGateRoute: RouteRecordRaw = {
  path: '/language',
  name: 'LanguageGate',
  component: () => import('@renderer/views/System/Onboarding/LanguageGate.vue'),
  meta: {
    /*
     * **故意不走语言包。** 这一屏是用户选语言之前看到的第一样东西 ——
     * 此刻 i18n 用的还是猜出来的默认值，翻译它等于用一个用户没选过的语言
     * 去问他要用哪种语言。英文是这里最可能被看懂的那一种。
     *
     * 其余 standalone 窗口的标题都必须是 i18n key，见 `routeTitles.test.ts`。
     */
    title: 'Choose your language',
    standalone: true,
    isShowInTab: false
  }
}

/**
 * Spotlight 独立窗口路由
 * 用于全局快捷键唤起的独立窗口
 */
const spotlightRoute: RouteRecordRaw = {
  path: '/spotlight',
  name: 'SpotlightWindow',
  component: () => import('@renderer/views/SpotlightWindow.vue'),
  meta: {
    title: 'Spotlight',
    standalone: true, // 标记为独立窗口，不走主窗口那套标题/语言门/启动落点
    isShowInTab: false // Spotlight 不应该显示在 tab 中，也不应该被持久化
  }
}

/**
 * Mini Chat 独立窗口路由
 * 用于极简 AI 对话窗口
 */
const miniChatRoute: RouteRecordRaw = {
  path: '/mini-chat',
  name: 'MiniChatWindow',
  component: () => import('@renderer/views/MiniChat/MiniChatWindow.vue'),
  meta: {
    /*
     * meta.title 是 **i18n key**，不是字面量 —— `router/index.ts` 拿它去 t()。
     * 这里原来写着「AI 助手」四个字，于是 t() 查不到、原样返回，
     * 英文用户的小窗标题栏上是一句中文。
     */
    title: 'profile.miniChat.windowTitle',
    standalone: true,
    isShowInTab: false
  }
}

/**
 * 屏幕录制选区独立窗口路由
 */
const selectionRoute: RouteRecordRaw = {
  path: '/screen-selection',
  name: 'ScreenSelection',
  component: () => import('@renderer/views/ScreenRecorder/SelectionOverlay.vue'),
  meta: {
    title: 'screenRecorderPanel.windowTitles.selection',
    standalone: true,
    isShowInTab: false
  }
}

const quickRecorderRoute: RouteRecordRaw = {
  path: '/screen-recorder-quick',
  name: 'ScreenRecorderQuick',
  component: () => import('@renderer/views/ScreenRecorder/ScreenRecorderQuickWindow.vue'),
  meta: {
    title: 'screenRecorderPanel.windowTitles.quick',
    standalone: true,
    isShowInTab: false
  }
}

// 导出所有路由模块
const routes: Array<RouteRecordRaw> = [
  {
    path: '/agent-browser',
    name: 'AgentBrowserWindow',
    component: () => import('@renderer/views/Assistant/AgentBrowserWindow.vue'),
    meta: { title: 'assistant.browserPane.title', standalone: true, isShowInTab: false }
  },
  mainRoutes,
  ...systemRoutes,
  languageGateRoute,
  spotlightRoute,
  miniChatRoute,
  selectionRoute,
  quickRecorderRoute
]

export { routes }
export default routes
