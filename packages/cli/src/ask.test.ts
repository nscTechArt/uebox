/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest'

import { run } from './cli.js'
import { startFakeBox, type FakeBox, type FakeTool } from './testServer.js'

const TOKEN = 'test-token-0123456789'
const boxes: FakeBox[] = []

afterEach(async () => {
  await Promise.all(boxes.splice(0).map((box) => box.close().catch(() => undefined)))
})

function healthTool(online: boolean): FakeTool {
  return {
    name: 'ue_session_health',
    meta: { namespace: 'ue.system', risk: 'safe', projectScoped: false },
    handle: () => ({
      content: [{ type: 'text', text: '体检' }],
      structuredContent: {
        connections: online
          ? [{ connectionId: 'c1', projectName: 'Demo', projectPath: 'D:/Games/Demo' }]
          : []
      }
    })
  }
}

/** 清单里摆几类命名空间，看 ask 放行了哪些 */
function tool(name: string, namespace: string, risk = 'safe'): FakeTool {
  return { name, meta: { namespace, risk }, handle: () => ({ content: [] }) }
}

const CATALOG = [
  tool('ue_get_actor', 'ue.actor'),
  tool('material_create', 'ue.material', 'mutating'),
  tool('search_assets', 'asset'),
  tool('project_list', 'project'),
  tool('library_search', 'library'),
  tool('load_skill', 'core'),
  tool('run_shell_command', 'local.shell', 'destructive'),
  tool('write_local_file', 'local', 'destructive'),
  tool('browser_navigate', 'browser'),
  tool('mcp_other', 'mcp.other', 'destructive'),
  tool('box_manage', 'box', 'destructive')
]

/** 假的 task：记下收到的参数，按剧本报进度、交结论 */
function taskTool(
  calls: Array<{ args: Record<string, unknown>; project: string | undefined }>,
  script: (progress: (m: string) => Promise<void>) => Promise<string> = async () => '做完了'
): FakeTool {
  return {
    name: 'task',
    // 真盒子对外把 task 按最坏情况报成破坏性
    meta: { namespace: 'core', risk: 'destructive' },
    handle: async (args, project, progress) => {
      calls.push({ args, project })
      return { content: [{ type: 'text', text: await script(progress) }] }
    }
  }
}

async function startBox(tools: FakeTool[], online = true): Promise<NodeJS.ProcessEnv> {
  const box = await startFakeBox({ token: TOKEN, tools: [healthTool(online), ...tools] })
  boxes.push(box)
  return { UEBOX_URL: box.url, UEBOX_TOKEN: TOKEN }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('uebox ask', () => {
  it('默认只读、不带历史，结论打到 stdout', async () => {
    const calls: Parameters<typeof taskTool>[0] = []
    const env = await startBox([...CATALOG, taskTool(calls)])

    const result = await run(['ask', '列出', '所有点光源'], env)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('做完了')
    expect(calls[0]!.args).toMatchObject({
      prompt: '列出 所有点光源',
      context_mode: 'fresh',
      read_only: true
    })
    expect(calls[0]!.project).toBe('D:/Games/Demo')
  })

  /** 子任务在外部会话里每一步都自动批准，范围只能靠白名单收住 */
  it('只放行引擎、素材库、工程库和技能，shell / 本地文件 / 浏览器 / 第三方 MCP 都不给', async () => {
    const calls: Parameters<typeof taskTool>[0] = []
    const env = await startBox([...CATALOG, taskTool(calls)])

    await run(['ask', '随便', '--allow-write'], env)

    expect(calls[0]!.args.namespaces).toEqual([
      'asset',
      'core',
      'library',
      'project',
      'ue.actor',
      'ue.material',
      'ue.system'
    ])
    expect(calls[0]!.args.read_only).toBeUndefined()
  })

  it('进度实时交给调用方，--json 时 stdout 仍然只有一个 JSON', async () => {
    const calls: Parameters<typeof taskTool>[0] = []
    const env = await startBox([
      ...CATALOG,
      taskTool(calls, async (progress) => {
        await progress('调用 ue_get_actor')
        await progress('调用 ue_set_property')
        return '调好了'
      })
    ])
    const seen: string[] = []

    const result = await run(['ask', '调灯', '--json'], env, {
      progress: (message) => seen.push(message)
    })

    expect(seen).toEqual(['调用 ue_get_actor', '调用 ue_set_property'])
    expect(JSON.parse(result.stdout).data.answer).toBe('调好了')
  })

  /** 在素材库里找东西不需要引擎，没工程连着时不该报错 */
  it('一个工程都没连着时照跑，并说明碰不到引擎', async () => {
    const calls: Parameters<typeof taskTool>[0] = []
    const env = await startBox([...CATALOG, taskTool(calls)], false)

    const result = await run(['ask', '找几张砖墙贴图', '--json'], env)

    expect(result.exitCode).toBe(0)
    expect(calls[0]!.project).toBeUndefined()
    expect(JSON.parse(result.stdout).warnings.join('')).toContain('碰不到引擎')
  })

  it('没给要做的事时报用法错误', async () => {
    const result = await run(['ask'], {})
    expect(result.exitCode).toBe(2)
  })

  describe('--timeout 算的是多久没有进度', () => {
    it('一直在报进度的长任务不会被判超时', async () => {
      const calls: Parameters<typeof taskTool>[0] = []
      const env = await startBox([
        ...CATALOG,
        taskTool(calls, async (progress) => {
          // 总时长 2.4 秒，超过 --timeout 1，但每 0.4 秒报一次
          for (let i = 0; i < 6; i++) {
            await sleep(400)
            await progress(`第 ${i + 1} 步`)
          }
          return '跑完了'
        })
      ])

      const result = await run(['ask', '长任务', '--timeout', '1'], env)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('跑完了')
    }, 15_000)

    it('长时间不出声就判超时，结局不明，退出码 7', async () => {
      const calls: Parameters<typeof taskTool>[0] = []
      const env = await startBox([
        ...CATALOG,
        taskTool(calls, async () => {
          await sleep(2500)
          return '太晚了'
        })
      ])

      const result = await run(['ask', '卡住的任务', '--timeout', '1', '--json'], env)

      expect(result.exitCode).toBe(7)
      const envelope = JSON.parse(result.stdout)
      expect(envelope.error.code).toBe('TIMEOUT')
      expect(envelope.error.execution).toBe('unknown')
    }, 15_000)
  })
})

describe('tools call 不许直接调 task', () => {
  /**
   * 直接调的话子任务不带命名空间白名单，shell、浏览器、要求逐次审批的工具
   * 都在它手上 —— 绕过了 CLI「逐次审批的工具不给」那条规则。
   */
  it('加了 --allow-write 也拒绝，并指向 ask', async () => {
    const calls: Parameters<typeof taskTool>[0] = []
    const env = await startBox([...CATALOG, taskTool(calls)])

    const result = await run(['tools', 'call', 'task', '--allow-write', '--json'], env)

    expect(result.exitCode).toBe(6)
    expect(JSON.parse(result.stdout).error.message).toContain('uebox ask')
    expect(calls).toHaveLength(0)
  })
})
