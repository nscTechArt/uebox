export type SourceBuildEngineVersionResolver = {
  isSourceBuildGUID: (engineAssociation: string) => boolean
  resolveEngineVersionFromGUID: (
    guid: string
  ) => Promise<{ version: string; engineRootPath?: string } | null>
}

export type ResolvedProjectEngineVersion = {
  originalAssociation: string | null
  comparableVersion: string | null
  displayVersion: string
  resolvedFromSourceBuild: boolean
  engineRootPath?: string
}

export const parseVersion = (v: string | null | undefined): { major: number; minor: number } => {
  const s = String(v || '').trim()
  const m = s.match(/^(\d+)(?:\.(\d+))?/) || []
  const major = Number(m[1] || 0)
  const minor = Number(m[2] || 0)
  return { major, minor }
}

export const compareVersions = (
  a: string | null | undefined,
  b: string | null | undefined
): number => {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1
  return 0
}

export const formatVersionForDisplay = (version: string | null | undefined): string => {
  if (!version) return '\u672a\u77e5'
  const parsed = parseVersion(version)
  if (parsed.major === 0) return version.slice(0, 10)
  return `${parsed.major}.${parsed.minor}`
}

export async function resolveProjectEngineVersion(
  engineAssociation: string | null | undefined,
  resolver?: SourceBuildEngineVersionResolver
): Promise<ResolvedProjectEngineVersion> {
  const originalAssociation = String(engineAssociation || '').trim() || null

  if (!originalAssociation) {
    return {
      originalAssociation,
      comparableVersion: null,
      displayVersion: formatVersionForDisplay(null),
      resolvedFromSourceBuild: false
    }
  }

  if (resolver?.isSourceBuildGUID(originalAssociation)) {
    try {
      const resolved = await resolver.resolveEngineVersionFromGUID(originalAssociation)
      if (resolved?.version) {
        return {
          originalAssociation,
          comparableVersion: resolved.version,
          displayVersion: formatVersionForDisplay(resolved.version),
          resolvedFromSourceBuild: true,
          engineRootPath: resolved.engineRootPath
        }
      }
    } catch {
      // Fall back to the original association so the guard stays conservative.
    }
  }

  return {
    originalAssociation,
    comparableVersion: originalAssociation,
    displayVersion: formatVersionForDisplay(originalAssociation),
    resolvedFromSourceBuild: false
  }
}

/**
 * 批量把 `.uproject` 里的 EngineAssociation 翻成界面上能看的版本号。
 *
 * 自编译引擎（比如自己拉源码编的 5.8）在 `.uproject` 里写的是一串
 * `{DAB4E4C9-...}` 的 GUID，卡片上直接摆出来就像乱码。这里按注册表还原成
 * `5.8`；还原不出来（引擎没装在这台机器上）就返回空串，让界面回退到 N/A ——
 * 半截 GUID 比什么都不显示更糟。
 *
 * @returns 原始 EngineAssociation → 显示文案 的映射，去重后逐个解析
 */
export async function resolveEngineAssociationLabels(
  associations: readonly (string | null | undefined)[],
  resolver?: SourceBuildEngineVersionResolver
): Promise<Record<string, string>> {
  const labels: Record<string, string> = {}

  for (const association of associations) {
    const key = String(association || '').trim()
    if (!key || key in labels) continue

    const resolved = await resolveProjectEngineVersion(key, resolver)
    const unresolvedSourceBuild =
      !resolved.resolvedFromSourceBuild && !!resolver?.isSourceBuildGUID(key)
    labels[key] = unresolvedSourceBuild ? '' : resolved.displayVersion
  }

  return labels
}

/**
 * 项目版本已经解析过时用这个，别再解析一遍。
 *
 * 自编译引擎的 GUID 是靠**起一个 PowerShell 进程**读注册表还原的（见
 * `UnrealPathManager.resolveEngineVersionFromGUID`）。批量导入里逐个资产调用，
 * 500 个资产就是 500 次进程启动，每次还带 5 秒超时 —— 那不是慢，是假死。
 */
export function compareAssetToResolvedProjectEngineVersion(
  assetEngineVersion: string | null | undefined,
  project: ResolvedProjectEngineVersion
): {
  comparison: number
  assetDisplayVersion: string
  project: ResolvedProjectEngineVersion
} {
  return {
    comparison: compareVersions(assetEngineVersion, project.comparableVersion),
    assetDisplayVersion: formatVersionForDisplay(assetEngineVersion),
    project
  }
}

export async function compareAssetToProjectEngineVersion(
  assetEngineVersion: string | null | undefined,
  projectEngineAssociation: string | null | undefined,
  resolver?: SourceBuildEngineVersionResolver
): Promise<{
  comparison: number
  assetDisplayVersion: string
  project: ResolvedProjectEngineVersion
}> {
  const project = await resolveProjectEngineVersion(projectEngineAssociation, resolver)

  return compareAssetToResolvedProjectEngineVersion(assetEngineVersion, project)
}
