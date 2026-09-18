/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 已连接工程表。切目标那几条靠改它来模拟「工程开着 / 没开着」 */
const projects: Array<{
  connectionId: string
  projectPath: string
  isConnected: boolean
  interactive?: boolean
}> = []

vi.mock('../../../services/project/projectManager', () => ({
  projectManager: {
    getProject: (id: string) => projects.find((p) => p.connectionId === id),
    getAllProjects: () => projects,
    getInteractiveProjects: () => projects.filter((p) => p.isConnected && p.interactive !== false)
  }
}))

import { getTargetConnectionId, runWithTargetConnectionId } from '../../core/projectTargetContext'
import { __resetSessionBindingsForTest, setSessionBinding } from '../../core/sessionBinding'
import {
  createSetSessionProjectTool,
  matchProject,
  type SessionProjectCandidate
} from './setSessionProject'

/** 钉在 OldGame 上的那条会话 */
const SCOPED_SESSION = 's-scoped'

const LIBRARY: SessionProjectCandidate[] = [
  { projectName: 'OldGame', projectPath: 'I:/Dev/OldGame', connected: true },
  { projectName: 'LotusPond', projectPath: 'I:/Dev/LotusPond', connected: false },
  // 同名不同路径：复制一份改改就是另一个工程，真机上很常见
  { projectName: 'LotusPond', projectPath: 'D:/Backup/LotusPond', connected: false }
]

function makeTool(
  onChange: (project: SessionProjectCandidate | null) => void = () => {}
): ReturnType<typeof createSetSessionProjectTool> {
  return createSetSessionProjectTool({
    // 必须和执行流上那个 sessionId 一致：工具按它写表，`retargetToProject`
    // 按它查表。给成两个不同的 id，改完归属当场还是会被当成越界挡下来
    sessionId: SCOPED_SESSION,
    listProjects: () => LIBRARY,
    onChange
  })
}

