/**
 * 当前 Agent 执行的目标项目上下文。
 *
 * 多 UE 项目场景下，让 UE 工具知道指令该发给哪个项目。
 *
 * ## 为什么是 AsyncLocalStorage 而不是模块级变量
 *
 * 原来这里是一个 `let _targetConnectionId`，在 `ipc/agentV3.ts` 的
 * `bindTargetProject()` 里赋值。一个进程一个值，而：
 *
 *   - `defineUeTool` 默认 `concurrency: 'parallel'`，同一轮里多个 UE 工具并发跑；
 *   - 两个会话可以同时执行（`activeAgents` 是个 Map，本来就允许并发）；
 *   - 子 Agent 有自己的执行流。
 *
 * 于是后启动的那个会话会把前一个的目标覆盖掉，而且执行完也没人清理。
 * 表现和 V2 时代那个 bug 一模一样：**指令静默发到了别的工程上**——
 * 没有报错，只是用户发现自己另一个项目的关卡被改了。
 *
 * `AsyncLocalStorage` 让这个值跟着**执行流**走而不是跟着进程走：
 * 每个会话在自己的 `runWithTargetConnectionId()` 里跑，里面无论异步多少层、
 * 并发多少个工具，读到的都是自己那份。
 *
 * 读到 undefined 表示「没指定」。此时 `WebSocketService` 只在恰好一个连接时
 * 才回退，多个连接一律拒绝 —— 猜错工程的代价比报错高得多。
 *
 * ## 为什么还要记住工程路径
 *
 * connectionId 是**一次连接**的 id，不是一个工程的 id：编辑器崩一次、重启一次，
 * 回来就是一个全新的 uuid，旧记录在断开时已经被 `deleteProject()` 整条删掉。
 *
 * 而目标是每轮开始时算一次就定死在执行流上的（见 `ipc/agentV3.ts` 的
 * `resolveTargetProject`）。于是真机上出现过这一幕：编辑器崩了、用户手动把它
 * 重开、插件也重新握上手了 —— 盒子界面上明明显示已连接，模型这一轮里发的
 * 每一条引擎命令却仍然发往那个死 id，一律回「客户端不存在或已断开」。
 * 模型据此一口咬定「引擎没连上」，让用户去连一个他早就连好的工程。
 *
 * 所以这里连**工程路径**一起记。路径跨重启是稳定的，凭它就能在同一个工程
 * 重新连上时认回新连接 —— 见 `getTargetConnectionId()`。
 *
 * **只认同一个工程路径**，这是这段自愈逻辑的安全边界：绝不会因为目标死了
 * 就顺手改发给旁边那个连着的工程。静默发错工程比报一个错糟糕得多。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

// 直接指 projectManager 而不走 `services/project` 的桶文件：那个桶还导出
// 模板下载/解压，对一个只想查连接的模块来说是白背一堆依赖
import { projectManager } from '../../services/project/projectManager'
import { isSameProjectPath, projectPathKey } from './projectPathKey'
import { getSessionBinding } from './sessionBinding'
import type { SessionProjectRef } from './sessionScope'

/**
 * 执行流上只放**这一轮的目标连接**，外加它属于哪条会话。
 *
 * 归属（这条对话属于哪个工程）**不在这里** —— 它有唯一的主人，
 * `core/sessionBinding.ts` 那张表，这里按 `sessionId` 去查。
 *
 * 曾经这里也存了一份（`sessionScoped` / `sessionProjectPath` /
 * `sessionProjectName` / `sessionRebound` 四个字段），于是同一件事在四个地方
 * 各存一份、各写各的。三轮复查里九个问题直接来自「某一处忘了跟上另一处」，
 * 而每次的修法都是再加一个同步点。四个字段现在全删了：只有一份可读，
 * 也就没有「哪份是新的」这个问题。
 */
interface TargetProjectStore {
  connectionId: string | undefined
  /** 这条连接指向的工程根目录。跨重启稳定，是认回新连接的唯一依据 */
  projectPath?: string
  /** 这条执行流属于哪条会话。查归属只需要它 */
  sessionId?: string
}

/** 绑定目标时可以给的东西：只给 id，或者连工程路径一起给 */
export interface TargetProjectRef {
  connectionId?: string
  projectPath?: string
  /**
   * 这条执行流属于哪条会话。
   *
   * `retargetToProject()` 和 `isOutOfSessionScope()` 拿它去 `sessionBinding`
   * 查归属 —— 不给的话这条流就是「没有归属」，跨工程那道闸对它不生效。
   * 外部 MCP 调用、无头跑本来就没有会话，那是对的；agent 的每一轮都必须给。
   */
  sessionId?: string
}

