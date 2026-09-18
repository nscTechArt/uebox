import { session } from 'electron'

/**
 * 渲染层网络策略。
 *
 * 社区版承诺完全离线可用、不依赖官方服务器。`scripts/verify-offline-boot.mjs`
 * 在打包产物上逐路由核验这一点，是主门禁；本模块是**运行时兜底**，用来在真实使用
 * 中发现门禁覆盖不到的路径（用户操作触发、而非页面加载触发的请求）。
 *
 * 关于「为什么默认不拦截」：
 * 社区版有合法的对外请求 —— 百度网盘走渲染层 axios（用户自建应用）、
 * 用户自填的 BYOK 端点、笔记本读取用户给的网页。一刀切拦截会砍掉真实功能。
 * 因此默认是**观察模式**：命中即告警并计数，不取消请求。等白名单与真实用法
 * 对齐之后，再由调用方显式开启 enforce。
 *
 * ## 它看不到 Agent 浏览器
 *
 * 这里挂的是 `session.defaultSession`，而 Agent 浏览器跑在自己的分区
 * （`persist:unreal-box-agent-browser`）。那是**故意的**：那个窗口的用途就是
 * 用户逐次批准之后去访问任意公网网页，用「社区版不该联网」的判据去衡量它没有
 * 意义，它也不是对官方服务端的调用。
 *
 * 那个分区自己的安全策略（协议、私网、权限、下载、弹窗）在
 * `services/agentBrowser/index.ts` 里安装。
 *
 * **将来把这里切成 enforce 时，必须显式处理那个分区**，不能假设
 * `defaultSession` 已经覆盖到了 —— 它从来没有。
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

const LOCAL_PROTOCOLS = new Set([
  'file:',
  'data:',
  'blob:',
  'devtools:',
  'chrome-extension:',
  'local-resource:',
  'uebox-asset:',
  'uebox:'
])

/**
 * 社区版允许的用户集成来源。
 *
 * 这些都是**用户自己配置或自己触发**的第三方服务，不是官方后端：
 * 百度网盘要求用户在百度开放平台自建应用后填入 AppKey/SecretKey。
 *
 * 新增用户集成时把它的 origin 加到这里；不加就会在观察模式下被告警。
 */
const USER_INTEGRATION_HOSTS = new Set(['openapi.baidu.com', 'pan.baidu.com', 'd.pcs.baidu.com'])

export type NetworkPolicyOptions = Readonly<{
  /** true = 取消请求；false（默认）= 只告警不拦截 */
  enforce?: boolean
  /** 额外放行的判定，用于用户在设置里自填的端点（如 BYOK base URL） */
  isUserConfiguredEndpoint?: (url: URL) => boolean
}>

export function isLocalOnlyUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return LOCAL_PROTOCOLS.has(url.protocol) || LOCAL_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function isUserIntegrationUrl(rawUrl: string): boolean {
  try {
    return USER_INTEGRATION_HOSTS.has(new URL(rawUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** 观察模式下累计的越界请求，供诊断与测试读取 */
const observedExternalRequests = new Set<string>()

export function getObservedExternalRequests(): readonly string[] {
  return [...observedExternalRequests]
}

export function resetObservedExternalRequests(): void {
  observedExternalRequests.clear()
}

/**
 * 安装社区版网络策略。
 */
export function installOfflineNetworkPolicy(options: NetworkPolicyOptions = {}): void {
  const { enforce = false, isUserConfiguredEndpoint } = options

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const { url } = details

    if (isLocalOnlyUrl(url) || isUserIntegrationUrl(url)) {
      callback({ cancel: false })
      return
    }

    if (isUserConfiguredEndpoint) {
      try {
        if (isUserConfiguredEndpoint(new URL(url))) {
          callback({ cancel: false })
          return
        }
      } catch {
        // URL 解析失败按未放行处理
      }
    }

    observedExternalRequests.add(url)
    console.warn(
      `[NetworkPolicy] 社区版出现外部请求${enforce ? '（已拦截）' : '（观察模式，未拦截）'}: ${url}`
    )
    callback({ cancel: enforce })
  })
}

/**
 * 校验用户显式提供的外部端点（BYOK、自建 Vault 等）。
 *
 * 明文 HTTP 与 URL 内嵌凭据一律拒绝。
 */
export function assertExplicitExternalEndpoint(rawUrl: string): URL {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' && !isLocalOnlyUrl(url.toString())) {
    throw new Error('外部端点必须使用 HTTPS')
  }
  if (url.username || url.password) {
    throw new Error('端点 URL 中不得内嵌凭据')
  }
  return url
}
