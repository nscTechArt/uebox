import { onBeforeUnmount, onMounted, shallowRef, type Ref } from 'vue'

/**
 * 「先订阅、再拉一次」这套生命周期，只此一份。
 *
 * 界面上凡是要跟着主进程变的东西都是这个形状：进来问一次当前值，之后靠推送更新，
 * 组件销毁时把订阅摘掉。抄一遍很容易，抄错也很容易 —— 全仓已经有六份手写的，
 * 其中三份把顺序写反了。
 *
 * ## 三件必须一起做对的事
 *
 * 1. **先订阅再拉。** 反过来的话，这两步之间发生的变化会被漏掉；更糟的是组件在
 *    `await` 期间被卸载时（切设置标签页就会），`onBeforeUnmount` 摘到的还是 null，
 *    订阅随后才建起来 —— 再也摘不掉，而且一声不吭。切十几次就是
 *    MaxListenersExceededWarning，每个还吊着一份已经丢弃的组件闭包。
 * 2. **推送优先于那份初始快照。** 先订阅带来的新问题：`fetch()` 还挂着的时候如果
 *    推送先到，等 `fetch()` 回来就会拿旧快照把新值盖掉。所以推送来过就不要再写了。
 * 3. **卸载要退订。** 见第 1 条。
 *
 * @returns 三态：`null` = 还没问到。**别把它当成「没有」** —— 那是一句没核实过的
 *   断言，而这恰恰是横幅和插件页都要避免的那类误报。
 */
function useLive<T>(
  tag: string,
  fetch: () => Promise<T>,
  subscribe: (onChange: (value: T) => void) => () => void
): Ref<T | null> {
  // shallowRef：这些值整个替换，从不就地改字段，不需要深层响应式
  const current = shallowRef<T | null>(null)
  let unsubscribe: (() => void) | null = null

  onMounted(async () => {
    let pushed = false
    // 两个 try 是分开的：订阅挂了不该连首拉一起放弃。合成一个的话，preload 只坏了
    // 订阅那一半时，界面连一次性的快照都拿不到，永远停在「还没问到」。
    try {
      unsubscribe = subscribe((value) => {
        pushed = true
        current.value = value
      })
    } catch (error) {
      console.warn(`[${tag}] 订阅失败（后续变化收不到）:`, error)
    }
    try {
      const initial = await fetch()
      // 推送已经来过就别用这份旧快照盖回去
      if (!pushed) current.value = initial
    } catch (error) {
      console.warn(`[${tag}] 读取失败:`, error)
    }
  })

  onBeforeUnmount(() => {
    unsubscribe?.()
    unsubscribe = null
  })

  return current
}

/** 引擎桥接此刻起没起、端口是多少、启动报了什么错。 */
export function useBridgeStatus(): Ref<BridgeStatus | null> {
  return useLive(
    'useBridgeStatus',
    () => window.api.websocket.getStatus(),
    (onChange) => window.api.websocket.onStatusChanged(onChange)
  )
}

/**
 * 此刻连着的工程。
 *
 * 两头都是 `getInteractiveProjects()`，所以初始值和后续推送口径一致 ——
 * 跑批的 commandlet 不算，和首页那个绿点是同一个数。
 *
 * 元素形状由 preload 的 `ConnectedProject` 定死，这里不再需要泛型，
 * 调用方也不用各写一份内联类型再 `as` 一次。
 *
 * `null` = 还没问到。四个调用方里只有插件设置页要区分它（数字位显示「—」
 * 而不是编一个 0），列表类的用 `?? []` 收掉就行。
 */
export function useConnectedProjects(): Ref<ConnectedProject[] | null> {
  return useLive(
    'useConnectedProjects',
    () => window.api.websocket.getProjects(),
    (onChange) => window.api.websocket.onProjectsChanged(onChange)
  )
}
