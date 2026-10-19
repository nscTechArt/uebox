/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import {
  ARCHIVE_BUDGET_CHARS,
  type ArchivableCall,
  archiveResult,
  createResultArchiver,
  describeSnapshot,
  detailsForRenderer,
  lastRefIn,
  queryArchive
} from './resultArchive'

const SPEC = { lists: { templates: ['name', 'category'], projects: ['name'] } }

/** 300 个模板，每个带一段长描述 —— 形状照着 project_list 的 list_templates */
function templates(count = 300): Record<string, unknown> {
  return {
    success: true,
    templates: Array.from({ length: count }, (_, i) => ({
      name: `Template_${i}`,
      category: i % 3 === 0 ? 'Games' : 'Film',
      path: `C:/UE_5.5/Templates/TP_${i}/TP_${i}.uproject`,
      description: '一段很长的模板说明，'.repeat(8),
      nested: { tags: [`tag-${i}`, i % 2 === 0 ? 'even' : 'odd'] }
    }))
  }
}

function archived(result = templates()): { text: string; preview: Record<string, unknown> } {
  const text = JSON.stringify(result)
  const outcome = archiveResult(text, SPEC, 'r1')
  expect(outcome).not.toBeNull()
  return { text, preview: JSON.parse(outcome!.text) as Record<string, unknown> }
}

describe('archiveResult', () => {
  it('不超预算的结果原样给', () => {
    expect(archiveResult(JSON.stringify(templates(3)), SPEC, 'r1')).toBeNull()
  })

  it('超预算时给目录页：表外字段原样，表只留目录列，整页不超预算', () => {
    const { text, preview } = archived()
    const outcome = archiveResult(text, SPEC, 'r1')!

    expect(outcome.text.length).toBeLessThanOrEqual(ARCHIVE_BUDGET_CHARS)
    expect(preview.success).toBe(true)
    const rows = preview.templates as Array<Record<string, unknown>>
    expect(Object.keys(rows[0]).sort()).toEqual(['category', 'name'])
    const meta = preview.archived as Record<string, unknown>
    expect(meta).toMatchObject({ ref: 'r1', list: 'templates', total_rows: 300 })
    expect(meta.shown_rows).toBe(rows.length)
    // 明说缺了什么、怎么拿
    expect(String(meta.note)).toContain('result_query')
    expect(String(meta.note)).toContain('r1')
    expect(meta.all_columns).toEqual(['name', 'category', 'path', 'description', 'nested'])
    // 完整文本原样存着
    expect(outcome.record).toEqual({ ref: 'r1', list: 'templates', text })
  })

  it('目录列塞得下就全列出来，说明里不再提「其余的行」', () => {
    const { preview } = archived(templates(120))
    const meta = preview.archived as { shown_rows: number; note: string }
    expect(meta.shown_rows).toBe(120)
    expect(meta.note).not.toContain('其余')
  })

  it('塞不下时说清还差多少行', () => {
    const { preview } = archived(templates(1000))
    expect(JSON.stringify(preview).length).toBeLessThanOrEqual(ARCHIVE_BUDGET_CHARS)
    const meta = preview.archived as { shown_rows: number; note: string }
    expect(meta.shown_rows).toBeLessThan(1000)
    expect(meta.note).toContain(`其余 ${1000 - meta.shown_rows} 行`)
  })

  it('同一个工具的另一张表（list_projects）也认', () => {
    const result = {
      success: true,
      projects: Array.from({ length: 200 }, (_, i) => ({ name: `P${i}`, path: 'x'.repeat(100) }))
    }
    const { preview } = archived(result as unknown as Record<string, unknown>)
    expect((preview.archived as { list: string }).list).toBe('projects')
  })

  it('不是 JSON、或者声明的表不在，都原样给', () => {
    expect(archiveResult('x'.repeat(ARCHIVE_BUDGET_CHARS + 1), SPEC, 'r1')).toBeNull()
    const other = JSON.stringify({ items: templates().templates })
    expect(archiveResult(other, SPEC, 'r1')).toBeNull()
  })
})

describe('queryArchive', () => {
  const record = (): { ref: string; list: string; text: string } => ({
    ref: 'r1',
    list: 'templates',
    text: JSON.stringify(templates())
  })

  it('where 等值筛不分大小写，返回完整的行', () => {
    const out = queryArchive(record(), { where: { name: 'template_42' } })
    expect(out.matched).toBe(1)
    const [row] = out.rows as Array<Record<string, unknown>>
    expect(row.name).toBe('Template_42')
    expect(row.description).toBeDefined()
  })

  it('where 给数组表示任一，fields 只挑列', () => {
    const out = queryArchive(record(), {
      where: { name: ['Template_1', 'Template_2'] },
      fields: ['name', 'path']
    })
    expect(out.rows).toEqual([
      { name: 'Template_1', path: 'C:/UE_5.5/Templates/TP_1/TP_1.uproject' },
      { name: 'Template_2', path: 'C:/UE_5.5/Templates/TP_2/TP_2.uproject' }
    ])
  })

  it('search 在嵌套的文字里找子串', () => {
    const out = queryArchive(record(), { search: 'TAG-7', fields: ['name'] })
    expect((out.rows as Array<{ name: string }>).map((row) => row.name)).toContain('Template_7')
  })

  it('一页塞不下就给 next_offset，接着翻能翻完', () => {
    const first = queryArchive(record(), {})
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(ARCHIVE_BUDGET_CHARS)
    expect(first.next_offset).toBe(first.returned)

    let seen = first.returned as number
    let offset = first.next_offset as number | undefined
    while (offset !== undefined) {
      const page = queryArchive(record(), { offset })
      seen += page.returned as number
      offset = page.next_offset as number | undefined
    }
    expect(seen).toBe(300)
  })

  it('limit 收得比一页小时，后面还有就给 next_offset', () => {
    const out = queryArchive(record(), { limit: 5, fields: ['name'] })
    expect(out.returned).toBe(5)
    expect(out.next_offset).toBe(5)
  })

  it('写错列名时说出来，并给出全部列名', () => {
    const out = queryArchive(record(), { where: { title: 'x' } })
    expect(out.matched).toBe(0)
    expect(out.unknown_columns).toEqual(['title'])
    expect(out.columns).toContain('name')
  })
})

