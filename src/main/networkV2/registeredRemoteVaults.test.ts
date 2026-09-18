// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { findRegisteredRemoteVault } from './registeredRemoteVaults'

const SERVER = 'http://10.0.0.10:18900'
const REMOTE = 'vault_1774835979698_b4eaa81a'

const vaults = [
  { id: 'local-backup', vaultType: 'backup', path: 'H:/local' },
  { id: 'local-net', vaultType: 'network', networkPath: `${SERVER}/${REMOTE}` },
  { id: 'local-smb', vaultType: 'network', networkPath: '\\\\nas\\assets' }
]

describe('findRegisteredRemoteVault', () => {
  it('找到用户登记过的那个库', () => {
    expect(findRegisteredRemoteVault(vaults, SERVER, REMOTE)).toEqual({ localVaultId: 'local-net' })
  })

  it('尾部斜杠不影响匹配', () => {
    expect(
      findRegisteredRemoteVault(
        [{ ...vaults[1], networkPath: `${SERVER}/${REMOTE}/` }],
        SERVER,
        REMOTE
      )
    ).toEqual({
      localVaultId: 'local-net'
    })
  })

  it('换个服务器就不认', () => {
    expect(findRegisteredRemoteVault(vaults, 'http://10.0.0.11:18900', REMOTE)).toBeNull()
    expect(findRegisteredRemoteVault(vaults, 'http://10.0.0.10:18901', REMOTE)).toBeNull()
  })

  it('换个远端库 id 就不认', () => {
    expect(findRegisteredRemoteVault(vaults, SERVER, 'vault_other')).toBeNull()
  })

  it('库 id 带斜杠一律不认 —— 否则能换个拆法把码发到别的路径前缀', () => {
    // 库登记在 http://host/team/vault_1，真正的 API 根是 /team。
    // 若允许 serverUrl="http://host" + vaultId="team/vault_1"，拼出来的串一样，
    // 访问码就会被发到 http://host/api/...，不是 /team 那个租户。
    const tenant = [{ id: 'x', vaultType: 'network', networkPath: `${SERVER}/team/vault_1` }]
    expect(findRegisteredRemoteVault(tenant, SERVER, 'team/vault_1')).toBeNull()
    expect(findRegisteredRemoteVault(tenant, SERVER, 'team\\vault_1')).toBeNull()
    expect(findRegisteredRemoteVault(tenant, `${SERVER}/team`, 'vault_1')).toEqual({
      localVaultId: 'x'
    })
  })

  it('库名带中文或空格也要能匹配上 —— 两边用同一套转义', () => {
    const encoded = [
      { id: 'cn', vaultType: 'network', networkPath: `${SERVER}/我的库` },
      { id: 'sp', vaultType: 'network', networkPath: `${SERVER}/my vault` }
    ]
    expect(findRegisteredRemoteVault(encoded, SERVER, '我的库')).toEqual({ localVaultId: 'cn' })
    expect(findRegisteredRemoteVault(encoded, SERVER, 'my vault')).toEqual({ localVaultId: 'sp' })
  })

  it('非网络库和 SMB 路径都不参与匹配', () => {
    expect(findRegisteredRemoteVault(vaults, '\\\\nas', 'assets')).toBeNull()
    expect(
      findRegisteredRemoteVault(
        [{ id: 'b', vaultType: 'backup', networkPath: `${SERVER}/${REMOTE}` }],
        SERVER,
        REMOTE
      )
    ).toBeNull()
  })

  it('带账号密码或查询串的登记地址一律不认', () => {
    const tainted = [
      { id: 'u', vaultType: 'network', networkPath: `http://user:pw@10.0.0.10:18900/${REMOTE}` },
      { id: 'q', vaultType: 'network', networkPath: `${SERVER}/${REMOTE}?x=1` }
    ]
    expect(findRegisteredRemoteVault(tainted, SERVER, REMOTE)).toBeNull()
  })

  it('空参数直接不认', () => {
    expect(findRegisteredRemoteVault(vaults, '', REMOTE)).toBeNull()
    expect(findRegisteredRemoteVault(vaults, SERVER, '')).toBeNull()
  })
})
