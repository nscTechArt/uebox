import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'
import { describe, it, expect } from 'vitest'
import { pluginPlatform, installedMacEngines } from '../../scripts/plugin-platform.mjs'
import { zipNameForEngine, findStaleBinary, checkStaleness } from '../../scripts/build-plugin.mjs'

describe('platform-specific plugin packages', () => {
  it('preserves Windows names and selects a separate Mac build script and package', () => {
    expect(zipNameForEngine('5.5', 'win32')).toBe('UnrealAgentLink55.zip')
    expect(zipNameForEngine('5.5', 'darwin')).toBe('UnrealAgentLink55-Mac.zip')
    expect(pluginPlatform('win32').script).toEqual(['Build.bat'])
    expect(pluginPlatform('darwin').script).toEqual(['Mac', 'Build.sh'])
  })

  it('discovers buildable Mac installations from metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ual-mac-discovery-'))
    try {
      const root = join(dir, 'UE custom')
      mkdirSync(join(root, 'Engine/Build/BatchFiles/Mac'), { recursive: true })
      writeFileSync(
        join(root, 'Engine/Build/Build.version'),
        JSON.stringify({ MajorVersion: 5, MinorVersion: 6 })
      )
      expect(installedMacEngines([dir]).size).toBe(0)
      writeFileSync(join(root, 'Engine/Build/BatchFiles/Mac/Build.sh'), '')
      expect([...installedMacEngines([dir, join(dir, 'missing')])]).toEqual([['5.6', root]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not accept a Windows binary or package as a Mac build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ual-mac-binary-'))
    try {
      mkdirSync(join(dir, 'Binaries/Win64'), { recursive: true })
      writeFileSync(join(dir, 'Binaries/Win64/UnrealEditor-UnrealAgentLink.dll'), 'fixture')
      expect(findStaleBinary(dir, 'win32')).toBeNull()
      expect(findStaleBinary(dir, 'darwin')).toContain('.dylib')
      const zip = new AdmZip()
      zip.addFile(
        '.ual-build',
        Buffer.from(JSON.stringify({ fingerprint: 'fresh', engine: '5.5', platform: 'Mac' }))
      )
      zip.writeZip(join(dir, 'UnrealAgentLink55-Mac.zip'))
      expect(checkStaleness('fresh', dir, ['5.5'], 'darwin')).toBe(false)
      zip.addFile('Binaries/Mac/UnrealEditor-UnrealAgentLink.dylib', Buffer.from('fixture'))
      zip.writeZip(join(dir, 'UnrealAgentLink55-Mac.zip'))
      expect(checkStaleness('fresh', dir, ['5.5'], 'darwin')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