const storage = new AsyncLocalStorage<TargetProjectStore>()

/** Host-bound identity, never supplied by tool arguments. */
export function getCurrentSessionId(): string | undefined {
  return storage.getStore()?.sessionId
}

/*
 * 这里一度 `export { projectPathKey as normalizeProjectPath }`，方便旧调用点不改名。
 * 那个别名已经删了：`src/main/utils/projectPath.ts` 里有一个**同名但不削
 * `.uproject`** 的函数，于是 `import { normalizeProjectPath }` 到底拿到哪把尺子
 * 取决于你打的是哪条模块路径 —— 而 `projectPathKey.ts` 存在的全部理由就是结束
 * 这种歧义。要比路径就直接 import `projectPathKey`，名字只有一个。
 */

/** 模块内简称 */
const normalizePath = projectPathKey

/**
 * 在指定目标项目的上下文里跑一段逻辑。
 *
 * `fn` 内部（含其所有异步后代）调用 `getTargetConnectionId()` 都会拿到这个目标。
 * 退出后自动恢复，不需要也不应该手工清理。
 *
 * @param target 目标项目。给字符串等同于 `{ connectionId }`；`undefined` 表示不指定。
 *   **能给上 `projectPath` 就一定要给** —— 没有它，编辑器重启之后这条执行流
 *   就再也认不回新连接了。
 */
export function runWithTargetConnectionId<T>(
  target: string | TargetProjectRef | undefined,
  fn: () => T
): T {
  const ref: TargetProjectRef =
    typeof target === 'string' ? { connectionId: target } : (target ?? {})
  /*
   * 会话**跟着继承**，不给就沿用外面那一层的。
   *
   * 嵌套的执行流（导入之后放场景那段就是一个）改的是「这一段发给哪个连接」，
   * 从来不是「这条对话属于谁」—— 会话没变过。而归属现在全靠 `sessionId` 去
   * `sessionBinding` 查，漏传就等于「这条流没有归属」，跨工程那道闸对整段
   * 静默失效，不会有任何报错。TS 对展开进来的多余属性也不做检查，写错了
   * 同样不报。所以默认继承，只有明确要换会话时才传（实际没有这种场景）。
   *
   * 从**没有**上下文的地方进来时（外部 MCP 调用、HTTP 接口、无头跑）外层是空的，
   * 继承出来还是 undefined —— 那些路径本来就没有会话，闸门不对它们生效是对的。
   */
  const inherited = storage.getStore()?.sessionId
  const sessionId = ref.sessionId ?? inherited
  return storage.run(
    {
      connectionId: ref.connectionId,
      ...(ref.projectPath ? { projectPath: ref.projectPath } : {}),
      ...(sessionId ? { sessionId } : {})
    },
    fn
  )
}

/**
 * 目标连接还活着吗。
 *
 * 看 `projectManager` 而不是 WebSocket 连接池：能接命令的前提是插件已经把
 * 工程信息报上来了（握手走完），只有 socket 连着还不够。
 */
function isLive(connectionId: string): boolean {
  try {
    return projectManager.getProject(connectionId)?.isConnected === true
  } catch {
    // 项目服务没起来时不敢说它死了 —— 报「还活着」会让调用方照常发命令、
    // 拿到一个真实的失败信息，比这里擅自改道安全
    return true
  }
}

/** 同一个工程路径此刻连着的那条连接 */
function findByProjectPath(projectPath: string): string | undefined {
  try {
    const wanted = normalizePath(projectPath)
    if (!wanted) return undefined
    return projectManager
      .getInteractiveProjects()
      .find((project) => normalizePath(project.projectPath) === wanted)?.connectionId
  } catch {
    return undefined
  }
}

/**
 * 获取当前执行流的目标项目 connectionId。
 *
 * **目标死了、而同一个工程已经重新连上时，这里会自动认回新连接。**
 * 编辑器崩溃或重启后 connectionId 必然换一个（见文件头），不认回来的话这一轮
 * 剩下的每条命令都发往一个死 id —— 而盒子界面上明明写着已连接。
 *
 * 认回来的新 id 写回同一个 store 对象，所以并发的兄弟工具、子 Agent 会一起
 * 切过去：它们要操作的本来就是同一个工程。
 *
 * 三条边界：
 * - 只按**工程路径**认，绝不改发给别的工程；
 * - 记不住路径（没传 `projectPath`）就不认，宁可让调用方拿到真实的失败信息；
 * - 那个工程此刻没连着也不认，返回原来的死 id —— 错误信息里带着它，
 *   比返回 undefined 让 `pickDefaultConnectionId()` 去挑一个别的工程要诚实。
 *
 * @returns connectionId，或 undefined（未在上下文中，或显式未指定）
 */
