/**
 * @vitest-environment node
 *
 * 来源的上下文档位，以及升级老库时的两段一次性迁移。
 *
 * 这两段迁移动的是用户攒下来的资料，做错了没有第二次机会：
 * 1. `selected` 布尔值要变成三档里的 `full` / `excluded`，取消勾选过的来源
 *    升级之后不能悄悄又进上下文（那等于把用户排除掉的资料又喂给了模型）。
 * 2. `summary_content` 里那份和正文一模一样的副本要清掉 —— 它是旧版「去噪清洗」
 *    的产物，当摘要用一个字都省不下来。
 */

import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createNotebook,
  createNotebookSource,
  getNotebookSourceBySourceId,
  getNotebookSources,
  initNotebookModel,
  updateNotebookSource
} from './notebook'

let db: Database.Database
let notebookId: string

beforeEach(() => {
  db = new Database(':memory:')
  initNotebookModel(db)
  notebookId = createNotebook(db, { title: '测试知识库' })
})

const addSource = (title: string, content = '正文'): string =>
  createNotebookSource(db, { sourceId: `src-${title}`, notebookId, title, type: 'text', content })

describe('上下文档位', () => {
  it('新来源默认全文进上下文', () => {
    const sourceId = addSource('甲')
    expect(getNotebookSourceBySourceId(db, sourceId)?.contextLevel).toBe('full')
  })

  it('三档都能存能取', () => {
    const sourceId = addSource('甲')

    for (const level of ['summary', 'excluded', 'full'] as const) {
      updateNotebookSource(db, sourceId, { contextLevel: level })
      expect(getNotebookSourceBySourceId(db, sourceId)?.contextLevel).toBe(level)
    }
  })

  it('库里存了个认不出来的值，读出来当全文', () => {
    const sourceId = addSource('甲')
    db.prepare(`UPDATE notebook_sources SET context_level = 'nonsense' WHERE source_id = ?`).run(
      sourceId
    )
    expect(getNotebookSourceBySourceId(db, sourceId)?.contextLevel).toBe('full')
  })
})

describe('正文变了之后', () => {
  it('旧摘要跟着作废 —— 留着的话摘要档会一直按上一版内容回答', () => {
    const sourceId = addSource('甲', '第一版正文')
    updateNotebookSource(db, sourceId, {
      summaryContent: '第一版的摘要',
      summaryStatus: 'completed'
    })

    updateNotebookSource(db, sourceId, { content: '第二版正文' })

    const source = getNotebookSourceBySourceId(db, sourceId)
    expect(source?.summaryContent).toBeNull()
    expect(source?.summaryStatus).toBeNull()
  })

  it('同一次调用里显式给了新摘要就留着 —— 导入流程会一起写', () => {
    const sourceId = addSource('甲', '第一版正文')

    updateNotebookSource(db, sourceId, {
      content: '第二版正文',
      summaryContent: '第二版的摘要',
      summaryStatus: 'completed'
    })

    expect(getNotebookSourceBySourceId(db, sourceId)?.summaryContent).toBe('第二版的摘要')
  })
})

describe('原文另存', () => {
  it('清洗后的正文和抓回来的原文各存一份，都拿得回来', () => {
    const sourceId = addSource('某网页', '抓回来的原文')

    updateNotebookSource(db, sourceId, {
      content: '清洗后的正文',
      rawContent: '抓回来的原文'
    })

    const source = getNotebookSourceBySourceId(db, sourceId)
    expect(source?.content).toBe('清洗后的正文')
    expect(source?.rawContent).toBe('抓回来的原文')
  })

  it('没清洗过的来源没有原文副本', () => {
    const sourceId = addSource('纯文本')
    expect(getNotebookSourceBySourceId(db, sourceId)?.rawContent).toBeNull()
  })

  it('原文能在创建时就一起写进去', () => {
    const sourceId = createNotebookSource(db, {
      sourceId: 'src-with-raw',
      notebookId,
      title: '网页',
      type: 'link',
      content: '清洗后',
      rawContent: '原文'
    })
    expect(getNotebookSourceBySourceId(db, sourceId)?.rawContent).toBe('原文')
  })
})

describe('老库迁移', () => {
  it('selected = 0 的来源升级后是「不进上下文」，其余是全文', () => {
    const excluded = addSource('取消勾选过的')
    const kept = addSource('一直勾着的')

    // 模拟升级前的库：只有 selected，没有 context_level
    db.prepare(`UPDATE notebook_sources SET context_level = NULL`).run()
    db.prepare(`UPDATE notebook_sources SET selected = 0 WHERE source_id = ?`).run(excluded)
    db.prepare(`UPDATE notebook_sources SET selected = 1 WHERE source_id = ?`).run(kept)

    initNotebookModel(db)

    expect(getNotebookSourceBySourceId(db, excluded)?.contextLevel).toBe('excluded')
    expect(getNotebookSourceBySourceId(db, kept)?.contextLevel).toBe('full')
  })

  it('已经有档位的行不会被 selected 覆盖回去', () => {
    const sourceId = addSource('甲')
    updateNotebookSource(db, sourceId, { contextLevel: 'summary' })
    db.prepare(`UPDATE notebook_sources SET selected = 0 WHERE source_id = ?`).run(sourceId)

    initNotebookModel(db)

    expect(getNotebookSourceBySourceId(db, sourceId)?.contextLevel).toBe('summary')
  })

  it('和正文一模一样的旧「摘要」被清掉，真摘要留着', () => {
    const duplicated = addSource('清洗过的网页', '一段网页正文')
    const real = addSource('有真摘要的', '一段很长的正文')

    db.prepare(
      `UPDATE notebook_sources SET summary_content = content, summary_status = 'completed'
       WHERE source_id = ?`
    ).run(duplicated)
    db.prepare(
      `UPDATE notebook_sources SET summary_content = '压缩过的摘要', summary_status = 'completed'
       WHERE source_id = ?`
    ).run(real)

    initNotebookModel(db)

    expect(getNotebookSourceBySourceId(db, duplicated)?.summaryContent).toBeNull()
    expect(getNotebookSourceBySourceId(db, duplicated)?.summaryStatus).toBeNull()
    expect(getNotebookSourceBySourceId(db, real)?.summaryContent).toBe('压缩过的摘要')
  })

  it('迁移跑第二遍不会改动任何东西', () => {
    const sourceId = addSource('甲')
    updateNotebookSource(db, sourceId, { contextLevel: 'excluded' })

    initNotebookModel(db)
    initNotebookModel(db)

    expect(getNotebookSources(db, notebookId)[0].contextLevel).toBe('excluded')
  })
})
