import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { dropRetiredProductKnowledgeTables } from './index'

describe('dropRetiredProductKnowledgeTables', () => {
  const db = new Database(':memory:')

  afterEach(() => {
    db.exec(`
      DROP TABLE IF EXISTS product_knowledge_vectors;
      DROP TABLE IF EXISTS product_knowledge_chunks;
      DROP TABLE IF EXISTS product_knowledge;
      DROP TABLE IF EXISTS notebook_sources;
    `)
  })

  it('只清理旧版内置产品知识表，保留用户知识库表', () => {
    db.exec(`
      CREATE TABLE product_knowledge (id INTEGER PRIMARY KEY);
      CREATE TABLE product_knowledge_chunks (id INTEGER PRIMARY KEY);
      CREATE TABLE product_knowledge_vectors (id INTEGER PRIMARY KEY);
      CREATE TABLE notebook_sources (id INTEGER PRIMARY KEY);
    `)

    dropRetiredProductKnowledgeTables(db)

    const remaining = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('product_knowledge', 'product_knowledge_chunks', 'product_knowledge_vectors', 'notebook_sources') ORDER BY name"
      )
      .all() as Array<{ name: string }>

    expect(remaining).toEqual([{ name: 'notebook_sources' }])
  })

  it('在没有旧表的新数据库上可重复执行', () => {
    expect(() => dropRetiredProductKnowledgeTables(db)).not.toThrow()
    expect(() => dropRetiredProductKnowledgeTables(db)).not.toThrow()
  })
})
