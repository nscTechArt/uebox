import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readUeJsonFile, readUeTextFile } from './ueTextFile'
import { readEngineBuildVersion } from './unrealEnginePlatform'

/** Epic's Install.ini [Installations] maps build identifiers to engine roots. */
export function parseMacInstallations(content: string): Map<string, string> {
  const entries = new Map<string, string>()
  let inSection = false
  for (const raw of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^[;#]/.test(line)) continue
    if (line.startsWith('[')) {
      inSection = /^\[Installations\]$/i.test(line)
      continue
    }
    if (!inSection) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const identifier = line
      .slice(0, separator)
      .trim()
      .replace(/^\{|\}$/g, '')
      .toLowerCase()
    let root = line.slice(separator + 1).trim()
    if (root.startsWith('"') && root.endsWith('"')) root = root.slice(1, -1)
    if (identifier && path.posix.isAbsolute(root)) entries.set(identifier, root)
  }
  return entries
}

/** Read only Epic's two registration files; external disks need not use shared folders. */
export async function registeredMacEngineRoots(home: string): Promise<string[]> {
  const base = path.join(home, 'Library', 'Application Support', 'Epic')
  const roots: string[] = []
  try {
    const content = await readUeTextFile(path.join(base, 'UnrealEngine', 'Install.ini'))
    roots.push(...parseMacInstallations(content).values())
  } catch {
    // Source-build registration is optional and independent of Launcher records.
  }
  try {
    const content = await readUeJsonFile<{
      InstallationList?: Array<{
        ArtifactId?: string
        AppName?: string
        InstallLocation?: string
      }>
    }>(path.join(base, 'UnrealEngineLauncher', 'LauncherInstalled.dat'))
    if (Array.isArray(content?.InstallationList)) {
      for (const entry of content.InstallationList) {
        const name = entry?.ArtifactId ?? entry?.AppName
        if (typeof name !== 'string' || !/^UE_\d+\.\d+(?:\.\d+)?$/.test(name)) continue
        if (
          typeof entry.InstallLocation !== 'string' ||
          !path.posix.isAbsolute(entry.InstallLocation)
        )
          continue
        roots.push(entry.InstallLocation)
      }
    }
  } catch {
    // An absent or corrupt Launcher database must not hide source installations.
  }
  return [...new Set(roots)]
}

export async function resolveMacEngineAssociation(
  identifier: string,
  home: string
): Promise<{ version: string; engineRootPath: string } | null> {
  try {
    const file = path.join(
      home,
      'Library',
      'Application Support',
      'Epic',
      'UnrealEngine',
      'Install.ini'
    )
    const entries = parseMacInstallations(await fs.readFile(file, 'utf8'))
    const engineRootPath = entries.get(
      identifier
        .trim()
        .replace(/^\{|\}$/g, '')
        .toLowerCase()
    )
    if (!engineRootPath) return null
    const version = await readEngineBuildVersion(engineRootPath)
    return version ? { version: version.split('.').slice(0, 2).join('.'), engineRootPath } : null
  } catch {
    return null
  }
}
