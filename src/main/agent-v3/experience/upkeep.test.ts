/**
 * 修旧账、复查 API 事实（upkeep.ts）。旧账照用户本机 2026-10-15 的真实形状造：
 * 被容量挤掉的事实一次没出过场、没有退休原因。
 */

import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { admit, MAX_RETIRED_PER_TOOL } from './admission'
import type { ExperienceEntry } from './experienceFile'
import { emptyStats } from './lifecycle'
import type { ProbeVerdict } from './probe'
import { ExperienceStore } from './store'
import { recheckFacts, repairLayer } from './upkeep'

const TOOL = 'ue_run_python_script'

function fact(id: string, over: Partial<ExperienceEntry> = {}): ExperienceEntry {
  return {
    id,
    title: id,
    tool: TOOL,
    errorPattern: `'leveleditorsubsystem' object has no attribute '${id}'`,
    advice: 'a',
    expect: { param: 'script' },
    source: '2026-10-06 · session x · failed 1x, then succeeded',
    status: 'trial',
    symbol: `leveleditorsubsystem.${id}`,
    ...over
  }
}

let root: string
let store: ExperienceStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'exp-upkeep-'))
  store = new ExperienceStore(join(root, 'home'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function byId(): Promise<Record<string, ExperienceEntry>> {
  return Object.fromEntries((await store.readTool(TOOL)).map((e) => [e.id, e]))
}

describe('修旧账', () => {
  it('没原因、一次没出过场的退休经验是被容量挤掉的，放回来；出过场的和有原因的不动', async () => {
    await store.updateTool(TOOL, () => [
      fact('squeezed', { status: 'retired' }),
      fact('checked', { status: 'retired', source: 'x · checked in editor' }),
      fact('earned', { status: 'retired' }),
      fact('refuted', { status: 'retired', retiredBecause: 'refuted' })
    ])
    await store.updateLedger(() => ({ earned: { ...emptyStats(), shown: 3, adoptedFail: 2 } }))

    expect(await repairLayer(store)).toBe(2)
    const entries = await byId()
    expect(entries.squeezed.status).toBe('trial')
    expect(entries.checked.status).toBe('proven')
    expect(entries.earned.status).toBe('retired')
    expect(entries.refuted).toMatchObject({ status: 'retired', retiredBecause: 'refuted' })
    // 幂等
    expect(await repairLayer(store)).toBe(0)
  })

  it('在 None 上取属性的退休掉并记原因；核实过的在用事实转正', async () => {
    await store.updateTool(TOOL, () => [
      fact('none', {
        errorPattern: "'nonetype' object has no attribute 'get_editor_property'",
        symbol: 'nonetype.get_editor_property'
      }),
      fact('checked', { source: 'x · checked in editor' })
    ])
    await repairLayer(store)
    const entries = await byId()
    expect(entries.none).toMatchObject({ status: 'retired', retiredBecause: 'script-bug' })
    expect(entries.checked.status).toBe('proven')
  })
})

describe('复查 API 事实', () => {
  it('引擎确认就转正；否定就退休并记原因；问不出来不动；一次最多问几条', async () => {
    await store.updateTool(TOOL, () => [fact('yes'), fact('no'), fact('maybe'), fact('later')])
    const verdicts: Record<string, ProbeVerdict> = { yes: 'confirmed', no: 'refuted' }
    const probe = vi.fn(async ({ member }: { member: string }) => verdicts[member] ?? 'unknown')

    expect(await recheckFacts([{ store, layer: 'project' }], probe, 'H:/P', '5.7', 3)).toBe(3)
    const entries = await byId()
    expect(entries.yes.status).toBe('proven')
    expect(entries.no).toMatchObject({ status: 'retired', retiredBecause: 'refuted' })
    expect(entries.maybe.status).toBe('trial')
    expect(entries.later.status).toBe('trial')
    expect(probe).toHaveBeenCalledWith({
      projectRoot: 'H:/P',
      owner: 'leveleditorsubsystem',
      member: 'yes'
    })
  })

  it('通用层在没验证过的版本上被否定：记这个版本不适用，不退休', async () => {
    await store.updateTool(TOOL, () => [fact('old', { engines: ['5.5'] })])
    await recheckFacts([{ store, layer: 'global' }], async () => 'refuted', 'H:/P', '5.7')
    expect((await byId()).old).toMatchObject({ status: 'trial', notFor: ['5.7'] })
  })
})

describe('进门', () => {
  it('不再按工具限条数：第 6 条进门不挤任何一条', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => fact(id))
    const next = admit(five, fact('f'))!
    expect(next.filter((e) => e.status !== 'retired')).toHaveLength(6)
  })

  it('同一个 API 只留一条：试用的换成新的并记原因，转正的挡住新的', () => {
    const incoming = fact('n', { symbol: 'leveleditorsubsystem.old' })
    const replaced = admit([fact('old')], incoming)!
    expect(replaced.find((e) => e.id === 'old')).toMatchObject({
      status: 'retired',
      retiredBecause: 'replaced'
    })
    expect(admit([fact('old', { status: 'proven' })], incoming)).toBeUndefined()
  })

  it('已退休的只留最近几条', () => {
    const retired = Array.from({ length: MAX_RETIRED_PER_TOOL }, (_, i) =>
      fact(`r${i}`, { status: 'retired' as const })
    )
    const next = admit(
      [...retired, fact('old')],
      fact('n', { symbol: 'leveleditorsubsystem.old' })
    )!
    expect(next.filter((e) => e.status === 'retired')).toHaveLength(MAX_RETIRED_PER_TOOL)
    expect(next.some((e) => e.id === 'r0')).toBe(false)
  })
})
