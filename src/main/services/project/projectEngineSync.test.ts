import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 库里的 EngineAssociation 是登记那一刻抄的，用户在 Launcher 里把工程
 * 从 5.7 升到 5.8 之后库里还是 5.7：卡片显示旧版本，导入闸门拿旧版本拦资产。
 * 这里保证每次拉列表都对齐到磁盘上的 .uproject。
 */

const mocks = vi.hoisted(() => ({
  updateProject: vi.fn(() => true)
}))

vi.mock('../../sqliteDataBase/models/project', () => ({
  updateProject: mocks.updateProject
}))

import { readEngineAssociationFromDisk, syncProjectEngineAssociations } from './projectEngineSync'

let projectDir = ''
let uprojectPath = ''
const db = {} as never

function writeUproject(engine: string | undefined, encoding: 'utf-8' | 'utf16le' = 'utf-8'): void {
  const body = JSON.stringify({ FileVersion: 3, EngineAssociation: engine, Modules: [] })
  if (encoding === 'utf16le') {
    writeFileSync(
      uprojectPath,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')])
    )
    return
  }
  writeFileSync(uprojectPath, body, 'utf-8')
}

beforeEach(() => {
  mocks.updateProject.mockClear()
  projectDir = mkdtempSync(join(tmpdir(), 'engine-sync-'))
  uprojectPath = join(projectDir, 'MyGame.uproject')
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

describe('readEngineAssociationFromDisk', () => {
  it('reads the version the .uproject currently declares', async () => {
    writeUproject('5.8')
    await expect(
      readEngineAssociationFromDisk({ originPath: uprojectPath, projectPath: projectDir })
    ).resolves.toBe('5.8')
  })

  it('handles UTF-16 .uproject files the engine writes for non-ASCII projects', async () => {
    writeUproject('5.8', 'utf16le')
    await expect(readEngineAssociationFromDisk({ originPath: uprojectPath })).resolves.toBe('5.8')
  })

  it('finds the .uproject when only the directory is stored', async () => {
    writeUproject('5.8')
    await expect(readEngineAssociationFromDisk({ projectPath: projectDir })).resolves.toBe('5.8')
  })

  it('returns null when the project cannot be read', async () => {
    await expect(
      readEngineAssociationFromDisk({ originPath: join(projectDir, 'Gone.uproject') })
    ).resolves.toBeNull()
    writeFileSync(uprojectPath, '{ not json', 'utf-8')
    await expect(readEngineAssociationFromDisk({ originPath: uprojectPath })).resolves.toBeNull()
  })
})

describe('syncProjectEngineAssociations', () => {
  it('writes the upgraded version back to the record and the database', async () => {
    writeUproject('5.8')
    const records = [
      {
        projectKey: 'k1',
        projectName: 'MyGame',
        EngineAssociation: '5.7',
        originPath: uprojectPath
      }
    ]

    const result = await syncProjectEngineAssociations(db, records)

    expect(result[0].EngineAssociation).toBe('5.8')
    expect(mocks.updateProject).toHaveBeenCalledWith(db, 'k1', { EngineAssociation: '5.8' })
  })

  it('does not touch the database when nothing changed', async () => {
    writeUproject('5.7')
    const records = [{ projectKey: 'k1', EngineAssociation: '5.7', originPath: uprojectPath }]

    await syncProjectEngineAssociations(db, records)

    expect(mocks.updateProject).not.toHaveBeenCalled()
  })

  it('keeps the stored version when the project is unreachable', async () => {
    const records = [
      {
        projectKey: 'k1',
        EngineAssociation: '5.7',
        originPath: join('Z:', 'unplugged', 'X.uproject')
      }
    ]

    const result = await syncProjectEngineAssociations(db, records)

    expect(result[0].EngineAssociation).toBe('5.7')
    expect(mocks.updateProject).not.toHaveBeenCalled()
  })

  it('records a GUID when the project moved to a source-built engine', async () => {
    const guid = '{DAB4E4C9-1234-5678-9ABC-DEF012345678}'
    writeUproject(guid)
    const records = [{ projectKey: 'k1', EngineAssociation: '5.7', originPath: uprojectPath }]

    const result = await syncProjectEngineAssociations(db, records)

    expect(result[0].EngineAssociation).toBe(guid)
  })
})
