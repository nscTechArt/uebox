/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import {
  ARCHIVE_BUDGET_CHARS,
  type ArchivableCall,
  archiveDataOf,
  archiveDetails,
  archiveResult,
  createResultArchiver,
  describeSnapshot,
  detailsForRenderer,
  lastRefIn,
  queryArchive
} from './resultArchive'

const SPEC = { lists: { templates: ['name', 'category'], projects: ['name'] } }

interface ArchivedMeta {
  ref: string
  note: string
  lists: Record<string, { total_rows: number; shown_rows: number }>
}

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
    const meta = preview.archived as {
      ref: string
      note: string
      lists: Record<string, { total_rows: number; shown_rows: number; all_columns: string[] }>
    }
    expect(meta.ref).toBe('r1')
    expect(meta.lists.templates).toMatchObject({ total_rows: 300, shown_rows: rows.length })
    // 明说缺了什么、怎么拿
    expect(meta.note).toContain('result_query')
    expect(meta.note).toContain('r1')
    expect(meta.lists.templates.all_columns).toEqual([
      'name',
      'category',
      'path',
      'description',
      'nested'
    ])
    // 完整文本原样存着
    expect(outcome.record).toEqual({ ref: 'r1', lists: ['templates'], text })
  })

  it('目录列塞得下就全列出来，说明里不再提「其余的行」', () => {
    const { preview } = archived(templates(120))
    const meta = preview.archived as ArchivedMeta
    expect(meta.lists.templates.shown_rows).toBe(120)
    expect(meta.note).not.toContain('其余')
  })

  it('塞不下时说清还差多少行', () => {
    const { preview } = archived(templates(1000))
    expect(JSON.stringify(preview).length).toBeLessThanOrEqual(ARCHIVE_BUDGET_CHARS)
    const meta = preview.archived as ArchivedMeta
    const shown = meta.lists.templates.shown_rows
    expect(shown).toBeLessThan(1000)
    expect(meta.note).toContain(`其余 ${1000 - shown} 行`)
  })

  it('同一个工具的另一张表（list_projects）也认', () => {
    const result = {
      success: true,
      projects: Array.from({ length: 200 }, (_, i) => ({ name: `P${i}`, path: 'x'.repeat(100) }))
    }
    const { preview } = archived(result as unknown as Record<string, unknown>)
    expect(Object.keys((preview.archived as ArchivedMeta).lists)).toEqual(['projects'])
  })

  it('多张表都换成目录，预算先给排在前面的表；查询示例带上 list', () => {
    const graph = {
      success: true,
      nodes: Array.from({ length: 200 }, (_, i) => ({
        id: `N${i}`,
        class: 'K2Node_CallFunction',
        pins: [{ name: 'execute', type: 'exec', default_value: 'x'.repeat(200) }]
      })),
      connections: Array.from({ length: 300 }, (_, i) => ({
        from_node: `N${i % 200}`,
        from_pin: 'then',
        to_node: `N${(i + 1) % 200}`,
        to_pin: 'execute'
      }))
    }
    const text = JSON.stringify(graph)
    const outcome = archiveResult(
      text,
      { lists: { nodes: ['id', 'class'], connections: ['from_node', 'to_node'] } },
      'r2'
    )!
    expect(outcome.text.length).toBeLessThanOrEqual(ARCHIVE_BUDGET_CHARS)
    const preview = JSON.parse(outcome.text) as Record<string, unknown>
    const meta = preview.archived as ArchivedMeta
    // 节点全列下了，连线拿剩下的预算
    expect(meta.lists.nodes.shown_rows).toBe(200)
    expect(meta.lists.connections.shown_rows).toBeLessThan(300)
    expect((preview.nodes as unknown[])[0]).toEqual({ id: 'N0', class: 'K2Node_CallFunction' })
    expect(meta.note).toContain('"list":"nodes"')
    expect(meta.note).toContain('nodes / connections')
    expect(outcome.record.lists).toEqual(['nodes', 'connections'])

    const linked = queryArchive(outcome.record, graph, {
      list: 'connections',
      where: { from_node: 'N5' }
    })
    expect(linked.matched).toBe(2)
    expect(() => queryArchive(outcome.record, graph, { list: 'pins' })).toThrow(
      /nodes、connections/
    )
  })

  it('不是 JSON、或者声明的表不在，都原样给', () => {
    expect(archiveResult('x'.repeat(ARCHIVE_BUDGET_CHARS + 1), SPEC, 'r1')).toBeNull()
    const other = JSON.stringify({ items: templates().templates })
    expect(archiveResult(other, SPEC, 'r1')).toBeNull()
  })
})

