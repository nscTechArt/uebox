import { describe, expect, it } from 'vitest'

import { checkNavigationUrl, checkResolvedAddresses, isPrivateAddress } from './urlPolicy'

/**
 * 这是整套浏览器能力里唯一「判断错了就出事」的地方，所以按攻击面逐条测。
 *
 * 特别注意最后一组：`http://2130706433/` 这类写法在 WHATWG URL 规范化之后
 * 才现出原形，先做字符串匹配的实现会漏掉它们。
 */

describe('checkNavigationUrl', () => {
  it.each([
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '::ffff:192.168.1.1',
    '::ffff:c0a8:101',
    '::ffff:a9fe:a9fe',
    '0:0:0:0:0:0:0:1'
  ])('URL 和 DNS 都拒绝等价的内网 IPv6 写法 %s', (address) => {
    expect(checkNavigationUrl(`http://[${address}]/`).ok).toBe(false)
    expect(checkResolvedAddresses([address])?.ok).toBe(false)
  })

  it.each(['::ffff:8.8.8.8', '::ffff:808:808', '2606:4700:4700::1111'])(
    '仍允许公网 IPv6 地址 %s',
    (address) => {
      expect(checkNavigationUrl(`https://[${address}]/`).ok).toBe(true)
      expect(checkResolvedAddresses([address])).toBeNull()
    }
  )
  it('放行普通公网 http/https', () => {
    expect(checkNavigationUrl('https://www.electronjs.org/docs').ok).toBe(true)
    // 仍有站点没上 HTTPS，普通 http 要能用
    expect(checkNavigationUrl('http://example.com/a?b=1#c').ok).toBe(true)
  })

  it.each([
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
    'blob:https://example.com/abc',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'view-source:https://example.com'
  ])('拒绝危险协议 %s', (raw) => {
    const result = checkNavigationUrl(raw)
    expect(result.ok).toBe(false)
  })

  it('拒绝自定义协议 —— uebox:// 会被应用自己的深链接处理器接走', () => {
    const result = checkNavigationUrl('uebox://notebook/import/abc')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('uebox:')
  })

  it('拒绝带凭据的网址', () => {
    const result = checkNavigationUrl('https://user:pass@example.com/')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('用户名或密码')
  })

  it.each([
    'http://localhost:5173/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://127.0.0.1:8766/api/debug/tool',
    'http://0.0.0.0/',
    'http://10.0.0.5/',
    'http://172.16.3.4/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]:3000/',
    'http://[fe80::1]/',
    'http://[fd00::1]/'
  ])('拒绝本机与内网地址 %s', (raw) => {
    expect(checkNavigationUrl(raw).ok).toBe(false)
  })

  it('拒绝换了进制写法的环回地址', () => {
    // WHATWG URL 会把这两个都规范成 127.0.0.1，所以判断必须在解析之后做
    expect(checkNavigationUrl('http://2130706433/').ok).toBe(false)
    expect(checkNavigationUrl('http://0x7f000001/').ok).toBe(false)
  })

  it('拒绝 IPv4 映射进 IPv6 的内网地址', () => {
    expect(isPrivateAddress('::ffff:192.168.0.1')).toBe(true)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
  })

  it('不是网址的字符串直接拒绝', () => {
    expect(checkNavigationUrl('不是网址').ok).toBe(false)
    expect(checkNavigationUrl('').ok).toBe(false)
  })
})

describe('checkResolvedAddresses', () => {
  it('解析结果全在公网时放行', () => {
    expect(checkResolvedAddresses(['93.184.216.34', '2606:2800:220:1::1'])).toBeNull()
  })

  it('任意一个解析结果落在内网就拒绝 —— 一条记录足够把请求带进去', () => {
    const result = checkResolvedAddresses(['93.184.216.34', '169.254.169.254'])

    expect(result?.ok).toBe(false)
    if (result && !result.ok) expect(result.reason).toContain('169.254.169.254')
  })

  it('空解析结果不算拒绝理由 —— 那是解析失败，交给加载流程报真实网络错误', () => {
    expect(checkResolvedAddresses([])).toBeNull()
  })

  /**
   * 开着 Clash / sing-box 的 TUN 时，**所有**域名都解析成 fake-ip。
   *
   * 不放行的话，这套浏览器对这批用户等于完全不能用 —— 而他们访问的其实全是
   * 公网站点：那些假 IP 不是本机上的服务，有代理时被内核转去真实目标，
   * 没代理时那个段根本不可路由。
   */
  it.each([
    ['mihomo 默认段', '198.18.0.184'],
    ['sing-box 段的上半', '198.19.1.1'],
    ['sing-box IPv6 段', 'fc00::a1b2']
  ])('放行代理的 fake-ip：%s', (_label, address) => {
    expect(checkResolvedAddresses([address])).toBeNull()
  })

  it('fake-ip 之外的内网地址照样拒绝，且提示可能是代理配置', () => {
    const result = checkResolvedAddresses(['198.18.0.7', '192.168.1.10'])

    expect(result?.ok).toBe(false)
    if (result && !result.ok) {
      expect(result.reason).toContain('192.168.1.10')
      expect(result.reason).toContain('fake-ip')
    }
  })

  it('fake-ip 段只是 DNS 结果的例外，直接写成网址仍然拒绝', () => {
    // 没人会手输假 IP，放行它没有收益
    expect(checkNavigationUrl('http://198.18.0.184/').ok).toBe(false)
    expect(isPrivateAddress('fc00::a1b2')).toBe(true)
  })
})
