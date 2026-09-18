/**
 * @vitest-environment node
 *
 * 知识库片段的全文索引。
 *
 * 这里最要紧的三条：
 * 1. **中文两个字也搜得到** —— 「椅子」必须命中「木头椅子」。
 * 2. **删片段时索引跟着走** —— 按来源删、按知识库删、删来源级联，三条路都不能留孤儿。
 * 3. **老库自动回填** —— 升级前建好的片段没有索引行，第一次建表时要补上，用户不用重训。
 *
 * 向量表要 sqlite-vec 原生扩展，测试环境里不加载；建表处会 warn 一句然后继续。
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/notebookRagConfig', () => ({ getEmbeddingDim: () => 4 }))

import { createNotebook, createNotebookSource, initNotebookModel } from './notebook'
import {
  createNotebookChunk,
  deleteNotebookChunksByNotebook,
  deleteNotebookChunksBySource,
  initNotebookRagModel,
  NOTEBOOK_FTS_TABLE,
  searchNotebookChunksByKeyword
} from './notebookRag'
import { buildFtsMatchQuery } from './ftsText'

let db: Database.Database

const ftsCount = (): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${NOTEBOOK_FTS_TABLE}`).get() as { n: number }).n)

const addChunk = (notebookId: string, sourceId: string, index: number, content: string): number =>
  createNotebookChunk(db, {
    chunkId: `${sourceId}-${index}`,
    notebookId,
    sourceId,
    content,
    chunkIndex: index
  })

const search = (notebookId: string, query: string, sourceIds?: string[]): string[] =>
  searchNotebookChunksByKeyword(db, notebookId, buildFtsMatchQuery(query)!, 10, sourceIds).map(
    (hit) => hit.chunkId
  )

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initNotebookModel(db)
  initNotebookRagModel(db)

  createNotebook(db, { notebookId: 'nb1', title: '家具' })
  createNotebook(db, { notebookId: 'nb2', title: '别的库' })
  createNotebookSource(db, {
    sourceId: 's1',
    notebookId: 'nb1',
    title: '椅子',
    type: 'text',
    content: 'x'
  })
  createNotebookSource(db, {
    sourceId: 's2',
    notebookId: 'nb1',
    title: '桌子',
    type: 'text',
    content: 'x'
  })
  createNotebookSource(db, {
    sourceId: 's3',
    notebookId: 'nb2',
    title: '其它',
    type: 'text',
    content: 'x'
  })
})

describe('关键词检索', () => {
  it('中文两个字的词能命中长句', () => {
    addChunk('nb1', 's1', 0, '这把木头椅子适合放在客厅')
    addChunk('nb1', 's2', 0, '这张桌子是金属的')

    expect(search('nb1', '椅子')).toEqual(['s1-0'])
  })

  it('英文按前缀匹配，且不分大小写', () => {
    addChunk('nb1', 's1', 0, 'Use Nanite for high-poly static meshes')
    addChunk('nb1', 's2', 0, 'Lumen handles global illumination')

    expect(search('nb1', 'nanite')).toEqual(['s1-0'])
    expect(search('nb1', 'MESH')).toEqual(['s1-0'])
  })

  it('多个词之间是 OR，全中的排在只中一个的前面', () => {
    addChunk('nb1', 's1', 0, '椅子 材质 木头')
    addChunk('nb1', 's2', 0, '桌子 材质 玻璃')

    expect(search('nb1', '椅子 材质')).toEqual(['s1-0', 's2-0'])
  })

  it('只搜当前知识库，且可以再按来源收窄', () => {
    addChunk('nb1', 's1', 0, '椅子 A')
    addChunk('nb1', 's2', 0, '椅子 B')
    addChunk('nb2', 's3', 0, '椅子 C')

    expect(search('nb1', '椅子').sort()).toEqual(['s1-0', 's2-0'])
    expect(search('nb1', '椅子', ['s2'])).toEqual(['s2-0'])
    expect(search('nb2', '椅子')).toEqual(['s3-0'])
  })

  it('命中带来源标题，且不带向量距离', () => {
    addChunk('nb1', 's1', 0, '椅子')

    const [hit] = searchNotebookChunksByKeyword(db, 'nb1', buildFtsMatchQuery('椅子')!, 10)
    expect(hit.sourceTitle).toBe('椅子')
    expect(hit.distance).toBeNull()
  })
})

describe('索引跟着片段走', () => {
  it('按来源删片段，索引行一起没了', () => {
    addChunk('nb1', 's1', 0, '椅子')
    addChunk('nb1', 's2', 0, '桌子')
    expect(ftsCount()).toBe(2)

    deleteNotebookChunksBySource(db, 's1')

    expect(ftsCount()).toBe(1)
    expect(search('nb1', '椅子')).toEqual([])
    expect(search('nb1', '桌子')).toEqual(['s2-0'])
  })

  it('按知识库删片段，索引行一起没了', () => {
    addChunk('nb1', 's1', 0, '椅子')
    addChunk('nb2', 's3', 0, '椅子')

    deleteNotebookChunksByNotebook(db, 'nb1')

    expect(ftsCount()).toBe(1)
    expect(search('nb2', '椅子')).toEqual(['s3-0'])
  })

  it('删来源时外键级联删片段，索引也不留孤儿', () => {
    addChunk('nb1', 's1', 0, '椅子')

    db.prepare('DELETE FROM notebook_sources WHERE source_id = ?').run('s1')

    expect(ftsCount()).toBe(0)
  })
})

describe('老库回填', () => {
  it('升级前已有的片段在第一次建表时进索引', () => {
    // 模拟升级前的库：片段在、索引表不在
    addChunk('nb1', 's1', 0, '这把椅子是升级前灌进去的')
    db.exec(`DROP TRIGGER notebook_chunks_fts_delete; DROP TABLE ${NOTEBOOK_FTS_TABLE};`)

    initNotebookRagModel(db)

    expect(ftsCount()).toBe(1)
    expect(search('nb1', '椅子')).toEqual(['s1-0'])
  })

  it('表已存在时重复初始化不会把索引灌两遍', () => {
    addChunk('nb1', 's1', 0, '椅子')

    initNotebookRagModel(db)

    expect(ftsCount()).toBe(1)
  })
})
