import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function pluginPlatform(platform = process.platform) {
  return platform === 'darwin'
    ? {
        target: 'Mac',
        binary: 'UnrealEditor-UnrealAgentLink.dylib',
        script: ['Mac', 'Build.sh'],
        suffix: '-Mac'
      }
    : {
        target: 'Win64',
        binary: 'UnrealEditor-UnrealAgentLink.dll',
        script: ['Build.bat'],
        suffix: ''
      }
}

export function installedMacEngines(
  directories = [
    '/Users/Shared/Epic Games',
    '/Users/Shared/EpicGames',
    '/Users/Shared/UnrealEngine'
  ]
) {
  const engines = new Map()
  for (const directory of directories) {
    let entries
    try {
      entries = readdirSync(directory)
    } catch {
      continue
    }
    for (const entry of entries) {
      const root = join(directory, entry)
      try {
        const build = JSON.parse(
          readFileSync(join(root, 'Engine', 'Build', 'Build.version'), 'utf8')
        )
        if (!Number.isInteger(build.MajorVersion) || !Number.isInteger(build.MinorVersion)) continue
        if (!existsSync(join(root, 'Engine', 'Build', 'BatchFiles', 'Mac', 'Build.sh'))) continue
        engines.set(`${build.MajorVersion}.${build.MinorVersion}`, root)
      } catch {
        /* Not an engine installation. */
      }
    }
  }
  return engines
}
