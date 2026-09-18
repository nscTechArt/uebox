import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { readUeJsonFile } from './ueTextFile'

// Only inspect immediate children of known installation directories, never the whole disk.
export const MAC_ENGINE_DIRECTORIES = [
  '/Users/Shared/Epic Games',
  '/Users/Shared/EpicGames',
  '/Users/Shared/UnrealEngine'
]

export function normalizeEngineRoot(input: string): string {
  const value = input.trim().replace(/[\\/]+$/, '')
  return value
    .replace(
      /[\\/]Engine[\\/]Binaries[\\/]Mac[\\/](UnrealEditor|UE4Editor)\.app(?:[\\/]Contents[\\/]MacOS[\\/](?:UnrealEditor|UE4Editor))?$/i,
      ''
    )
    .replace(/[\\/](?:Engine[\\/])?Binaries[\\/]Win64[\\/](?:UnrealEditor|UE4Editor)\.exe$/i, '')
    .replace(/[\\/]Engine$/i, '')
}

/** The UI opens enginePath with shell.openPath, so macOS needs the .app bundle. */
export async function resolveEngineExecutable(
  root: string,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  if (!root) return null
  const editors = ['UnrealEditor', 'UE4Editor']
  for (const prefix of ['Engine', '']) {
    for (const editor of editors) {
      const launchPath =
        platform === 'darwin'
          ? path.join(root, prefix, 'Binaries', 'Mac', `${editor}.app`)
          : path.join(root, prefix, 'Binaries', 'Win64', `${editor}.exe`)
      const executable =
        platform === 'darwin' ? path.join(launchPath, 'Contents', 'MacOS', editor) : launchPath
      try {
        if (!(await fs.stat(executable)).isFile()) continue
        await fs.access(executable, platform === 'darwin' ? constants.X_OK : constants.F_OK)
        return launchPath
      } catch {
        // A missing, incomplete or inaccessible installation is not launchable.
      }
    }
  }
  return null
}

export async function readEngineBuildVersion(root: string): Promise<string | null> {
  try {
    const data = await readUeJsonFile<{
      MajorVersion?: unknown
      MinorVersion?: unknown
      PatchVersion?: unknown
    }>(path.join(root, 'Engine', 'Build', 'Build.version'))
    const parts: unknown[] = [data.MajorVersion, data.MinorVersion]
    if (data.PatchVersion != null) parts.push(data.PatchVersion)
    if (!parts.every((part) => typeof part === 'number' && Number.isInteger(part) && part >= 0)) {
      return null
    }
    return parts.join('.')
  } catch {
    return null
  }
}

/** Insights is spawned as a command-line process, so use the binary inside a Mac bundle. */
export async function resolveInsightsExecutable(
  root: string,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  const binaries = path.join(root, 'Engine', 'Binaries')
  const candidates =
    platform === 'darwin'
      ? [
          path.join(binaries, 'Mac', 'UnrealInsights.app', 'Contents', 'MacOS', 'UnrealInsights'),
          path.join(binaries, 'Mac', 'UnrealInsights')
        ]
      : [path.join(binaries, 'Win64', 'UnrealInsights.exe')]
  for (const candidate of candidates) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue
      await fs.access(candidate, platform === 'darwin' ? constants.X_OK : constants.F_OK)
      return candidate
    } catch {
      /* Missing optional program or incomplete installation. */
    }
  }
  return null
}

export async function discoverMacEngineRoots(
  directories: readonly string[] = MAC_ENGINE_DIRECTORIES
): Promise<string[]> {
  const roots: string[] = []
  for (const directory of directories) {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        roots.push(path.join(directory, entry.name))
      }
    } catch {
      // Missing directories and permissions must not prevent manual engine registration.
    }
  }
  return roots
}
