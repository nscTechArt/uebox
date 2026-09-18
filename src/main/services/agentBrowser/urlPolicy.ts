/**
 * Agent 浏览器的 URL 与地址校验。
 *
 * 纯函数、不碰 Electron —— 因为这是整套浏览器能力里唯一一处「判断错了就出事」
 * 的逻辑，必须能单测到每个分支。窗口和 Session 在 `index.ts`。
 *
 * 覆盖的入口不止 `browser_open`：`will-navigate`、`will-redirect`、
 * `window.open` 和跟随链接全部走同一个函数。少接一个入口，页面就能用一次
 * 重定向把浏览器带到 `file://` 或内网去。
 */

/** 校验结果。`ok: false` 时 `reason` 直接进 `NAVIGATION_BLOCKED` 的错误文案 */
export type UrlCheckResult = { ok: true; url: URL } | { ok: false; reason: string }

/**
 * 只允许 http / https。
 *
 * 其余协议不是「暂不支持」而是**危险**：`file:` 读本机文件，`javascript:`
 * 在页面里执行任意脚本，`uebox:` 会被应用自己的深链接处理器接走 ——
 * 那等于让一个网页触发盒子内部的导入流程。
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** 本机与局域网域名后缀。`.local` 是 mDNS，`.localhost` 按标准恒定指向环回 */
const LOCAL_SUFFIXES = ['.localhost', '.local']

function isLoopbackName(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost') return true
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

function parseIPv4(hostname: string): number[] | null {
  const parts = hostname.split('.')
  if (parts.length !== 4) return null

  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

/**
 * IPv4 私网 / 保留段。
 *
 * 这里列的是 IANA 的特殊用途地址，不只是"三大私网段"：`169.254/16`
 * 是云环境的元数据地址（AWS 的 169.254.169.254 是最经典的 SSRF 目标），
 * `100.64/10` 是运营商级 NAT，`0/8` 在很多系统上等价于本机。
 */
function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets

  if (a === 0) return true // 0.0.0.0/8 —— 多数系统上等价于本机
  if (a === 10) return true // 10/8 私网
  if (a === 127) return true // 环回
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true // 链路本地 / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 私网
  if (a === 192 && b === 168) return true // 192.168/16 私网
  if (a === 192 && b === 0) return true // 192.0.0/24 与 192.0.2/24 保留
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 基准测试
  if (a === 198 && b === 51) return true // 198.51.100/24 文档用
  if (a === 203 && b === 0) return true // 203.0.113/24 文档用
  if (a >= 224) return true // 组播 224/4 与保留 240/4，含广播地址

  return false
}

function isPrivateIPv6(hostname: string): boolean {
  // URL.hostname 对 IPv6 会带方括号，先剥掉
  let raw = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  try {
    // URL 和 DNS 回答可能分别使用十六进制、点分 IPv4 或展开的 IPv6。
    // 先统一成 URL 的压缩形式，再识别 IPv4 映射地址。
    raw = new URL(`http://[${raw}]/`).hostname.slice(1, -1)
  } catch {
    return true
  }

  const mapped = raw.match(/^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/)
  if (mapped) {
    const high = parseInt(mapped[1], 16)
    const low = parseInt(mapped[2], 16)
    return isPrivateIPv4([high >>> 8, high & 255, low >>> 8, low & 255])
  }

  if (raw === '::1' || raw === '::') return true
  if (raw.startsWith('fe8') || raw.startsWith('fe9') || raw.startsWith('fea')) return true
  if (raw.startsWith('feb')) return true // fe80::/10 链路本地
  if (raw.startsWith('fc') || raw.startsWith('fd')) return true // fc00::/7 唯一本地
  if (raw.startsWith('ff')) return true // ff00::/8 组播

  return false
}

/**
 * 一个主机名或 IP 是否指向本机 / 内网。
 *
 * 同时给 URL 校验和 DNS 解析结果校验用 —— 两处判据必须完全一致，
 * 否则「域名被拒、解析结果放行」这种缝隙迟早被踩到。
 */
export function isPrivateAddress(hostname: string): boolean {
  if (!hostname) return true
  if (isLoopbackName(hostname)) return true

  const octets = parseIPv4(hostname)
  if (octets) return isPrivateIPv4(octets)

  if (hostname.includes(':')) return isPrivateIPv6(hostname)

  return false
}

/**
 * 校验一个要导航过去的 URL。
 *
 * 注意 `new URL()` 已经按 WHATWG 规范把 `http://2130706433/`、
 * `http://0x7f.1/` 这类写法规范化成点分十进制，所以这里不需要自己解析
 * 十进制/十六进制 IP —— 但**必须**在规范化之后判断，不能先做字符串匹配。
 */
export function checkNavigationUrl(raw: string): UrlCheckResult {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: `不是合法网址：${raw}` }
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `只允许 http/https，拒绝协议 ${url.protocol}` }
  }

  // URL 里带凭据既可能是钓鱼（真实主机被藏在 @ 后面），也会把密码写进日志
  if (url.username || url.password) {
    return { ok: false, reason: '网址里带用户名或密码，已拒绝' }
  }

  if (isPrivateAddress(url.hostname)) {
    return { ok: false, reason: `不允许访问本机或内网地址：${url.hostname}` }
  }

  return { ok: true, url }
}