export function getTargetConnectionId(): string | undefined {
  const store = storage.getStore()
  const current = store?.connectionId
  if (!store || !current || !store.projectPath) return current

  if (isLive(current)) return current

  const rebound = findByProjectPath(store.projectPath)
  if (!rebound || rebound === current) return current

  store.connectionId = rebound
  return rebound
}

/**
 * 改掉当前执行流的目标 connectionId。
 *
 * `ue_restart_editor` 用它：重启是它自己发起的，它在掐断连接**之前**就抓好了
 * 工程路径，能比 `getTargetConnectionId()` 的自愈更早、更确定地切过去
 * （自愈要等到下一次读，而重启工具就在等这条新连接）。
 *
 * 存的是同一个 store 对象，所以并发的兄弟工具也会跟着换到新连接 ——
 * 这正是想要的：它们要操作的是同一个工程。
 *
 * @returns 是否写进去了（不在上下文里时为 false）
 */
export function setTargetConnectionId(id: string): boolean {
  const store = storage.getStore()
  if (!store) return false
  store.connectionId = id
  // 顺手把路径也更新成新连接报上来的那份：重启后工程还是同一个，
  // 但记着新记录里的写法能让后面的自愈比对更稳
  const path = (() => {
    try {
      return projectManager.getProject(id)?.projectPath
    } catch {
      return undefined
    }
  })()
  if (path) store.projectPath = path
  return true
}

/**
 * 这条会话被钉在别的工程上了吗。
 *
 * 「项目对项目」那道闸原先只挡住读 `getTargetConnectionId()` 的那类工具 ——
 * 引擎工具在归属工程没连着时整个不注册，所以它们够不着。但 `project_manage`
 * 的导入动作是 `project` 命名空间，不受那道过滤影响，而且它**按参数**点名工程、
 * 自己开一个嵌套的执行流上下文，压根不读这个 store。于是一条挂在 A 下面的对话
 * 可以 `import_assets_to_scene({target:{projectKey:'B'}})`，把资产拷进 B、
 * 把 Actor 生成到 B 的关卡里，全程没有任何拦截。
 *
 * 这个判断给那条路用：点名的工程不是归属工程就拒绝。
 *
 * 说不出归属路径时（戳上只有名字、库里也查不到）一律**不拦** —— 证不明越界
 * 就别挡住用户正常的活；真正的越界是「明知道归属是 A，还往 B 写」。
 */
export function isOutOfSessionScope(projectPath: string | null | undefined): boolean {
  const bound = boundProject()
  if (!bound?.projectPath) return false
  return !isSameProjectPath(bound.projectPath, projectPath)
}

/** 这条会话钉着的工程路径，报错时告诉用户「你这条对话属于谁」 */
export function getSessionProjectPath(): string | undefined {
  return boundProject()?.projectPath
}

/**
 * 这条执行流所属会话的归属工程。
 *
 * 唯一的来源是 `sessionBinding` 那张表 —— 这里不存第二份。没有 `sessionId`
 * （外部 MCP 调用、无头跑）就是「没有归属」，跨工程那道闸对它不生效，
 * 那些路径本来也没有会话可言。
 */
function boundProject(): SessionProjectRef | null | undefined {
  const sessionId = storage.getStore()?.sessionId
  return sessionId ? getSessionBinding(sessionId) : undefined
}

/** 当前执行流绑定的工程路径。`ue_session_health` 用它说清楚「这一轮盯的是哪个工程」 */
export function getTargetProjectPath(): string | undefined {
  return storage.getStore()?.projectPath
}

/*
 * 这里一度有三个函数，现在一个都不需要了：
 *
 *   - `bindSessionProject()` —— 往执行流上写一份归属。归属现在只有一个主人
 *     （`core/sessionBinding.ts`），写它就是写表，不用再往这儿抄一份。
 *   - `getReboundSessionProject()` —— 「这一轮里归属被改过没有」。它存在的
 *     全部理由是让宿主在两个来源之间挑一个；只有一个来源之后这个问题消失了。
 *   - `releaseDeadTarget()` —— 目标连接没了就把它摘掉。它比要修的 bug 更糟：
 *     摘掉之后底层在恰好一个连接时会回退，命令**悄悄**落进旁边那个工程；
 *     留着死 id 会当场报「客户端不存在或已断开」，那是能看见的失败。
 *     而且 `projectPath` 是崩溃重启自愈唯一的锚，删了就再也认不回那个工程。
 */

