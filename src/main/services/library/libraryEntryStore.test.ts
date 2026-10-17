import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createPackage } from '../libraryPackageStore'
import { findEntryById, saveSnippetEntry, searchEntries } from './libraryEntryStore'
import { readSnippetPayload, type SnippetMeta } from '../../../shared/snippetPayload'

const T3D =
  'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="K2Node_Event_0"\nEnd Object'

const meta: SnippetMeta = {
  nodeCount: 2,
  connectionCount: 1,
  classes: ['Event', 'Function'],
  openPorts: []
}

describe('库条目的读写（真实临时目录）', () => {
  let vaultRoot: string

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'ual-library-entry-'))
  })

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true })
  })

  it('存进去再按 id 找回来，正文一字不改', async () => {
    await saveSnippetEntry({
      vaultRoot,
      library: 'blueprint',
      entryId: 'entry-1',
      name: '受击闪红',
      t3d: T3D,
      meta,
      sourceBlueprintPath: '/Game/BP_Player',
      sourceGraphName: 'EventGraph',
      now: 1000
    })

    const found = await findEntryById(vaultRoot, 'blueprint', 'entry-1')
    expect(found?.manifest.id).toBe('entry-1')
    expect(found?.manifest.name).toBe('受击闪红')

    const payload = readSnippetPayload(found!.manifest.payload)
    expect(payload?.t3d).toBe(T3D)
    expect(payload?.meta.nodeCount).toBe(2)
    expect(payload?.sourceBlueprintPath).toBe('/Game/BP_Player')
  })

  it('找不到就是 null，不抛', async () => {
    expect(await findEntryById(vaultRoot, 'blueprint', 'nope')).toBeNull()
    expect(await findEntryById('', 'blueprint', 'entry-1')).toBeNull()
  })

  it('库不对也找不到 —— 蓝图条目不会从材质库里翻出来', async () => {
    await saveSnippetEntry({
      vaultRoot,
      library: 'blueprint',
      entryId: 'entry-1',
      name: '受击闪红',
      t3d: T3D,
      meta,
      now: 1000
    })

    expect(await findEntryById(vaultRoot, 'material', 'entry-1')).toBeNull()
  })

  it('老形态的包也找得到 —— 按 id 查找不看 payload 形态', async () => {
    await createPackage(vaultRoot, {
      library: 'blueprint',
      id: 'legacy-1',
      name: '旧条目',
      payload: { graphs: [{ name: 'EventGraph', code: 'Begin Object ... End Object' }] },
      now: 500
    })

    const found = await findEntryById(vaultRoot, 'blueprint', 'legacy-1')
    expect(found?.manifest.name).toBe('旧条目')
  })
})

describe('searchEntries', () => {
  let vaultRoot: string

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'ual-library-search-'))
    await saveSnippetEntry({
      vaultRoot,
      library: 'blueprint',
      entryId: 'a',
      name: '受击闪红',
      t3d: T3D,
      meta: {
        ...meta,
        openPorts: [{ nodeId: '1', pinName: 'then', dir: 'out', formerPeer: '9.execute' }]
      },
      now: 3000
    })
    await saveSnippetEntry({
      vaultRoot,
      library: 'blueprint',
      entryId: 'b',
      name: '跳跃逻辑',
      t3d: T3D,
      meta: { nodeCount: 1, connectionCount: 0, classes: ['Branch'], openPorts: [] },
      now: 2000
    })
    await createPackage(vaultRoot, {
      library: 'material',
      id: 'm',
      name: '苔藓石头',
      payload: { graphs: [] },
      now: 1000
    })
  })

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true })
  })

  it('不传 library 就两个库一起搜', async () => {
    const all = await searchEntries({ vaultRoot })
    expect(all.map((item) => item.id).sort()).toEqual(['a', 'b', 'm'])
  })

  it('按库过滤', async () => {
    const only = await searchEntries({ vaultRoot, library: 'material' })
    expect(only.map((item) => item.id)).toEqual(['m'])
  })

  it('按名字模糊匹配', async () => {
    const hit = await searchEntries({ vaultRoot, keyword: '闪红' })
    expect(hit.map((item) => item.id)).toEqual(['a'])
  })

  it('按节点类型匹配', async () => {
    const hit = await searchEntries({ vaultRoot, nodeClass: 'branch' })
    expect(hit.map((item) => item.id)).toEqual(['b'])
  })

  it('按更新时间倒序', async () => {
    const all = await searchEntries({ vaultRoot, library: 'blueprint' })
    expect(all.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('摘要带上节点数和用到的类型', async () => {
    const [first] = await searchEntries({ vaultRoot, keyword: '闪红' })
    expect(first.form).toBe('snippet')
    expect(first.nodeCount).toBe(2)
    expect(first.connectionCount).toBe(1)
    expect(first.classes).toEqual(['Event', 'Function'])
    expect(first.openPortCount).toBe(1)
  })

  it('老形态的摘要不报节点数 —— 那不是它的形状', async () => {
    const [material] = await searchEntries({ vaultRoot, library: 'material' })
    expect(material.form).toBe('t3d')
    expect(material.nodeCount).toBeUndefined()
  })
})