describe('archiveDetails', () => {
  it('完整数据超预算才存，返回的是补在正文后面的一句话', () => {
    const details = templates()
    const outcome = archiveDetails(details, SPEC, 'r4')!
    expect(outcome.note).toContain('r4')
    expect(outcome.note).toContain('templates 300 行')
    expect(outcome.note.length).toBeLessThan(300)
    // 表就在 details 里，不再存一份文本，并明说来源
    expect(outcome.record).toEqual({ ref: 'r4', lists: ['templates'], source: 'details' })
  })

  it('放得下就不存；details 不是对象也不存', () => {
    expect(archiveDetails(templates(3), SPEC, 'r1')).toBeNull()
    expect(archiveDetails('x'.repeat(ARCHIVE_BUDGET_CHARS + 1), SPEC, 'r1')).toBeNull()
  })
})

describe('queryArchive', () => {
  const record = (): { ref: string; lists: string[] } => ({ ref: 'r1', lists: ['templates'] })
  const data = templates()

  it('where 等值筛不分大小写，返回完整的行', () => {
    const out = queryArchive(record(), data, { where: { name: 'template_42' } })
    expect(out.matched).toBe(1)
    const [row] = out.rows as Array<Record<string, unknown>>
    expect(row.name).toBe('Template_42')
    expect(row.description).toBeDefined()
  })

  it('where 给数组表示任一，fields 只挑列', () => {
    const out = queryArchive(record(), data, {
      where: { name: ['Template_1', 'Template_2'] },
      fields: ['name', 'path']
    })
    expect(out.rows).toEqual([
      { name: 'Template_1', path: 'C:/UE_5.5/Templates/TP_1/TP_1.uproject' },
      { name: 'Template_2', path: 'C:/UE_5.5/Templates/TP_2/TP_2.uproject' }
    ])
  })

  it('search 在嵌套的文字里找子串', () => {
    const out = queryArchive(record(), data, { search: 'TAG-7', fields: ['name'] })
    expect((out.rows as Array<{ name: string }>).map((row) => row.name)).toContain('Template_7')
  })

  it('一页塞不下就给 next_offset，接着翻能翻完', () => {
    const first = queryArchive(record(), data, {})
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(ARCHIVE_BUDGET_CHARS)
    expect(first.next_offset).toBe(first.returned)

    let seen = first.returned as number
    let offset = first.next_offset as number | undefined
    while (offset !== undefined) {
      const page = queryArchive(record(), data, { offset })
      seen += page.returned as number
      offset = page.next_offset as number | undefined
    }
    expect(seen).toBe(300)
  })

  it('limit 收得比一页小时，后面还有就给 next_offset', () => {
    const out = queryArchive(record(), data, { limit: 5, fields: ['name'] })
    expect(out.returned).toBe(5)
    expect(out.next_offset).toBe(5)
  })

  it('search_in 把 search 限定在几列里，长路径不再误中', () => {
    // 每个模板的 path 里都有 "Templates"，不限定的话全中
    expect(queryArchive(record(), data, { search: 'templates' }).matched).toBe(300)
    expect(queryArchive(record(), data, { search: 'templates', search_in: ['name'] }).matched).toBe(
      0
    )
    expect(
      queryArchive(record(), data, { search: 'template_7', search_in: ['name'] }).matched
    ).toBe(11)
  })

  it('只给 search_in 不给 search 时报错，不假装筛过', () => {
    expect(() => queryArchive(record(), data, { search_in: ['name'] })).toThrow(/和 search 一起用/)
  })

  it('preface 排在最前面，并且算进每页的预算', () => {
    const preface = { snapshot: '快照说明'.repeat(30) }
    const page = queryArchive(record(), data, {}, preface)
    expect(Object.keys(page)[0]).toBe('snapshot')
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(ARCHIVE_BUDGET_CHARS)
  })

  it('写错列名时说出来，并给出全部列名', () => {
    const out = queryArchive(record(), data, { where: { title: 'x' } })
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
    details: { archive: { ref: 'r1', lists: ['templates'], text: '{}' } }
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
    const note = describeSnapshot([archiveMessage], 0, mutating)?.note
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
    const note = describeSnapshot(messages, messages.indexOf(archiveMessage), mutating)?.note
    expect(note).toContain('执行过 1 个修改类工具')
    expect(note).toContain('重新调用 project_list')
  })

  it('下标上不是存档就返回 undefined', () => {
    expect(describeSnapshot([archiveMessage], 3, mutating)).toBeUndefined()
    expect(describeSnapshot([{ role: 'user' }], 0, mutating)).toBeUndefined()
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

  it('details 里已经有一模一样的表时不另存文本，查询直接读 details', () => {
    const result = templates()
    const out = archiver()({
      isError: false,
      toolCall: { name: 'project_list' },
      result: { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
    })!
    expect(out.details.archive).toEqual({ ref: 'r1', lists: ['templates'], source: 'details' })
    const data = archiveDataOf({ role: 'toolResult', details: out.details })
    expect((data?.templates as unknown[]).length).toBe(300)
  })

  it('details 里的表和给模型的不一样时照旧存文本', () => {
    const out = archiver()(bigCall({ success: true, templates: [{ name: 'raw' }] }))!
    expect(typeof (out.details.archive as { text?: unknown }).text).toBe('string')
  })

  it('details 来源：工具正文加编号放得下就原样给，放不下才换 compact', () => {
    const compact = vi.fn(() => 'compact body')
    const spec = { source: 'details' as const, lists: { templates: ['name'] }, compact }
    const details = templates()
    const run = (text: string): string =>
      (
        createResultArchiver({
          getMessages: () => [],
          specFor: () => spec,
          canQuery: () => true,
          loadQueryTool: () => undefined
        })({
          isError: false,
          toolCall: { name: 'x' },
          result: { content: [{ type: 'text', text }], details }
        })!.content[0] as { text: string }
      ).text

    expect(run('short full body').startsWith('short full body')).toBe(true)
    expect(compact).not.toHaveBeenCalled()
    expect(run('x'.repeat(ARCHIVE_BUDGET_CHARS)).startsWith('compact body')).toBe(true)
    expect(compact).toHaveBeenCalledTimes(1)
  })

  it('同一轮并行的两个结果拿到不同编号，并接着历史往后编', () => {
    const history = [
      { role: 'toolResult', details: { archive: { ref: 'r4', lists: ['x'], text: '{}' } } }
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
      details: { archive: { ref, lists: ['x'], text: '{}' } }
    })
    expect(lastRefIn([at('r2'), at('r10'), { role: 'user' }])).toBe(10)
    expect(lastRefIn([])).toBe(0)
  })

  it('存档器替没有 details 的工具造出来的那份，交给界面时换回 undefined', () => {
    expect(
      detailsForRenderer({
        archive: { ref: 'r1', lists: ['x'], text: '{}' },
        toolSearch: { loadedToolNames: ['result_query'] }
      })
    ).toBeUndefined()
  })

  it('archiveDataOf：text 来源解析一次就缓存，details 来源直接用 details', () => {
    const textMessage = {
      role: 'toolResult',
      details: { archive: { ref: 'r1', lists: ['templates'], text: JSON.stringify(templates(2)) } }
    }
    const first = archiveDataOf(textMessage)
    expect(first?.templates).toHaveLength(2)
    expect(archiveDataOf(textMessage)).toBe(first)

    const details = {
      nodes: [{ node_id: 'A' }],
      archive: { ref: 'r2', lists: ['nodes'], source: 'details' }
    }
    expect(archiveDataOf({ role: 'toolResult', details })).toBe(details)
  })

  it('界面那份剔掉了 text 的存档不会被当成 details 来源', () => {
    const rendererCopy = { assets: [], archive: { ref: 'r3', lists: ['assets'] } }
    expect(archiveDataOf({ role: 'toolResult', details: rendererCopy })).toBeUndefined()
  })

  it('解析缓存只留最近两份', () => {
    const message = (n: number): Record<string, unknown> => ({
      role: 'toolResult',
      details: { archive: { ref: `r${n}`, lists: ['t'], text: JSON.stringify({ t: [{ n }] }) } }
    })
    const [a, b, c] = [message(1), message(2), message(3)]
    const first = archiveDataOf(a)
    expect(archiveDataOf(a)).toBe(first)
    archiveDataOf(b)
    archiveDataOf(c)
    // a 已经被挤出去，再查是重新解析出来的另一个对象
    expect(archiveDataOf(a)).not.toBe(first)
    expect(archiveDataOf(a)).toEqual(first)
  })

  it('发给界面时剔掉完整文本，只留编号', () => {
    const details = {
      success: true,
      archive: { ref: 'r1', lists: ['templates'], text: 'x'.repeat(99) }
    }
    expect(detailsForRenderer(details)).toEqual({
      success: true,
      archive: { ref: 'r1', lists: ['templates'] }
    })
    expect(detailsForRenderer({ success: true })).toEqual({ success: true })
  })
})
