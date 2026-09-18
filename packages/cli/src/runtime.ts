/**
 * 命令共用的运行时：连上、拿清单、定工程、调工具、收尾。
 *
 * 每条命令都要走同一串动作，散在各命令里写会各写各的 —— 而其中最容易写歪的
 * 恰恰是「结束会话」和「超时之后怎么报执行状态」这两件不显眼的事。
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

import { resolveConnection, type HostConnection } from './config.js'
import {
  connect,
  DEFAULT_TIMEOUT_SECONDS,
  requireContract,
  withDeadline,
  type Session
} from './connection.js'
import { UeboxError } from './errors.js'
import type { RegisteredProject, ResolvedProject } from './project.js'
import { resolveProject } from './project.js'
import { fetchCatalog, requireSupported, type CatalogTool } from './tools.js'
import type { ActorReadback, Verdict, WriteOp } from './write.js'

/** 会话体检工具。`projects list` 和 `doctor` 都靠它拿连接清单 */
const SESSION_HEALTH_TOOL = 'ue_session_health'

export interface RuntimeOptions {
  configPath?: string
  timeoutSeconds?: number
  env?: NodeJS.ProcessEnv
}

export interface Runtime {
  host: HostConnection
  session: Session
  client: Client
  /** 剩余期限内跑一个 promise，超时抛 TIMEOUT */
  deadline<T>(promise: Promise<T>, what: string): Promise<T>
  close(): Promise<void>
}

/**
 * 连上并准备好一条命令的运行环境。
 *
 * `--timeout` 从**开始连接**算起，不是从工具调用算起（§7）：用户关心的是
 * 「这条命令多久能返回」，而不是它内部哪一段花了多久。
 */
export async function open(options: RuntimeOptions = {}): Promise<Runtime> {
  const startedAt = Date.now()
  const budgetMs = (options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000

  const host = await resolveConnection({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.env ? { env: options.env } : {})
  })
  const session = await connect(host)

  return {
    host,
    session,
    client: session.client,
    deadline: <T>(promise: Promise<T>, what: string): Promise<T> => {
      const remaining = budgetMs - (Date.now() - startedAt)
      if (remaining <= 0) {
        return Promise.reject(timeoutError(what, options.timeoutSeconds))
      }
      return withDeadline(promise, remaining, () => timeoutError(what, options.timeoutSeconds))
    },
    close: () => session.close()
  }
}

/**
 * 超时。
 *
 * 执行状态一律 `unknown` —— 请求已经发出去了，我们只是不再等。说成 `failed`
 * 等于替引擎宣布一件没看见的事；调用方据此重发，就可能把一个已经成功的操作
 * 做第二遍。
 */
function timeoutError(what: string, seconds: number | undefined): UeboxError {
  const limit = seconds ?? DEFAULT_TIMEOUT_SECONDS
  return new UeboxError(
    'TIMEOUT',
    `等待「${what}」超过 ${limit} 秒。`,
    '请求可能已经发到引擎了，结果无法确认。先去核实现场，不要直接重发；' +
      '本来就需要长时间等待的调用（比如等编辑器重启）请显式加大 --timeout。',
    'unknown'
  )
}

/** 取工具清单（先确认契约在） */
export async function catalog(runtime: Runtime): Promise<CatalogTool[]> {
  requireContract(runtime.session)
  return runtime.deadline(fetchCatalog(runtime.client), '读取工具清单')
}

/**
 * 调一个工具。
 *
 * `projectPath` 走请求元数据，不动工具自己的业务参数 —— 那些 schema 是既有的，
 * 往里塞一个 CLI 专用字段会让所有工具的参数校验都要跟着改。
 */
export async function callTool(
  runtime: Runtime,
  name: string,
  args: Record<string, unknown>,
  projectPath?: string
): Promise<ToolCallResult> {
  const raw = await runtime.deadline(
    runtime.client.callTool({
      name,
      arguments: args,
      _meta: {
        unrealBox: {
          cliContractVersion: 1,
          ...(projectPath ? { projectPath } : {})
        }
      }
    }),
    `调用 ${name}`
  )

  const result = raw as ToolCallResult

  // HTTP 200 和 MCP 请求成功都不等于工具成功（§6.2）。isError 必须查。
  if (result.isError) {
    const code = (result._meta?.unrealBox as { errorCode?: string } | undefined)?.errorCode
    throw toolFailure(name, result, code)
  }

  return result
}

export interface ToolCallResult {
  content?: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  isError?: boolean
  _meta?: Record<string, unknown>
}

/**
 * 把工具失败翻成带码的错误。
 *
 * 服务端在 `_meta.unrealBox.errorCode` 里给了机器可读的码，用它。
 * 认不出来的一律归 `TOOL_FAILED` 并**保留原始诊断** —— 不去按中文字符串
 * 猜更精细的类别，那是在编造分类（§6.2）。
 */
