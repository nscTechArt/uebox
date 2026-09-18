import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { runAgentV3Smoke } from './smoke'

/**
 * Agent V3 的 ESM/CJS 回归护栏。
 *
 * pi 全家是 ESM-only，主进程产物是 CJS。这条链路能成立的前提是
 * rollup/esbuild 能把 pi 降级成 CJS —— 而 **top-level await 无法降级**。
 * 一旦某次升级引入了 TLA，`pnpm build` 会在几十秒的构建末尾才炸，
 * 排查成本很高。这个测试把失败提前到几秒内，并直接指出原因。
 *
 * 跑得比普通单测慢（要真打一次包），但它守的是整个 V3 方案的地基。
 */
describe('agent-v3 P0：pi 内核可用性', () => {
  it('pi 内核在 ESM 环境下功能正常', async () => {
    const report = await runAgentV3Smoke()

    expect(report.errors).toEqual([])
    expect(report.ok).toBe(true)

    // pi-ai 的内建目录必须覆盖到我们依赖的那批 provider
    expect(report.providerCount).toBeGreaterThan(30)
    expect(report.sampledProviders).toEqual(
      expect.arrayContaining(['zai', 'deepseek', 'moonshotai', 'minimax', 'openrouter'])
    )

    // 内核构造 + 存量 Zod 工具的迁移路径
    expect(report.agentConstructed).toBe(true)
    expect(report.toolSchemaKeys).toEqual(['material_name', 'two_sided'])
    expect(report.toolExecuted).toBe(true)
    expect(report.estimatedTokens).toBeGreaterThan(0)
  })
})

describe('agent-v3 P0：ESM 依赖能降级成 CJS', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'agent-v3-cjs-'))
  const outFile = join(outDir, 'smoke.cjs')

  afterAll(() => rmSync(outDir, { recursive: true, force: true }))

  it('打成 CJS 后能被 require 并正常执行', async () => {
    const { build } = await import('esbuild')

    // 这一步就是 electron.vite.base.ts 里 ESM_ONLY_DEPS 走的路径。
    // 依赖里出现 top-level await 时，esbuild 会在这里直接报错。
    await build({
      entryPoints: [join(__dirname, 'smoke.ts')],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      outfile: outFile,
      external: ['electron'],
      logLevel: 'silent'
    })

    // 用真正的 CJS require 加载并执行 —— 只验证「打得出来」不够，
    // interop 出问题时打包是成功的，跑起来才炸。
    const script = `
        const { runAgentV3Smoke } = require(${JSON.stringify(outFile)})
        runAgentV3Smoke()
          .then((r) => { process.stdout.write(JSON.stringify(r)) })
          .catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1) })
      `
    const stdout = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 60_000
    })

    const report = JSON.parse(stdout) as Awaited<ReturnType<typeof runAgentV3Smoke>>
    expect(report.errors).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.agentConstructed).toBe(true)
    expect(report.toolExecuted).toBe(true)
  }, 120_000)
})
