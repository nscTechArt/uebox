/**
 * 审批框停靠位。
 *
 * ## 为什么要这么一层
 *
 * 审批框本身必须挂在 `MainLayout`（应用级）：它拦下的操作可以从任何页面发起，
 * 比如库详情页点「放进当前工程」。挂在助手页里的话，助手页没有 keepAlive，
 * 切走就卸载，用户根本看不到这个框，只会在五分钟后收到一句「失败」。
 * 详见 [MainLayout.approvalMount.test.ts]。
 *
 * 可它的**位置**又该跟着对话走：从输入框上面顶起来，就在你刚打完字的地方。
 * 换成屏幕正中的弹窗，代价是遮住页面、还得先找到它。
 *
 * 这两件事只有一个解法：组件挂在应用级，内容 `<Teleport>` 到助手页提供的
 * 这个停靠位上。助手页在的时候顶在输入框上方，不在的时候退回窗口底部的浮层。
 *
 * ## 为什么是模块级的一个 ref，不是 provide/inject
 *
 * 提供方（助手页）和消费方（`MainLayout` 下的审批框）不在同一条组件链上 ——
 * 审批框是 `MainLayout` 的子节点，助手页是 `router-view` 的子节点，
 * inject 拿不到兄弟分支里的东西。
 */

import { shallowRef, type ShallowRef } from 'vue'

/**
 * 当前的停靠元素，`null` 表示没有（此时审批框走浮层形态）。
 *
 * `shallowRef` 而不是 `ref`：里面装的是 DOM 元素，深度响应式包装它没有意义，
 * 还会把整棵 DOM 子树拖进代理。
 */
const dock: ShallowRef<HTMLElement | null> = shallowRef(null)

/** 审批框那一侧：读停靠位 */
export function useApprovalDock(): ShallowRef<HTMLElement | null> {
  return dock
}

/**
 * 助手页那一侧：拿到一个函数 ref，绑在输入框上方那个空 div 上即可。
 *
 * 摘掉这一步不能省：助手页卸载后停靠元素已经离开文档，而 `<Teleport>`
 * 不会自己发现目标没了 —— 内容会留在一个脱离文档的节点上，屏幕上什么都没有。
 * Vue 在元素卸载时会用 `null` 回调函数 ref，摘除就挂在那一下上。
 */
export function provideApprovalDock(): (el: unknown) => void {
  /** 这个实例登记进去的那一个。清空时只认它，别人的不动 */
  let mine: HTMLElement | null = null

  return function setDock(el: unknown): void {
    if (el instanceof HTMLElement) {
      mine = el
      dock.value = el
      return
    }

    // 只摘自己那一个：路由切换时新旧页面的生命周期会交错，
    // 无条件清空会把新页面刚登记好的位置一起抹掉
    if (dock.value === mine) dock.value = null
    mine = null
  }
}
