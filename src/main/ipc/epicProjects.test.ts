// @vitest-environment node
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'

const imported = vi.hoisted(() => vi.fn(() => false))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../sqliteDataBase', () => ({ getPublicDatabase: () => ({}) }))
vi.mock('../sqliteDataBase/models/project', () => ({ projectExistsByPath: imported }))
import { getRecentProjectsFromAllEngines } from './epicProjects'

let home: string
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'uebox-recent-'))
  imported.mockReset().mockReturnValue(false)
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

async function fixture(
  platform: 'darwin' | 'win32',
  folder: string,
  version = '5.5'
): Promise<string> {
  const root =
    platform === 'darwin'
      ? path.join(home, 'Library/Application Support/Epic/UnrealEngine')
      : path.join(home, 'local/UnrealEngine')
  const ini = path.join(root, version, 'Saved/Config', folder, 'EditorSettings.ini')
  const project = path.join(home, `中文 Project ${version}`, '示例.uproject')
  await fs.mkdir(path.dirname(ini), { recursive: true })
  await fs.mkdir(path.dirname(project), { recursive: true })
  await fs.writeFile(project, '{}')
  await fs.writeFile(
    ini,
    `[/Script/UnrealEd.EditorSettings]\nRecentlyOpenedProjectFiles=(ProjectName="${project}",LastOpenTime=2026.09.01-12.30.00)`
  )
  return project
}

it('reads MacEditor history, import status, and thumbnails from actual files', async () => {
  const project = await fixture('darwin', 'MacEditor')
  const thumbnail = path.join(path.dirname(project), '示例.png')
  await fs.writeFile(thumbnail, 'fixture')
  imported.mockReturnValue(true)
  const results = await getRecentProjectsFromAllEngines({ platform: 'darwin', home })
  expect(results).toEqual([
    {
      projectPath: project,
      projectName: '示例',
      engineVersion: '5.5',
      lastOpenTime: '2026-09-01T12:30:00',
      isImported: true,
      thumbnailPath: thumbnail
    }
  ])
  expect(imported).toHaveBeenCalledWith(expect.anything(), path.dirname(project))
})

it('falls back to Mac history for older engines and skips deleted projects', async () => {
  const old = await fixture('darwin', 'Mac', '4.27')
  const deleted = await fixture('darwin', 'MacEditor')
  await fs.unlink(deleted)
  const results = await getRecentProjectsFromAllEngines({ platform: 'darwin', home })
  expect(results.map((entry) => entry.projectPath)).toEqual([old])
})

it('prefers MacEditor without duplicating the legacy history', async () => {
  await fixture('darwin', 'MacEditor')
  await fixture('darwin', 'Mac')
  expect(await getRecentProjectsFromAllEngines({ platform: 'darwin', home })).toHaveLength(1)
})

it('preserves Windows LOCALAPPDATA and WindowsEditor lookup', async () => {
  const project = await fixture('win32', 'WindowsEditor')
  const results = await getRecentProjectsFromAllEngines({
    platform: 'win32',
    home,
    localAppData: path.join(home, 'local')
  })
  expect(results.map((entry) => entry.projectPath)).toEqual([project])
})

it('returns an empty list when this user has no engine configuration', async () => {
  expect(await getRecentProjectsFromAllEngines({ platform: 'darwin', home })).toEqual([])
})