function toolFailure(name: string, result: ToolCallResult, code: string | undefined): UeboxError {
  const message = textOf(result) || `${name} 执行失败`

  // 引擎那侧等超时了。**这不是失败**：请求已经到引擎，操作可能已经生效。
  //
  // 外部评审抓到的：写工具内部等 60 秒，比 CLI 默认的 120 秒先到，所以真机上
  // 超时几乎总是走这条路。原来它掉进下面的 default 被标成 `failed`，
  // 调用方据此重试就可能生成第二个 Actor —— §12 整套规则要防的正是这个。
  //
  // 归到 TIMEOUT 之后，runWrite 的既有分支会接住它并附上回读命令
  // 「按这个条件没查到」不是故障。归成一个专用码，让调用点自己决定怎么读它 ——
  // 对 `actors delete` 的回读来说，查不到正是成功
  if (code === 'ENGINE_NOT_FOUND') {
    return new UeboxError('ENGINE_NOT_FOUND', message, undefined, 'not_started')
  }

  if (code === 'ENGINE_TIMEOUT') {
    return new UeboxError(
      'TIMEOUT',
      message,
      '引擎在超时前没有回话，操作可能已经生效。先去核实，不要直接重发。',
      'unknown'
    )
  }

  switch (code) {
    case 'PROJECT_NOT_CONNECTED':
    case 'PROJECT_AMBIGUOUS':
    case 'TOOL_UNAVAILABLE':
    case 'INVALID_ARGUMENT':
      return new UeboxError(code, message, undefined, 'not_started')
    default:
      // 引擎那侧明确回了失败，所以是 failed 而不是 unknown。
      // 但 failed **不承诺副作用已经回滚**。
      return new UeboxError('TOOL_FAILED', message, undefined, 'failed')
  }
}

