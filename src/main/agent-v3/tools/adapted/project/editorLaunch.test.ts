/** @vitest-environment node */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  editorStillLoading,
  type EditorLoadingDeps,
  LAUNCH_GRACE_MS,
  noteEditorLaunch,
  PROCESS_APPEAR_MS,
  resetEditorLaunchesForTest
} from './editorLaunch'

/**
 * 编辑器还没连上盒子时，`open_project` 要不要再启动一个（2026-10-24 联调：
 * 每 25 秒问一次「开好没」，一个工程开出了三个编辑器）。
 */

const UPROJECT = 'H:/UnrealAgent/_hybrid-e2e/HybridE2E/HybridE2E.uproject'
const found = async (): Promise<unknown> => ({ pid: 1 })
const absent = async (): Promise<unknown> => null
const broken = async (): Promise<unknown> => {
  throw new Error('WMI 超时')
}

beforeEach(() => resetEditorLaunchesForTest())

describe('编辑器是不是还在加载', () => {
  it('进程在：在加载，不管盒子启没启动过它（用户自己双击打开的也算）', async () => {
    expect(await editorStillLoading(UPROJECT, { findProcess: found })).toBe(true)
  })

  it('进程不在、盒子也没启动过：没开，照常启动', async () => {
    expect(await editorStillLoading(UPROJECT, { findProcess: absent })).toBe(false)
  })

  it('刚启动、进程表里还没出现：头 30 秒当它在加载', async () => {
    noteEditorLaunch(UPROJECT, 1_000)
    const at = (t: number): EditorLoadingDeps => ({ findProcess: absent, now: () => t })
    expect(await editorStillLoading(UPROJECT, at(1_000 + PROCESS_APPEAR_MS - 1))).toBe(true)
    // 30 秒后还查不到进程：多半启动失败或加载中途崩了，允许再启动
    expect(await editorStillLoading(UPROJECT, at(1_000 + PROCESS_APPEAR_MS))).toBe(false)
  })

  it('查不了进程：启动后 5 分钟内当它在加载，之后放行', async () => {
    noteEditorLaunch(UPROJECT, 0)
    expect(
      await editorStillLoading(UPROJECT, { findProcess: broken, now: () => LAUNCH_GRACE_MS - 1 })
    ).toBe(true)
    expect(
      await editorStillLoading(UPROJECT, { findProcess: broken, now: () => LAUNCH_GRACE_MS })
    ).toBe(false)
    // 没启动过、又查不了：照旧启动，不因为查不了就再也打不开
    resetEditorLaunchesForTest()
    expect(await editorStillLoading(UPROJECT, { findProcess: broken })).toBe(false)
  })

  it('同一个工程：大小写和斜杠方向不同也认成一个', async () => {
    noteEditorLaunch('h:\\unrealagent\\_hybrid-e2e\\hybride2e\\HybridE2E.uproject', 0)
    expect(await editorStillLoading(UPROJECT, { findProcess: absent, now: () => 10 })).toBe(true)
  })
})
