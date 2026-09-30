import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { notifyAgentRun } from '../host/runObserver'
import { startExperienceCurator } from './scheduler'
import { readTrail, TrailWriter } from './trail'

let root: string
let stop: (() => void) | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'exp-sched-'))
  vi.useFakeTimers()
})

afterEach(async () => {
  stop?.()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

async function writeFailThenFix(trailDir: string): Promise<void> {
  const trail = new TrailWriter(trailDir, {
    sessionId: 's1',
    projectRoot: root,
    skillLearning: 'ask'
  })
  const error = "attributeerror: 'character' object has no attribute 'is_hidden'"
  await trail.record({
    agent: 's1',
    i: 1,
    tool: 'ue_run_python_script',
    ok: false,
    args: '{"script":"a"}',
    error,
    fp: error
  })
  await trail.record({
    agent: 's1',
    i: 2,
    tool: 'ue_run_python_script',
    ok: true,
    args: '{"script":"b"}'
  })
}

describe('startExperienceCurator', () => {
  it('会话空出来后等一会儿再整理；中途又开一轮就等那一轮结束', async () => {
    const trailDir = join(root, '.trail')
    await writeFailThenFix(trailDir)
    const complete = vi.fn(async () => '[]')
    const done = vi.fn()
    stop = startExperienceCurator({ home: root, delayMs: 1000, complete, onResult: done })

    notifyAgentRun({ type: 'released', sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(500)
    notifyAgentRun({ type: 'started', sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(complete).not.toHaveBeenCalled()

    notifyAgentRun({ type: 'released', sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('同一段原始账不整理第二次；子任务的 released 不触发', async () => {
    const trailDir = join(root, '.trail')
    await writeFailThenFix(trailDir)
    const complete = vi.fn(async () => '[]')
    const done = vi.fn()
    stop = startExperienceCurator({ home: root, delayMs: 10, complete, onResult: done })

    notifyAgentRun({ type: 'released', sessionId: 's1:sub-1' })
    notifyAgentRun({ type: 'released', sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1))

    notifyAgentRun({ type: 'released', sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(async () => expect((await readTrail(trailDir, 's1'))?.curatedThrough).toBe(2))
    expect(complete).toHaveBeenCalledTimes(1)
  })
})