/** `defineTool` 包出来的 execute 是 `(toolCallId, params)`，别把两个参数写反 */
const run = async (
  tool: ReturnType<typeof createSetSessionProjectTool>,
  args: Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> => (tool as any).execute('c1', args)

/**
 * 结果里给模型看的那段文字。
 *
 * `defineTool` 把 `{ text }` 折成 pi 的 content 块，不是原样透出来 ——
 * 直接读 `result.text` 会拿到 undefined，而断言 `undefined` 里有没有某句话
 * 是永远为假的那种测试。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const textOf = (result: any): string =>
  (result?.content ?? []).map((block: { text?: string }) => block?.text ?? '').join('\n')

/**
 * 失败的工具**抛异常**，不返回 `isError` —— pi 判定失败的唯一依据就是抛没抛
 * （见 `defineTool.ts` 的 `ToolFailure`）。所以这里断言的是异常信息。
 */
const runExpectingFailure = async (
  tool: ReturnType<typeof createSetSessionProjectTool>,
  args: Record<string, unknown>
): Promise<string> => {
  try {
    await run(tool, args)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('这次调用本该失败，却成功返回了')
}

beforeEach(() => {
  projects.length = 0
  __resetSessionBindingsForTest()
  setSessionBinding(SCOPED_SESSION, { projectName: 'OldGame', projectPath: 'I:/Dev/OldGame' })
})

describe('matchProject', () => {
  // 路径优先：同名工程很常见，认错工程比认不出来糟糕得多
  it('路径比名字优先，同名时不会挑错那一个', () => {
    expect(matchProject(LIBRARY, 'D:/Backup/LotusPond')?.projectPath).toBe('D:/Backup/LotusPond')
  })

  it('大小写、斜杠方向、.uproject 后缀都抹平', () => {
    expect(matchProject(LIBRARY, 'i:\\dev\\lotuspond\\LotusPond.uproject')?.projectPath).toBe(
      'I:/Dev/LotusPond'
    )
  })

  it('给名字也认得出', () => {
    expect(matchProject(LIBRARY, 'OldGame')?.projectPath).toBe('I:/Dev/OldGame')
  })

  it('认不出来就是认不出来，不模糊匹配一个凑数', () => {
    expect(matchProject(LIBRARY, 'Lotus')).toBeUndefined()
  })
})

/**
 * 这个工具存在的理由：会话归属曾经是**只有用户能改**的。
 *
 * 真机上那一幕 —— 用户在一条挂在旧工程下的对话里说「建个新工程做荷塘」，
 * 模型把工程建好、打开、连上，然后停下来请用户去界面上改归属。用户什么信息
 * 都补不了，那一步纯粹是盒子把自己锁住了。
 */
describe('set_session_project', () => {
  it('换归属之后，同一轮里就能对新工程发命令', async () => {
    projects.push({ connectionId: 'conn-old', projectPath: 'I:/Dev/OldGame', isConnected: true })
    projects.push({ connectionId: 'conn-new', projectPath: 'I:/Dev/LotusPond', isConnected: true })

    const changes: Array<SessionProjectCandidate | null> = []
    const tool = makeTool((project) => changes.push(project))

    const result = await runWithTargetConnectionId(
      // 归属住在 `sessionBinding` 那张表里，执行流只带 sessionId 过去查
      { connectionId: 'conn-old', projectPath: 'I:/Dev/OldGame', sessionId: SCOPED_SESSION },
      async () => {
        const outcome = await run(tool, {
          projectName: 'I:/Dev/LotusPond',
          reason: '接下来的活都在新建的荷塘工程里做'
        })
        // 关键：目标当场就切过去了，不用等下一轮
        expect(getTargetConnectionId()).toBe('conn-new')
        return outcome
      }
    )

    expect(result.details.switchedTarget).toBe(true)
    // 渲染层也收到了，侧边栏分组和顶栏胶囊跟着变
    expect(changes).toEqual([expect.objectContaining({ projectPath: 'I:/Dev/LotusPond' })])
  })

  /**
   * 新工程还没打开时不切目标 —— 没有连接可切。
   *
   * 但归属得改掉：改完之后 `open_project` 才不会再被「会话归属」挡下来。
   * 这一条正是那一幕的完整解法，缺了它模型换完归属还是动不了。
   */
  it('新工程没开着时归属照改，为紧接着的 open_project 让路', async () => {
    projects.push({ connectionId: 'conn-old', projectPath: 'I:/Dev/OldGame', isConnected: true })

    const result = await runWithTargetConnectionId(
      // 归属住在 `sessionBinding` 那张表里，执行流只带 sessionId 过去查
      { connectionId: 'conn-old', projectPath: 'I:/Dev/OldGame', sessionId: SCOPED_SESSION },
      async () => {
        const outcome = await run(makeTool(), {
          projectName: 'I:/Dev/LotusPond',
          reason: '用户要在荷塘工程里做'
        })
        // 没连接可切，但归属已经换了 —— 紧接着的 open_project 不会再被挡下来
        expect(outcome.details.switchedTarget).toBe(false)
        return outcome
      }
    )

    expect(textOf(result)).toContain('先用 project_manage 的 open_project 打开它')
  })

  it('认不出工程时报错并把已知的工程列出来，不静默改成别的', async () => {
    const changes: Array<SessionProjectCandidate | null> = []
    const message = await runWithTargetConnectionId({}, () =>
      runExpectingFailure(
        makeTool((p) => changes.push(p)),
        { projectName: 'NotThere', reason: '试试' }
      )
    )

    expect(message).toContain('OldGame')
    expect(changes).toEqual([])
  })

  // `null`（明说不归属）和 `undefined`（从没定过）不是一回事，见 store 里的注释
  it('clear 解除归属，之后跟着当前打开的工程走', async () => {
    const changes: Array<SessionProjectCandidate | null> = []
    const result = await runWithTargetConnectionId({ sessionId: SCOPED_SESSION }, () =>
      run(
        makeTool((p) => changes.push(p)),
        { clear: true, reason: '用户说这条不归任何工程' }
      )
    )

    expect(textOf(result)).toContain('已解除')
    expect(changes).toEqual([null])
  })

  // 空的 projectName 不能被当成「解除归属」—— 那会把用户的分组悄悄拆掉
  it('既没点名也没说 clear 时报错，不静默解除归属', async () => {
    const changes: Array<SessionProjectCandidate | null> = []
    const message = await runExpectingFailure(
      makeTool((p) => changes.push(p)),
      { projectName: '   ', reason: '手滑' }
    )

    expect(message).toContain('clear')
    expect(changes).toEqual([])
  })
})
