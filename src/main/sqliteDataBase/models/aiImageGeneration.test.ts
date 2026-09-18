import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import {
  createAiImageGeneration,
  getAiImageGenerationById,
  initAiImageGenerationModel,
  listAiImageGenerations,
  updateAiImageGeneration
} from './aiImageGeneration'

const TABLE_NAME = 'ai_image_generations'

function columnNames(db: Database.Database): string[] {
  return (db.prepare(`PRAGMA table_info(${TABLE_NAME})`).all() as { name: string }[]).map(
    (column) => column.name
  )
}

/** 升级之前那版表结构：没有 local_paths */
function createLegacyTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT UNIQUE,
      prompt TEXT,
      name TEXT,
      status TEXT DEFAULT 'pending',
      progress INTEGER DEFAULT 0,
      image_urls TEXT,
      reference_images TEXT,
      ratio TEXT,
      model TEXT,
      style TEXT,
      count INTEGER DEFAULT 1,
      error_msg TEXT,
      provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `)
}

describe('aiImageGeneration 的本地路径落库', () => {
  it('全新安装就带 local_paths 列', () => {
    const db = new Database(':memory:')
    initAiImageGenerationModel(db)

    expect(columnNames(db)).toContain('local_paths')
  })

  it('老库升级时补出 local_paths 列，并且不丢已有记录', () => {
    const db = new Database(':memory:')
    createLegacyTable(db)
    db.prepare(
      `INSERT INTO ${TABLE_NAME} (task_id, prompt, status, image_urls)
       VALUES ('old_task', '一把剑', 'completed', '["https://cdn.example.com/old.png"]')`
    ).run()

    initAiImageGenerationModel(db)

    expect(columnNames(db)).toContain('local_paths')

    const [record] = listAiImageGenerations(db)
    expect(record.task_id).toBe('old_task')
    expect(record.image_urls).toBe('["https://cdn.example.com/old.png"]')
    // 老记录补不出本地副本，只能继续用原来的地址
    expect(record.local_paths ?? null).toBeNull()
  })

  it('生成完成时写进去的本地路径，重新读出来还在', () => {
    const db = new Database(':memory:')
    initAiImageGenerationModel(db)

    const id = createAiImageGeneration(db, { task_id: 'task_1', prompt: '一把剑' })
    const savedPaths = ['H:/vault/AIGC/图片/剑_1.png', 'H:/vault/AIGC/图片/剑_2.png']

    updateAiImageGeneration(db, id, {
      status: 'completed',
      progress: 100,
      image_urls: JSON.stringify(['https://cdn.example.com/1.png', 'data:image/png;base64,AAAA']),
      local_paths: JSON.stringify(savedPaths)
    })

    const record = getAiImageGenerationById(db, id)
    expect(JSON.parse(record!.local_paths!)).toEqual(savedPaths)
  })

  it('创建记录时就能带上 local_paths（INSERT 的列没漏）', () => {
    const db = new Database(':memory:')
    initAiImageGenerationModel(db)

    const id = createAiImageGeneration(db, {
      task_id: 'task_2',
      local_paths: JSON.stringify(['C:/vault/a.png'])
    })

    expect(JSON.parse(getAiImageGenerationById(db, id)!.local_paths!)).toEqual(['C:/vault/a.png'])
  })
})