describe('describeSnapshot', () => {
  const archiveMessage = {
    role: 'toolResult',
    toolCallId: 'c1',
    toolName: 'project_list',
    details: { archive: { ref: 'r1', list: 'templates', text: '{}' } }
  }
  const assistant = (id: string, name: string, args: unknown): unknown => ({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }]
  })
  const result = (id: string, name: string, isError = false): unknown => ({
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    isError
  })
  const mutating = (name: string, args: unknown): boolean =>
    name === 'project_manage' && (args as { action?: string })?.action !== 'dry_run'

  it('之后没动过东西就直说', () => {
    const note = describeSnapshot([archiveMessage], 'r1', mutating)?.note
    expect(note).toContain('没有执行过修改类工具')
  })

  it('只数存档之后、成功的修改类调用，按参数算风险', () => {
    const messages = [
      assistant('c0', 'project_manage', { action: 'create' }),
      result('c0', 'project_manage'),
      archiveMessage,
      assistant('c2', 'project_manage', { action: 'create' }),
      result('c2', 'project_manage'),
      assistant('c3', 'project_manage', { action: 'dry_run' }),
      result('c3', 'project_manage'),
      assistant('c4', 'project_manage', { action: 'create' }),
      result('c4', 'project_manage', true)
    ]
    const note = describeSnapshot(messages, 'r1', mutating)?.note
    expect(note).toContain('执行过 1 个修改类工具')
    expect(note).toContain('重新调用 project_list')
  })

  it('找不到编号返回 undefined', () => {
    expect(describeSnapshot([archiveMessage], 'r9', mutating)).toBeUndefined()
  })
})

describe('createResultArchiver', () => {
  type Part = { type: string; text?: string }
  const bigCall = (details: unknown = { success: true }): ArchivableCall<Part> => ({
    isError: false,
    toolCall: { name: 'project_list' },
    result: {
      content: [{ type: 'text', text: JSON.stringify(templates()) }],
      details
    }
  })

  const archiver = (
    overrides: Partial<Parameters<typeof createResultArchiver>[0]> = {}
  ): ReturnType<typeof createResultArchiver> =>
    createResultArchiver({
      getMessages: () => [],
      specFor: (name) => (name === 'project_list' ? SPEC : undefined),
      canQuery: () => true,
      loadQueryTool: () => ({ loadedToolNames: ['result_query'], loadedGroups: ['core.result'] }),
      ...overrides
    })

  it('改写 content，details 原有字段不动，挂上存档和工具加载记录', () => {
    const out = archiver()(bigCall({ success: true, templates: [] }))!
    const text = out.content[0].text ?? ''
    expect(text.length).toBeLessThanOrEqual(ARCHIVE_BUDGET_CHARS)
    expect(out.details.success).toBe(true)
    expect(out.details.templates).toEqual([])
    expect((out.details.archive as { ref: string }).ref).toBe('r1')
    expect(out.details.toolSearch).toEqual({
      loadedToolNames: ['result_query'],
      loadedGroups: ['core.result']
    })
  })

  it('同一轮并行的两个结果拿到不同编号，并接着历史往后编', () => {
    const history = [
      { role: 'toolResult', details: { archive: { ref: 'r4', list: 'x', text: '{}' } } }
    ]
    const archive = archiver({ getMessages: () => history })
    expect((archive(bigCall())!.details.archive as { ref: string }).ref).toBe('r5')
    expect((archive(bigCall())!.details.archive as { ref: string }).ref).toBe('r6')
  })

  it('没有 result_query 可用、工具没声明、或者是错误结果，都不存', () => {
    expect(archiver({ canQuery: () => false })(bigCall())).toBeUndefined()
    expect(archiver({ specFor: () => undefined })(bigCall())).toBeUndefined()
    expect(archiver()({ ...bigCall(), isError: true })).toBeUndefined()
  })

  it('图片块原样留着', () => {
    const call = bigCall()
    call.result.content!.push({ type: 'image' })
    const out = archiver()(call)!
    expect(out.content.map((part) => part.type)).toEqual(['text', 'image'])
  })
})

describe('辅助函数', () => {
  it('lastRefIn 取历史里最大的编号', () => {
    const at = (ref: string): unknown => ({
      role: 'toolResult',
      details: { archive: { ref, list: 'x', text: '{}' } }
    })
    expect(lastRefIn([at('r2'), at('r10'), { role: 'user' }])).toBe(10)
    expect(lastRefIn([])).toBe(0)
  })

  it('发给界面时剔掉完整文本，只留编号', () => {
    const details = {
      success: true,
      archive: { ref: 'r1', list: 'templates', text: 'x'.repeat(99) }
    }
    expect(detailsForRenderer(details)).toEqual({
      success: true,
      archive: { ref: 'r1', list: 'templates' }
    })
    expect(detailsForRenderer({ success: true })).toEqual({ success: true })
  })
})
