import { describe, expect, it } from 'vitest'

/**
 * 单测环境不许发真实网络请求的守卫。
 *
 * ## 这条守的是什么
 *
 * happy-dom 默认会**真的**去加载 `<link rel=stylesheet>` 和 `<script src>`。
 * 组件里那种「运行时插一个静态资源标签」的写法（例如 BlueprintRenderer 加载
 * `ueblueprint` 的 css / js）在测试里会被解析成 happy-dom 的默认 origin
 * `http://localhost:3000/...`，于是每跑一次就往本机 3000 端口发一次 HTTP。
 *
 * 那个端口在测试里没人监听，结果是 ECONNREFUSED。多数时候只是被吞成 fetch 的
 * NetworkError，日志里刷一堆红字；但 `<script src>`（不带 async/defer）走的是
 * **同步**加载 —— happy-dom 会 spawn 一个 `node -e` 子进程去发请求，连接失败时
 * 那个 'error' 事件没人接，直接 `throw er`。偶发就会把 vitest 的 worker 一起
 * 带走，`pnpm verify` 卡死在单元测试这一步。
 *
 * 所以 vitest.config.ts 里把资源加载整个关掉了
 * （`disableCSSFileLoading` / `disableJavaScriptFileLoading`，配
 * `handleDisabledFileLoadingAsSuccess` 让 onload 分支照常走完）。
 * 这道门守的是那份配置别被人顺手删掉或改回去。
 *
 * ## 为什么这么断言
 *
 * 「没发请求」不好直接观测，但可以观测它的影子：真去发请求的话，load/error 只能
 * 等到 I/O 回来才派发，绝不可能在 `appendChild` 返回时就已经触发。所以
 * **同步就拿到 load** 等价于「压根没走网络」。
 */
describe('测试环境不加载外部资源', () => {
  it('<link rel=stylesheet> 不会真的去取样式表', () => {
    const events: string[] = []
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.addEventListener('load', () => events.push('load'))
    link.addEventListener('error', () => events.push('error'))
    link.href = 'http://localhost:3000/ueblueprint/css/ueb-style.min.css'

    document.head.appendChild(link)

    // appendChild 一返回就已经 load 完了 —— 没有任何 I/O 的余地
    expect(events).toEqual(['load'])
    // 而且确实没拿到内容：样式表是空的，不是从网上下下来的
    expect(link.sheet).toBeNull()

    link.remove()
  })

  it('<script src> 不会真的去取脚本', () => {
    const events: string[] = []
    const script = document.createElement('script')
    script.addEventListener('load', () => events.push('load'))
    script.addEventListener('error', () => events.push('error'))
    script.src = 'http://localhost:3000/ueblueprint/ueblueprint.js'

    document.head.appendChild(script)

    expect(events).toEqual(['load'])

    script.remove()
  })
})
