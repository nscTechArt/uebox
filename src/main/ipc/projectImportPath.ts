import { promises as fs } from 'fs'
import path from 'path'

export type ProjectImportPathRecord = {
  projectName?: string | null
  projectPath?: string | null
  originPath?: string | null
}

export async function resolveProjectFilePath(
  project: ProjectImportPathRecord
): Promise<string | null> {
  const candidates = [project.originPath, project.projectPath]
    .map((value) => String(value || '').trim())
    .filter((value, index, arr) => value && arr.indexOf(value) === index)

  for (const candidate of candidates) {
    if (candidate.toLowerCase().endsWith('.uproject')) {
      return candidate
    }

    try {
      const stat = await fs.stat(candidate)
      if (!stat.isDirectory()) continue

      const entries = await fs.readdir(candidate)
      const projectFiles = entries.filter((entry) => entry.toLowerCase().endsWith('.uproject'))
      if (projectFiles.length === 1) {
        return path.join(candidate, projectFiles[0])
      }
    } catch {
      // Ignore inaccessible candidates and try the next stored path.
    }
  }

  return null
}