/** 把结果里的文本块拼起来。图片块不进来 —— 终端不打印 base64（§6.3） */
export function textOf(result: ToolCallResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/**
 * 盒子当前注册着哪些工程。
 *
 * 复用 `ue_session_health` 而不是另开一个网络接口：那份连接数据已经有了，
 * 再做一个只会多一处会漂移的真相。
 */
export async function registeredProjects(runtime: Runtime): Promise<RegisteredProject[]> {
  const tools = await catalog(runtime)
  requireSupported(tools, SESSION_HEALTH_TOOL)

  const result = await callTool(runtime, SESSION_HEALTH_TOOL, {})
  const connections = result.structuredContent?.connections

  if (!Array.isArray(connections)) {
    throw new UeboxError(
      'INCOMPATIBLE_SERVER',
      '虚幻盒子没有返回结构化的连接清单。',
      '升级虚幻盒子 —— 旧版本只把连接情况写在一段文字里，没法当接口用。'
    )
  }

  return connections
    .map((entry) => entry as Record<string, unknown>)
    .filter(
      (entry) => typeof entry.connectionId === 'string' && typeof entry.projectPath === 'string'
    )
    .map((entry) => ({
      connectionId: entry.connectionId as string,
      name: typeof entry.projectName === 'string' ? entry.projectName : '(未知工程名)',
      path: entry.projectPath as string
    }))
}

/** 定下这一条命令的目标工程 */
export async function targetProject(
  runtime: Runtime,
  explicit: string | undefined
): Promise<ResolvedProject> {
  return resolveProject(explicit, await registeredProjects(runtime))
}

// ── 写操作 ──────────────────────────────────────────────────────────────────

/** 回读用的工具。写操作全都是关卡内对象，所以三条命令共用它 */
const ACTOR_TOOL = 'ue_get_actor'

/**
 * 按名字回读一个 Actor。
 *
 * @returns 查到的那个；查不到是 `null`（**不是抛错** —— 「不在」本身就是
 *   一个有效的核实结果，删除那条命令要的正是它）
 */
export async function readActor(
  runtime: Runtime,
  name: string,
  projectPath: string
): Promise<ActorReadback | null> {
  let result: ToolCallResult
  try {
    result = await callTool(
      runtime,
      ACTOR_TOOL,
      { targets: { names: [name] }, return_transform: true, limit: 1 },
      projectPath
    )
  } catch (error) {
    // 真机上抓到的：查不到的时候插件回 RPC 404，工具把它当成一次失败。
    // 而查不到正是这里最重要的一种答案 —— 删完回读查不到 = 删成功了，
    // 生成前查不到 = 名字可用。不接住的话，三条写命令里有两条在真机上
    // 根本跑不通，而假盒子返回空数组，一路绿灯看不出来。
    if (error instanceof UeboxError && error.code === 'ENGINE_NOT_FOUND') return null
    throw error
  }

  const actors = result.structuredContent?.actors
  if (!Array.isArray(actors) || actors.length === 0) return null
  return actors[0] as ActorReadback
}

export interface WriteOutcome {
  /** 工具返回的原始结果 */
  result: ToolCallResult
  /** 回读之后的判定 */
  verdict: Verdict
  /** 回读到的 Actor（删除成功时是 null） */
  actor: ActorReadback | null
}

/**
 * 跑一条写操作：收窄参数 → （必要时）查重名 → 调用 → 回读 → 判定。
 *
 * ## 为什么一定要回读
 *
 * 「工具返回成功」和「引擎里真的变成那样了」是两件事。仓库既有的原则是
 * 问引擎的当前状态、不问模型的记忆（`core/reviewChanges.ts` 的文件头把理由
 * 说透了），写操作尤其如此 —— 报一个没核实过的 success，调用方就会在一个
 * 假前提上继续往下做。
 *
 * ## 为什么超时要单独接住
 *
 * 超时是唯一会落到 `unknown` 的路径，也是写操作真正危险的地方：请求已经发出去
 * 了，我们只是不再等。这时候**不能报失败**（调用方会重发，而重发一条已经生效的
 * 生成命令就是第二个 Actor），也不能报成功。只能把核实办法连同那条具体命令
 * 交给调用方（§12.4）。
 */
export async function runWrite(
  runtime: Runtime,
  op: WriteOp,
  args: Record<string, unknown>,
  project: ResolvedProject
): Promise<WriteOutcome> {
  op.constrain(args)
  const subject = op.subject(args)

  // 不幂等的操作，动手前先确认这个名字是空的。
  //
  // 引擎在重名时会退让到 `MyCube_1`，所以名字被占着的时候，「MyCube 在不在」
  // 这个判据是坏的 —— 事后查到的那个可能是本来就有的。先查一次，把判据修好
  if (!op.idempotent) {
    const existing = await readActor(runtime, subject, project.path)
    if (existing) {
      throw new UeboxError(
        'INVALID_ARGUMENT',
        `关卡里已经有一个叫 ${subject} 的 Actor 了。`,
        '换一个名字。重名时引擎会退让到 ' +
          `${subject}_1，一旦超时你就分不清场上那个是这次生成的还是原来那个 —— ` +
          '没有可靠判据的写操作 CLI 不发。'
      )
    }
  }

  // 发出去的是重建过的最小参数，不是调用方给的那个对象（见 WriteOp.payload）
  const outgoing = op.payload(args)

  let result: ToolCallResult
  try {
    result = await callTool(runtime, op.tool, outgoing, project.path)
  } catch (error) {
    throw error instanceof UeboxError && error.code === 'TIMEOUT'
      ? unknownWrite(op, subject, project, 'call')
      : error
  }

  // 回读也可能超时，而这一段原来在 try 外面：那样用户拿到的是一句没有上下文的
  // 「超时」，完全看不出写操作已经发出去了。这条路径比上面那条更要紧 ——
  // 工具已经回了成功，改动多半已经落下，只是没能核实
  let actor: ActorReadback | null
  try {
    actor = await readActor(runtime, subject, project.path)
  } catch (error) {
    throw error instanceof UeboxError && error.code === 'TIMEOUT'
      ? unknownWrite(op, subject, project, 'readback')
      : error
  }

  return { result, verdict: op.verify(args, actor), actor }
}

/**
 * 超时之后交给调用方的东西：一条能直接敲的回读命令，加上怎么读它的结果。
 *
 * 不做成有状态的 `uebox verify` 命令 —— 那要把「上一次尝试了什么」落盘，
 * 而信封的全部价值就是无状态（§12.4）。
 */
function unknownWrite(
  op: WriteOp,
  subject: string,
  project: ResolvedProject,
  /** 在哪一步超的时：发请求，还是发完之后回读 */
  stage: 'call' | 'readback'
): UeboxError {
  const verifyCommand = `uebox actors list --name "${subject}" --project "${project.path}"`

  // 两种结局不明程度不一样，说法就得不一样。回读那一步超时的时候工具已经
  // 回了成功，改动多半已经落下 —— 把它讲成「不知道做没做」会让人白重发一次
  const message =
    stage === 'call'
      ? `${op.tool} 的执行结局不明：请求已经发给引擎了，没等到结果。`
      : `${op.tool} 报告成功了，但随后的回读超时，没能核实引擎的实际状态。`

  return new UeboxError(
    'TIMEOUT',
    message,
    `不要直接重发。先用这条确认它到底做了没有：\n  ${verifyCommand}\n${op.readbackMeaning}`,
    'unknown'
  )
}
