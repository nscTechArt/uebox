/**
 * @vitest-environment node
 *
 * `blueprint_compile`：编译过了但没存上盘，第一句不能说「成功」（AGENTS.md §5 第 14 条）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()

vi.mock('../../../../services', () => ({
  serviceManager: { getWebSocketService: () => ({ callRequest, getConnectionCount: () => 1 }) }
}))
vi.mock('../../../core/projectTargetContext', () => ({ getTargetConnectionId: () => 'conn-1' }))
vi.mock('./resolveBlueprintPath', () => ({
  resolveBlueprintPathInput: async (raw: string) => ({
    blueprintPath: raw,
    originalInput: raw,
    wasPlaceholder: false
  })
}))

import { createCompileBlueprintTool } from './compileBlueprint'

type Result = Record<string, unknown>
const run = (input: unknown): Promise<Result> =>
  (createCompileBlueprintTool() as unknown as { execute: (i: unknown) => Promise<Result> }).execute(
    input
  )

beforeEach(() => callRequest.mockReset())

describe('保存结果', () => {
  it('要求保存却没存上时，第一句说未能保存', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      status: 'UpToDate',
      saved: false,
      path: '/Game/BP_Door'
    })

    const r = await run({ blueprint_path: '/Game/BP_Door', save: true })

    expect(Object.keys(r)[0]).toBe('message')
    expect(String(r.message)).toMatch(/^⚠️/)
    expect(String(r.message)).toContain('未能保存')
    expect(r.saved).toBe(false)
  })

  it('存上了就照常说编译成功', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      status: 'UpToDate',
      saved: true,
      path: '/Game/BP_Door'
    })

    const r = await run({ blueprint_path: '/Game/BP_Door', save: true })

    expect(String(r.message)).toContain('compiled successfully')
  })

  it('save:false 时 saved 为 false 不算失败', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      status: 'UpToDate',
      saved: false,
      path: '/Game/BP_Door'
    })

    const r = await run({ blueprint_path: '/Game/BP_Door', save: false })

    expect(String(r.message)).not.toContain('⚠️')
  })
})
