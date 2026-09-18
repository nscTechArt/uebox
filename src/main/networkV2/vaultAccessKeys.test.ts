/**
 * 访问码的两条来源。
 *
 * 红灯用例是「SMB 发现模式」那条：码只在运行期表里，只读 app_settings 的调用点
 * 会一律拿不到码 —— 远程扫描 401、权限探测 401（于是主机明明开了共享写，
 * 界面把写操作锁死成只读）。
 */
import { describe, it, expect, beforeEach } from 'vitest'

import {
  forgetVaultAccessKeys,
  rememberVaultAccessKey,
  resolveVaultAccessKey,
  vaultAccessKeyHeadersFromUrl
} from './vaultAccessKeys'

const SERVER = 'http://192.168.1.5:18900'
const REMOTE_VAULT = 'vault_remote_001'

describe('resolveVaultAccessKey', () => {
  beforeEach(() => forgetVaultAccessKeys())

  it('SMB 发现模式：码只在运行期表里也要能查到', () => {
    rememberVaultAccessKey(SERVER, REMOTE_VAULT, 'SHARED-WRITE-KEY')

    expect(resolveVaultAccessKey({ serverUrl: SERVER, remoteVaultId: REMOTE_VAULT })).toBe(
      'SHARED-WRITE-KEY'
    )
  })

  it('用户手填的码优先于运行期表', () => {
    rememberVaultAccessKey(SERVER, REMOTE_VAULT, 'OLD-DISCOVERY-KEY')

    expect(
      resolveVaultAccessKey({
        storedKey: 'USER-TYPED-KEY',
        serverUrl: SERVER,
        remoteVaultId: REMOTE_VAULT
      })
    ).toBe('USER-TYPED-KEY')
  })

  it('码按远端 vaultId 索引 —— 拿本地 vaultId 查不到', () => {
    rememberVaultAccessKey(SERVER, REMOTE_VAULT, 'SHARED-WRITE-KEY')

    expect(
      resolveVaultAccessKey({ serverUrl: SERVER, remoteVaultId: 'vault_local_999' })
    ).toBeUndefined()
  })

  it('两条来源都没有时返回 undefined，而不是空串', () => {
    expect(resolveVaultAccessKey({ storedKey: '  ' })).toBeUndefined()
    expect(
      resolveVaultAccessKey({ serverUrl: SERVER, remoteVaultId: REMOTE_VAULT })
    ).toBeUndefined()
  })

  it('尾部斜杠不影响命中', () => {
    rememberVaultAccessKey(`${SERVER}/`, REMOTE_VAULT, 'KEY')

    expect(resolveVaultAccessKey({ serverUrl: SERVER, remoteVaultId: REMOTE_VAULT })).toBe('KEY')
  })
})

describe('vaultAccessKeyHeadersFromUrl', () => {
  beforeEach(() => forgetVaultAccessKeys())

  it('资产文件 URL 能反推出访问码', () => {
    rememberVaultAccessKey(SERVER, REMOTE_VAULT, 'KEY')

    expect(
      vaultAccessKeyHeadersFromUrl(`${SERVER}/api/vaults/${REMOTE_VAULT}/files/Texture/a.png`)
    ).toEqual({ 'X-API-Key': 'KEY' })
  })

  it('外部 URL 不带我们的码', () => {
    rememberVaultAccessKey(SERVER, REMOTE_VAULT, 'KEY')

    expect(vaultAccessKeyHeadersFromUrl('https://evil.example.com/api/vaults/x/files/a')).toEqual(
      {}
    )
  })
})
