// @vitest-environment node
/**
 * 交给 UE 插件的登录文件（契约 2.5）：形状照插件读的来 —— `member` 是成员面地址，
 * 令牌优先 DPAPI（`tokenDpapi`），拿不到才写明文 `identityToken`；一台服务器一个文件。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  credentialFileName,
  needsRenewal,
  readTeamCredential,
  removeTeamCredential,
  teamCredentialDir,
  writeTeamCredential
} from './teamCredentials'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'uebox-team-cred-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('team credential file', () => {
  it('lives where the plugin looks', () => {
    expect(teamCredentialDir({ UNREALBOX_TEAM_DIR: 'X:/t' })).toBe('X:/t')
    expect(teamCredentialDir({ LOCALAPPDATA: 'C:/Users/a/AppData/Local' })).toBe(
      join('C:/Users/a/AppData/Local', 'UnrealBox', 'team')
    )
    expect(credentialFileName('http://127.0.0.1:47484')).toBe('127.0.0.1_47484.json')
    expect(credentialFileName('https://nas.local/')).toBe('nas.local_443.json')
  })

  it('writes the DPAPI form the plugin unprotects, and removes it on leaving', async () => {
    const env = { UNREALBOX_TEAM_DIR: dir }
    const path = await writeTeamCredential(
      {
        memberUrl: 'http://127.0.0.1:47484/',
        account: 'ajie',
        identityToken: 'jwt',
        expires: 2000
      },
      {
        env,
        protect: async (token) => Buffer.from(`dpapi:${token}`).toString('base64'),
        now: () => 1000_000
      }
    )
    expect(path).toBe(join(dir, '127.0.0.1_47484.json'))
    const file = JSON.parse(await readFile(path as string, 'utf8'))
    expect(file).toEqual({
      member: 'http://127.0.0.1:47484',
      tokenDpapi: Buffer.from('dpapi:jwt').toString('base64'),
      expires: 2000,
      account: 'ajie',
      writtenAt: 1000_000
    })
    expect(file.identityToken).toBeUndefined()
    expect(await readTeamCredential('http://127.0.0.1:47484', env)).toMatchObject({
      account: 'ajie'
    })
    await removeTeamCredential('http://127.0.0.1:47484', env)
    await expect(stat(path as string)).rejects.toThrow()
  })

  it('falls back to a plain token where there is no DPAPI', async () => {
    const env = { UNREALBOX_TEAM_DIR: dir }
    const path = await writeTeamCredential(
      { memberUrl: 'https://nas.local:8084', account: null, identityToken: 'jwt', expires: null },
      { env, protect: async () => null }
    )
    expect(JSON.parse(await readFile(path as string, 'utf8'))).toMatchObject({
      member: 'https://nas.local:8084',
      identityToken: 'jwt'
    })
  })

  it('renews when less than a fifth of the lifetime is left', () => {
    const writtenAt = 0
    const expires = 100 // 秒 → 100 000 毫秒
    expect(needsRenewal(null, 0)).toBe(true)
    expect(needsRenewal({ writtenAt, expires: null }, 0)).toBe(true)
    expect(needsRenewal({ writtenAt, expires }, 50_000)).toBe(false)
    expect(needsRenewal({ writtenAt, expires }, 80_000)).toBe(true)
  })
})
