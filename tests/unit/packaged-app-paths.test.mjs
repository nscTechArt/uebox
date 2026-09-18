// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { packagedAppPaths } from '../../scripts/packaged-app-paths.mjs'
import { unexpectedPackagedFiles } from '../../scripts/check-packaged-content.mjs'

describe('packaged application layout', () => {
  it('retains the Windows executable and resource paths', () => {
    expect(packagedAppPaths('/project', 'win32', 'x64')).toEqual({
      exe: join('/project', 'dist/win-unpacked/unreal-agent.exe'),
      asar: join('/project', 'dist/win-unpacked/resources/app.asar')
    })
  })
  it.each([
    ['x64', 'mac'],
    ['arm64', 'mac-arm64']
  ])('finds the %s Mac bundle', (arch, directory) => {
    const paths = packagedAppPaths('/project', 'darwin', arch)
    expect(paths.exe).toBe(
      join('/project', 'dist', directory, '虚幻盒子.app/Contents/MacOS/虚幻盒子')
    )
    expect(paths.asar).toBe(
      join('/project', 'dist', directory, '虚幻盒子.app/Contents/Resources/app.asar')
    )
  })
  it('allows platform plugin packages while still rejecting unrelated archives', () => {
    expect(
      unexpectedPackagedFiles([
        'resources/plugins/UnrealAgentLink55.zip',
        'resources/plugins/UnrealAgentLink55-Mac.zip',
        'resources/plugins/unrelated.zip'
      ])
    ).toEqual(['resources/plugins/unrelated.zip'])
  })
})
