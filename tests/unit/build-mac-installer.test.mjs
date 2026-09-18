// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { macInstallerArgs } from '../../scripts/build-mac-installer.mjs'

describe('Mac installer update feed', () => {
  it('requires signing and notarization only when explicitly requested', () => {
    expect(macInstallerArgs({}, { APPLE_KEYCHAIN_PROFILE: 'profile' })).not.toContain(
      '-c.mac.notarize=true'
    )
    const args = macInstallerArgs(
      {},
      { UEBOX_MAC_NOTARIZE: '1', APPLE_KEYCHAIN_PROFILE: 'profile' }
    )
    expect(args).toContain('-c.mac.notarize=true')
    expect(args).toContain('-c.mac.forceCodeSigning=true')
    expect(args.slice(0, 3)).toEqual(['--mac', '--publish', 'never'])
  })
  it('rejects missing or partial notarization credentials before building', () => {
    expect(() => macInstallerArgs({}, { UEBOX_MAC_NOTARIZE: '1' })).toThrow(
      'APPLE_KEYCHAIN_PROFILE'
    )
    expect(() =>
      macInstallerArgs(
        {},
        {
          UEBOX_MAC_NOTARIZE: '1',
          APPLE_ID: 'fixture@example.invalid',
          APPLE_KEYCHAIN_PROFILE: 'profile'
        }
      )
    ).toThrow('APPLE_APP_SPECIFIC_PASSWORD')
  })
  it.each([
    {
      APPLE_ID: 'fixture@example.invalid',
      APPLE_APP_SPECIFIC_PASSWORD: 'fixture',
      APPLE_TEAM_ID: 'fixture'
    },
    { APPLE_API_KEY: '/fixture/key.p8', APPLE_API_KEY_ID: 'fixture', APPLE_API_ISSUER: 'fixture' }
  ])('accepts a complete credential method', (credentials) => {
    expect(macInstallerArgs({}, { UEBOX_MAC_NOTARIZE: '1', ...credentials })).toContain(
      '-c.mac.notarize=true'
    )
  })
  it('keeps unconfigured builds offline and never publishes as a build side effect', () => {
    expect(macInstallerArgs({}, {})).toEqual(['--mac', '--publish', 'never'])
    expect(macInstallerArgs({ updateGithubRepo: '  ' }, {})).toEqual([
      '--mac',
      '--publish',
      'never'
    ])
  })
  it('injects the configured repository into both builder and runtime metadata', () => {
    expect(macInstallerArgs({ updateGithubRepo: 'owner/repo' }, {})).toEqual([
      '--mac',
      '--publish',
      'never',
      '-c.mac.publish.provider=github',
      '-c.mac.publish.owner=owner',
      '-c.mac.publish.repo=repo',
      '-c.extraMetadata.updateGithubRepo=owner/repo'
    ])
  })
  it('matches Windows environment override precedence and rejects malformed repositories', () => {
    const args = macInstallerArgs(
      { updateGithubRepo: 'old/repo' },
      { UEBOX_UPDATE_GITHUB_REPO: 'new/test' }
    )
    expect(args).toContain('-c.extraMetadata.updateGithubRepo=new/test')
    expect(() =>
      macInstallerArgs({ updateGithubRepo: 'https://github.com/owner/repo' }, {})
    ).toThrow()
  })
  it('wires the entry point and supplies architecture-specific ZIP and DMG artifacts', () => {
    const config = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8')
    const mac = config.split('\nmac:\n')[1].split('\nlinux:\n')[0]
    expect(mac).toContain('    - zip')
    expect(mac).toContain('    - dmg')
    // 文件名前缀写死 uebox，不用 ${name}：${name} 同时决定 userData 目录，不能跟着改。
    expect(mac).toContain('uebox-${version}-${arch}-mac.${ext}')
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(pkg.scripts['build:mac']).toContain('node scripts/build-mac-installer.mjs')
    expect(pkg.scripts['build:win']).toContain('node scripts/build-win-installer.js')
  })
})
