import {
  createRouter,
  createWebHashHistory,
  START_LOCATION,
  type NavigationGuard,
  type RouteLocationNormalized,
  type RouteLocationRaw
} from 'vue-router'
import routesDefault from './modules'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { useAppInfo } from '@renderer/hooks/useAppInfo'
import { installPageLoading } from './pageLoading'

// 创建路由实例
import i18n, { hasExplicitLocale } from '@renderer/i18n'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [...routesDefault]
})

/**
 * 应用启动时的落点。
 *
 * 标签页是持久化的，所以开应用应当回到上次那一个；一个都没留下（用户把标签全关了、
 * 或者第一次装）才落到项目库。项目库不再是钉死的固定标签，这条兜底是它唯一的特殊待遇。
 *
 * 两个条件缺一不可：
 *   - `from === START_LOCATION`：只有整个应用的第一次导航算「启动」，
 *     之后再点侧边栏的项目库不能被改道到别处；
 *   - `to.fullPath === '/'`：只接管「不带路径直接开」，协议唤起和深链
 *     带着明确目的地，不许动。
 * 语言必选门那一跳去的是 `/language`，被第二个条件挡住，选完语言再回来时
 * `from` 已经不是 START_LOCATION —— 首次安装本来也没有标签可恢复。
 */
function resolveStartupRedirect(
  to: RouteLocationNormalized,
  from: RouteLocationNormalized
): RouteLocationRaw | null {
  if (from !== START_LOCATION || to.fullPath !== '/') return null

  const target = useTabsStore().resolveStartupTab()
  if (!target || target === to.fullPath) return null

  // 持久化里可能留着已经被删掉的路由，认不出来就老老实实待在项目库
  const resolved = router.resolve(target)
  if (resolved.matched.length === 0) return null

  // 独立窗口（Spotlight、MiniChat 之类）不是主窗口的落点。
  // 它们本不该进标签列表，但历史数据里混进去过，别把主窗口开成一个搜索条
  if (resolved.meta.standalone) return null

  return { path: resolved.path, query: resolved.query, hash: resolved.hash, replace: true }
}

/**
 * 核心前置守卫：设置标题、语言必选门、启动落点。
 *
 * 这里**没有认证门，也没有区域闸门**，将来也不要加回来。路由表里曾经每条都写着
 * `requiresAuth`，但从来没有守卫读过它 —— 那是商业版留下的空壳，一整套账号与区域
 * 判断的挂载点。现在字段和挂载点一起删了：这个应用装完就能用全部本地功能，
 * 不认账号，也不看用户在哪个国家。
 */
const coreBeforeEach: NavigationGuard = async (to, from, next) => {
  // 获取应用信息
  const { formattedAppName } = useAppInfo()

  // 设置页面标题
  //
  // 这里必须吞掉异常：翻译只是标题，失败不该中止导航。
  // 曾因 vue-i18n 运行时编译撞上打包页面的 CSP 抛 EvalError，
  // 导致首次导航被中止、整个应用白屏。
  const titleKey = to.meta.title as string
  try {
    document.title = titleKey ? i18n.global.t(titleKey) : formattedAppName
  } catch (error) {
    console.warn('[Router] 设置页面标题失败，回退为应用名:', error)
    document.title = formattedAppName
  }

  // Spotlight 独立窗口不需要认证
  if (to.meta.standalone) {
    next()
    return
  }

  // 语言必选门：未显式选过语言时，一切业务路由都先拦到 /language。
  if (!hasExplicitLocale() && to.path !== '/language') {
    next({ path: '/language' })
    return
  }

  // 启动落点：回到上次开着的标签页，没有才留在项目库。
  // 必须排在语言门**之后** —— 没选过语言时先去 /language，标签的事等选完再说。
  const startupTarget = resolveStartupRedirect(to, from)
  if (startupTarget) {
    next(startupTarget)
    return
  }

  next()
}

function installCoreGuards(): void {
  router.beforeEach(coreBeforeEach)
}

installPageLoading(router)
installCoreGuards()

// 全局后置守卫
router.afterEach((to, from) => {
  // 路由跳转后的操作，例如关闭加载动画、记录访问日志等
  console.log(`路由从 ${from.fullPath} 跳转到 ${to.fullPath}`)

  // 使用tabs store管理标签页
  const tabsStore = useTabsStore()
  const added = tabsStore.addTab(to)
  if (added) {
    tabsStore.setActiveTab(added)
  }

  // 这里可以添加其他后置操作，如记录访问日志、埋点等
})

export default router