/** `retargetToProject()` 的结果。失败分原因 —— 调用方要把不同的原因说给模型听 */
export type RetargetOutcome =
  | { ok: true; connectionId: string; changed: boolean }
  /** 不在任何执行流上下文里（调试入口、无头跑）。目标本来就没绑，不用切 */
  | { ok: false; reason: 'no-context' }
  /** 用户把这条会话钉在别的工程上了，切过去就是越界 */
  | { ok: false; reason: 'session-scoped'; sessionProjectPath?: string }
  /** 那个工程此刻没有交互式编辑器连着 */
  | { ok: false; reason: 'not-connected' }

/**
 * 把这一轮改到另一个工程上 —— 工具自己刚把它打开的那个。
 *
 * ## 为什么这不是「猜工程」
 *
 * `getTargetConnectionId()` 的自愈**只认同一个工程路径**，宁可返回一个死 id
 * 也不改发给旁边那个连着的工程。那条边界针对的是「目标莫名其妙没了」——
 * 那种情况下盒子确实不知道用户想要哪个，猜错就是静默写坏另一个工程。
 *
 * 这里是另一回事：`open_project` 是模型**明确调用**的，参数里就写着要打开哪个
 * 工程，路径是它自己给的、不是推断出来的。打开之后接着在打开的那个工程上干活，
 * 是这次调用唯一说得通的含义。原先不切的后果是：工具把新工程启动起来了，
 * 这一轮剩下的每条引擎命令却仍然发往旧工程 —— 用户要么得自己去界面上切，
 * 要么得再发一条消息。两样都是盒子该自己做完的事。
 *
 * ## 唯一的边界：会话被钉住时不切
 *
 * 用户给会话盖过工程戳（侧边栏的工程分组）时，这一轮的引擎工具是按那个工程
 * 注册的。切到别的工程等于绕开「项目对项目」，让模型在一条挂在 A 下面的会话里
 * 动 B 的资产。这时宁可不切，把原因原样报给模型，让它告诉用户。
 *
 * 比对拿的是**会话钉住的工程**（`sessionProjectPath`），不是此刻连着的那个：
 * 归属工程没开着时后者是空的，拿它比会把「钉在 A 但 A 没开」误判成没钉住，
 * 模型开一个 B 就溜进去了。路径都说不出来（戳上只有名字、库里也查不到）时
 * 一律不切 —— 证不明是同一个工程就不动，代价只是让模型报一句话。
 *
 * @param projectPath 要切过去的工程根目录（或 `.uproject` 路径）
 */
export function retargetToProject(projectPath: string): RetargetOutcome {
  const store = storage.getStore()
  if (!store) return { ok: false, reason: 'no-context' }

  const wanted = normalizePath(projectPath)
  if (!wanted) return { ok: false, reason: 'not-connected' }

  /*
   * 比对的前提是**说得出归属路径**。
   *
   * 说不出来的时候（戳上只有工程名 —— 侧边栏「在这个工程下新建会话」盖的就是
   * 这种，见 `sessionProjectBinding.ts` 的 `stampSessionProject`）一律放行，
   * 和 `isOutOfSessionScope()` 保持同一个方向：证不明越界就别挡。
   *
   * 这里一度是反的 —— 路径说不出来就拒绝。两道闸方向相反的代价是实打实的死路：
   * `open_project` 每次都被 `session-scoped` 挡下，而错误信息里的工程名是空的
   * （`sessionProjectPath` 缺省），模型连「你这条对话属于谁」都转告不了用户；
   * 与此同时真正写东西的那道闸（`isOutOfSessionScope`）对同一个状态是放行的，
   * 于是挡住的只有正当操作，该挡的一个没挡住。
   */
  const bound = boundProject()
  if (bound?.projectPath && normalizePath(bound.projectPath) !== wanted) {
    return { ok: false, reason: 'session-scoped', sessionProjectPath: bound.projectPath }
  }

  const connectionId = findByProjectPath(projectPath)
  if (!connectionId) return { ok: false, reason: 'not-connected' }

  const changed = connectionId !== store.connectionId
  store.connectionId = connectionId
  // 路径以 projectManager 里那份为准：插件报上来的写法（斜杠方向、有没有结尾
  // 斜杠）才是后面自愈比对的基准，模型传进来的那份不一定同形
  store.projectPath = projectManager.getProject(connectionId)?.projectPath ?? projectPath
  return { ok: true, connectionId, changed }
}
