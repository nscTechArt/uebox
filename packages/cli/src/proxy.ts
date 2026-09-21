/**
 * 「代理会不会拦住 UE 到盒子的本机连接」这一项体检。
 *
 * ## 为什么 doctor 要管 UE 进程的代理
 *
 * 引擎的 Lws WebSocket 实现给**所有** ws 连接套 HTTP 代理，不对 localhost 例外。
 * 机器上有系统代理或 HTTP_PROXY 时，UE 连 `ws://127.0.0.1:17860` 也会被送进代理，
 * 代理拒绝 —— 盒子那头就是「0 个工程」。
 *
 * 而 CLI 自己走的是 Node 的 WebSocket，它不认这些代理变量，所以 CLI 连盒子照样
 * 通畅：**doctor 全绿，连接却是断的**。2026-09-21 那一轮排查就卡在这个错觉上，
 * 用户先去重装插件、停用别的 MCP，没人怀疑代理。这是 doctor 的漏检，不是用户的
 * 判断力问题。
 *
 * ## 为什么只查环境变量
 *
 * 系统代理（Windows Internet 选项那份）读不到这里 —— 要么起子进程 `reg query`，
 * 要么加个原生依赖，两样都不值得在一个提示上花。插件那边用
 * `FPlatformHttp::GetConfiguredProxyAddress()` 问的是 Lws 实际读的那个来源，
 * 系统代理由它兜（见 UAL_ProxyDiagnostics.h）。这里只负责 CLI 够得着的那一半：
 * 环境变量。查不到不等于没有，所以这一项永远只是 warning，不判失败。
 */

/** 按 curl / libwebsockets 的惯例，大写优先 */
function readVar(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name.toUpperCase()] ?? env[name.toLowerCase()] ?? '').trim()
}

function isLoopbackHost(host: string): boolean {
  const lower = host.trim().toLowerCase()
  return lower === 'localhost' || lower === '::1' || lower === '[::1]' || lower.startsWith('127.')
}

/** NO_PROXY 里排掉了回环就当没风险。回环的几种写法互相等价 */
function noProxyCoversLoopback(noProxy: string): boolean {
  return noProxy
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .some((entry) => entry === '*' || isLoopbackHost(entry))
}

export interface LoopbackProxyRisk {
  /** 哪个变量命中的，原样报出来 —— 用户要去清的就是它 */
  variable: string
  value: string
}

/**
 * 进程环境里有没有会作用于本机连接的代理。没有就返回 `null`。
 *
 * 注意这查的是**当前进程**的环境。UE 编辑器是另一个进程，它的环境可能不同 ——
 * 不过这两个进程通常都是同一个用户会话起的，所以这个信号在实践里够用。
 */
export function detectLoopbackProxy(env: NodeJS.ProcessEnv): LoopbackProxyRisk | null {
  if (noProxyCoversLoopback(readVar(env, 'NO_PROXY'))) return null

  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    const value = readVar(env, name)
    if (value) {
      const variable = env[name] !== undefined ? name : name.toLowerCase()
      return { variable, value }
    }
  }
  return null
}

/** 拼成给人看的一段话（含解法）。给 doctor 的 hint 用 */
export function describeLoopbackProxyRisk(risk: LoopbackProxyRisk): string {
  return (
    `另外：检测到 ${risk.variable}=${risk.value}。引擎的 WebSocket 不对 localhost 例外，` +
    'UE 连本机的盒子也会走这个代理，被拒绝后同样表现为「0 个工程」。' +
    '启动编辑器时加 -ini:Engine:[HTTP]:HttpProxyAddress= ，' +
    '并在该进程环境里清掉 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY（大小写两种都要），' +
    '然后看 UE 日志里 bUseHttpProxy 是否变成 false。'
  )
}
