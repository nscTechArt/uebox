import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveProjectFilePath } from './projectImportPath'

describe('resolveProjectFilePath', () => {
  let tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    tempDirs = []
  })

  it('keeps an explicit .uproject file path', async () => {
    const projectFile = join('E:', 'work', 'TQYS', 'TQYS.uproject')

    await expect(resolveProjectFilePath({ originPath: projectFile })).resolves.toBe(projectFile)
  })

  it('resolves a project directory that contains one .uproject file', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ue-project-'))
    tempDirs.push(projectDir)

    const projectFile = join(projectDir, 'TQYS.uproject')
    await writeFile(projectFile, '{}')

    await expect(resolveProjectFilePath({ projectPath: projectDir })).resolves.toBe(projectFile)
  })
})
