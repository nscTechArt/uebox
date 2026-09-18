import { describe, expect, it, vi } from 'vitest'
import {
  compareAssetToProjectEngineVersion,
  compareAssetToResolvedProjectEngineVersion,
  formatVersionForDisplay,
  resolveEngineAssociationLabels,
  resolveProjectEngineVersion
} from './projectEngineVersion'

const sourceBuildResolver = {
  isSourceBuildGUID: (engineAssociation: string) => /^\{[A-Fa-f0-9-]+\}$/.test(engineAssociation),
  resolveEngineVersionFromGUID: vi.fn()
}

describe('project engine version helpers', () => {
  it('uses resolved Build.version data when EngineAssociation is a source-build GUID', async () => {
    sourceBuildResolver.resolveEngineVersionFromGUID.mockResolvedValueOnce({
      version: '5.6.0',
      engineRootPath: 'T:\\UE_5.6'
    })

    const result = await resolveProjectEngineVersion(
      '{8B9CFD84-40B9-FE7A-CB9A-7C8F4167186F}',
      sourceBuildResolver
    )

    expect(result.comparableVersion).toBe('5.6.0')
    expect(result.displayVersion).toBe('5.6')
    expect(result.resolvedFromSourceBuild).toBe(true)
  })

  it('allows older assets to import into a newer source-build project after GUID resolution', async () => {
    sourceBuildResolver.resolveEngineVersionFromGUID.mockResolvedValueOnce({
      version: '5.6.0',
      engineRootPath: 'T:\\UE_5.6'
    })

    const result = await compareAssetToProjectEngineVersion(
      '5.3',
      '{8B9CFD84-40B9-FE7A-CB9A-7C8F4167186F}',
      sourceBuildResolver
    )

    expect(result.comparison).toBeLessThanOrEqual(0)
    expect(result.project.displayVersion).toBe('5.6')
  })

  it('keeps unresolved GUIDs conservative instead of silently allowing import', async () => {
    sourceBuildResolver.resolveEngineVersionFromGUID.mockResolvedValueOnce(null)

    const result = await compareAssetToProjectEngineVersion(
      '5.3',
      '{8B9CFD84-40B9-FE7A-CB9A-7C8F4167186F}',
      sourceBuildResolver
    )

    expect(result.comparison).toBeGreaterThan(0)
    expect(result.project.displayVersion).toMatch(/^\{8B9CFD84/)
  })

  it('formats normal Unreal version strings for display', () => {
    expect(formatVersionForDisplay('5.6.0-123+++UE5+Release-5.6')).toBe('5.6')
  })
})

describe('compareAssetToResolvedProjectEngineVersion', () => {
  it('批量导入时复用已解析的工程版本，不再碰注册表', async () => {
    sourceBuildResolver.resolveEngineVersionFromGUID.mockReset()
    sourceBuildResolver.resolveEngineVersionFromGUID.mockResolvedValue({
      version: '5.6.0',
      engineRootPath: 'T:\\UE_5.6'
    })

    const project = await resolveProjectEngineVersion(
      '{8B9CFD84-40B9-FE7A-CB9A-7C8F4167186F}',
      sourceBuildResolver
    )
    sourceBuildResolver.resolveEngineVersionFromGUID.mockClear()

    // 模拟一批资产逐个比对
    const results = ['5.3', '5.6', '5.8'].map((assetVersion) =>
      compareAssetToResolvedProjectEngineVersion(assetVersion, project)
    )

    expect(sourceBuildResolver.resolveEngineVersionFromGUID).not.toHaveBeenCalled()
    expect(results[0].comparison).toBeLessThan(0)
    expect(results[1].comparison).toBe(0)
    // 资产比工程新，仍然要挡下来
    expect(results[2].comparison).toBeGreaterThan(0)
    expect(results[2].project.displayVersion).toBe('5.6')
  })
})

describe('resolveEngineAssociationLabels', () => {
  it('把自编译引擎的 GUID 翻成版本号，普通版本号原样返回', async () => {
    sourceBuildResolver.resolveEngineVersionFromGUID.mockResolvedValueOnce({
      version: '5.8.0',
      engineRootPath: 'T:\\UE_5.8'
    })

    const labels = await resolveEngineAssociationLabels(
      ['{DAB4E4C9-4ACB-5131-9F9E-79B80F24F436}', '5.5', '', null],
      sourceBuildResolver
    )

    expect(labels['{DAB4E4C9-4ACB-5131-9F9E-79B80F24F436}']).toBe('5.8')
    expect(labels['5.5']).toBe('5.5')
    // 空值不占位，界面自己回退到 N/A
    expect(Object.keys(labels)).toHaveLength(2)
  })

  it('查不到对应引擎时留空，不把半截 GUID 摆到卡片上', async () => {
    sourceBuildResolver.resolveEngineVersionFromGUID.mockResolvedValueOnce(null)

    const labels = await resolveEngineAssociationLabels(
      ['{DAB4E4C9-4ACB-5131-9F9E-79B80F24F436}'],
      sourceBuildResolver
    )

    expect(labels['{DAB4E4C9-4ACB-5131-9F9E-79B80F24F436}']).toBe('')
  })

  it('同一个 GUID 只查一次注册表', async () => {
    sourceBuildResolver.resolveEngineVersionFromGUID.mockReset()
    sourceBuildResolver.resolveEngineVersionFromGUID.mockResolvedValue({
      version: '5.8.0',
      engineRootPath: 'T:\\UE_5.8'
    })

    const guid = '{DAB4E4C9-4ACB-5131-9F9E-79B80F24F436}'
    await resolveEngineAssociationLabels([guid, guid, guid], sourceBuildResolver)

    expect(sourceBuildResolver.resolveEngineVersionFromGUID).toHaveBeenCalledTimes(1)
  })
})