/**
 * 代理软件的 fake-ip 段。
 *
 * Clash / mihomo / sing-box 开 TUN 时默认走 fake-ip：DNS 不返回真实地址，
 * 而是从一个保留段里现发一个假 IP，连接时再由内核映射回原域名。默认段是
 * IPv4 `198.18.0.0/15`（mihomo 用其中的 198.18.0.1/16）、IPv6 `fc00::/18`。
 *
 * 这两个段恰好也在「保留地址」里，所以按内网判据会被一刀切掉 —— 结果是
 * **开着 TUN 的用户一个网页都打不开**，而他访问的其实全是公网站点。
 * （同样的坑别人踩过：SSRF 过滤挡掉 RFC2544 段导致抓取功能整体失效。）
 *
 * 放行它们不构成新的风险：这些地址不是本机上的真实服务 —— 有代理时流量被
 * 内核转去真实目标，没代理时这个段根本不可路由，连不上。
 */
function isFakeIpAddress(address: string): boolean {
  const octets = parseIPv4(address)
  if (octets) return octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)

  const first = address.replace(/^\[/, '').toLowerCase().split(':')[0]
  // fc00::/18 —— 前 18 位固定，即第一段落在 fc00 ~ fc03
  return ['fc00', 'fc01', 'fc02', 'fc03'].includes(first)
}

/**
 * 校验 DNS 解析结果。
 *
 * 这是一道**尽力而为**的 SSRF 防护：解析和 Chromium 真正建连之间存在
 * TOCTOU，攻击者可以在两次解析之间换掉记录（DNS rebinding）。挡掉的是
 * 「域名直接解析到内网」这类常见情况，不是全部。设计文档 §9.2 写明了口径，
 * 这里不要写成「已彻底防住重绑定」。
 *
 * fake-ip 段先摘出去，理由见 `isFakeIpAddress`。
 */
export function checkResolvedAddresses(addresses: readonly string[]): UrlCheckResult | null {
  const real = addresses.filter((address) => !isFakeIpAddress(address))
  const bad = real.find((address) => isPrivateAddress(address))
  if (!bad) return null

  return {
    ok: false,
    reason:
      `域名解析到本机或内网地址（${bad}），已拒绝。` +
      '如果你在用代理的 TUN / fake-ip 模式，可能是它把域名映射到了自定义的假 IP 段 ——' +
      '把 fake-ip 段改回默认的 198.18.0.0/15 即可。'
  }
}
