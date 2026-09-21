/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { describeLoopbackProxyRisk, detectLoopbackProxy } from './proxy.js'

describe('detectLoopbackProxy', () => {
  it('没有任何代理变量时不报', () => {
    expect(detectLoopbackProxy({})).toBeNull()
  })

  it('HTTP_PROXY 命中，原样带出变量名和值', () => {
    expect(detectLoopbackProxy({ HTTP_PROXY: 'http://127.0.0.1:10081' })).toEqual({
      variable: 'HTTP_PROXY',
      value: 'http://127.0.0.1:10081'
    })
  })

  /** curl 那套约定里小写同样生效，只查大写会漏掉一半的机器 */
  it('小写 http_proxy 也认，并报出小写的名字', () => {
    expect(detectLoopbackProxy({ http_proxy: 'http://127.0.0.1:10081' })).toEqual({
      variable: 'http_proxy',
      value: 'http://127.0.0.1:10081'
    })
  })

  it('HTTPS_PROXY / ALL_PROXY 单独存在时也命中', () => {
    expect(detectLoopbackProxy({ HTTPS_PROXY: 'http://p:1' })?.variable).toBe('HTTPS_PROXY')
    expect(detectLoopbackProxy({ ALL_PROXY: 'socks5://p:1' })?.variable).toBe('ALL_PROXY')
  })

  it('空串和纯空白当没设', () => {
    expect(detectLoopbackProxy({ HTTP_PROXY: '', HTTPS_PROXY: '   ' })).toBeNull()
  })

  describe('NO_PROXY 排掉回环就不报', () => {
    it.each([['127.0.0.1'], ['localhost'], ['::1'], ['*'], ['example.com,127.0.0.1']])(
      'NO_PROXY=%s',
      (noProxy) => {
        expect(detectLoopbackProxy({ HTTP_PROXY: 'http://p:1', NO_PROXY: noProxy })).toBeNull()
      }
    )

    /** 127.0.0.0/8 整段都是回环，写哪一个都算排掉了 */
    it('NO_PROXY 写的是 127.0.0.2 这类同段地址也算', () => {
      expect(detectLoopbackProxy({ HTTP_PROXY: 'http://p:1', NO_PROXY: '127.0.0.2' })).toBeNull()
    })

    it('NO_PROXY 里只有别的域名时照样报', () => {
      expect(
        detectLoopbackProxy({ HTTP_PROXY: 'http://p:1', NO_PROXY: 'example.com,.internal' })
      ).not.toBeNull()
    })
  })
})

describe('describeLoopbackProxyRisk', () => {
  /** 用户照着这段话去做，所以变量名、值和那条启动参数必须都在 */
  it('把变量、值和解法都说出来', () => {
    const text = describeLoopbackProxyRisk({
      variable: 'HTTP_PROXY',
      value: 'http://127.0.0.1:10081'
    })

    expect(text).toContain('HTTP_PROXY=http://127.0.0.1:10081')
    expect(text).toContain('-ini:Engine:[HTTP]:HttpProxyAddress=')
    expect(text).toContain('bUseHttpProxy')
  })
})
