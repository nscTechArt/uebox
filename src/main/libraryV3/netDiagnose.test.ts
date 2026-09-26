/**
 * 连不上时说清楚是哪一种：防火墙丢包、端口没人听、名字解析不了、路由不通、证书名字对不上。
 */
import { describe, expect, it } from 'vitest'
import { CatalogHttpError } from './http'
import { diagnoseConnectError, targetOf } from './netDiagnose'

const errno = (code: string, message = code): NodeJS.ErrnoException =>
  Object.assign(new Error(message), { code })

describe('diagnoseConnectError', () => {
  it('tells a silent firewall from a closed port', () => {
    expect(diagnoseConnectError(errno('ETIMEDOUT'), '10.0.0.5:8084')).toEqual({
      code: 'port-blocked',
      detail: '10.0.0.5:8084'
    })
    const timeout = new CatalogHttpError('timeout', 0, 'No answer within 8000 ms')
    expect(diagnoseConnectError(timeout, '10.0.0.5:8083')?.code).toBe('port-blocked')
    expect(diagnoseConnectError(new Error('No TLS answer from 10.0.0.5:8084'), 'x:1')?.code).toBe(
      'port-blocked'
    )
    const refused = new CatalogHttpError('network', 0, 'connect ECONNREFUSED', null, 'ECONNREFUSED')
    expect(diagnoseConnectError(refused, '10.0.0.5:8083')).toEqual({
      code: 'port-closed',
      detail: '10.0.0.5:8083'
    })
  })

  it('names the host that cannot be found or reached', () => {
    expect(diagnoseConnectError(errno('ENOTFOUND'), 'assets.lan:8084')).toEqual({
      code: 'host-not-found',
      detail: 'assets.lan'
    })
    expect(diagnoseConnectError(errno('EHOSTUNREACH'), '10.9.9.9:8084')?.code).toBe(
      'host-unreachable'
    )
  })

  it('lists the names on a certificate that does not cover the address', () => {
    const error = errno(
      'ERR_TLS_CERT_ALTNAME_INVALID',
      "Hostname/IP does not match certificate's altnames: IP: 10.0.0.9 is not in the cert's list: 10.0.0.5, assets.lan"
    )
    const problem = diagnoseConnectError(error, '10.0.0.9:8084')
    expect(problem?.code).toBe('cert-name-mismatch')
    expect(problem?.detail).toContain('10.0.0.9')
  })

  it('says so when the port does not speak TLS or something cuts the handshake', () => {
    const cut = errno(
      'ECONNRESET',
      'Client network socket disconnected before secure TLS connection was established'
    )
    expect(diagnoseConnectError(cut, '10.0.0.5:8084')).toEqual({
      code: 'tls-handshake',
      detail: '10.0.0.5:8084'
    })
  })

  it('leaves other failures alone', () => {
    expect(diagnoseConnectError(errno('ECONNRESET'), 'x:1')).toBeNull()
  })

  it('fills in the default port', () => {
    expect(targetOf('https://assets.lan')).toBe('assets.lan:443')
    expect(targetOf('https://10.0.0.5:8084/enroll')).toBe('10.0.0.5:8084')
  })
})
