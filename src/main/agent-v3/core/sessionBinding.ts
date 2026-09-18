/**
 * 「这条对话属于哪个工程」——**唯一**的主人。
 *
 * ## 为什么要有这个文件
 *
 * 这件事原先同时住在四个地方：渲染层的会话列表（侧边栏按它分组）、执行流的
 * AsyncLocalStorage、执行记录文件、以及渲染层随每条消息带下来的那份戳。
 * 四份都能被独立地写、独立地失败，谁也不是权威。
 *
 * 代价是实打实的：三轮代码复查一共 45 个问题，其中九个直接来自「某一处忘了跟上
 * 另一处」，而每次修复的做法都是**再加一个同步点**，于是下一轮那个新同步点自己
 * 出问题。两次修出来的东西比它要修的毛病还糟 —— 一次把「命令发往死连接会当场
 * 报错」改成了「命令悄悄落进旁边那个工程」。
 *
 * 所以这里只留一个主人：**主进程内存里的这张表**。另外三处降级成它的投影 ——
 * 渲染层显示它、执行记录持久化它、执行流按 `sessionId` 查它。没有第二个写入点，
 * 也就没有「谁忘了跟上谁」这类 bug 可写。
 *
 * ## 三态，缺一不可
 *
 * - **没有记录**（`undefined`）：这条会话还没定过归属，拿渲染层的戳初始化。
 * - **有对象**：归属这个工程。
 * - **`null`**：用户或模型**明确解除**过。它必须和「没有记录」分得开 ——
 *   混在一起的话，解除之后下一条消息带上来的旧戳会把归属原样复活，
 *   而工具刚跟用户说过「已解除」。
 */

import type { SessionProjectRef } from './sessionScope'

/**
 * sessionId → 归属。
 *
 * 进程内存，跟着应用生命周期走。盒子重启后由执行记录里那份重新灌进来 ——
 * 见 `adoptSessionBinding()` 的 `fromRecord`。
 */
const bindings = new Map<string, SessionProjectRef | null>()

/** 归一成一份干净的戳；名字是空的等同「没有归属」 */
function normalize(project: SessionProjectRef | null | undefined): SessionProjectRef | null {
  const projectName = project?.projectName?.trim()
  if (!projectName) return null
  return {
    projectName,
    ...(project?.projectPath ? { projectPath: project.projectPath } : {}),
    ...(project?.engineVersion ? { engineVersion: project.engineVersion } : {})
  }
}

/**
 * 这条会话此刻的归属。没记录时返回 `undefined`。
 *
 * 只读，不初始化 —— 初始化是 `adoptSessionBinding()` 的事，那需要调用方
 * 给出渲染层的戳和执行记录。
 */
export function getSessionBinding(sessionId: string): SessionProjectRef | null | undefined {
  return bindings.get(sessionId)
}

/**
 * 定这条会话的归属。**唯一的写入口。**
 *
 * @param project 归属的工程；`null` = 明确解除
 * @returns 归一之后真正记下的那份
 */
export function setSessionBinding(
  sessionId: string,
  project: SessionProjectRef | null
): SessionProjectRef | null {
  const next = normalize(project)
  bindings.set(sessionId, next)
  return next
}

/**
 * 拿到这条会话该用的归属，没记录就用给进来的那份初始化。
 *
 * 每一轮开始时调一次，**所有**读归属的地方都从这里拿结果 —— 提示词、工具清单、
 * 越界判断、续跑，一份来源。
 *
 * 优先级只有一条：**表里有记录就听表的。** 渲染层的戳和执行记录只在表里什么都
 * 没有时用来初始化，之后再也不覆盖它 —— 否则模型这一轮改了归属，下一条消息
 * 带着旧戳上来又把它改回去，而工具刚跟用户说过已经改好了。
 * 唯一允许的补全：同名旧戳还没有路径时，接收渲染层保存的文件夹路径。
 *
 * @param fromRenderer 渲染层随这条消息带下来的戳（首次归属靠它）
 * @param fromRecord 执行记录里存着的归属（盒子重启后靠它）。`null` 是「明确解除过」，
 *   和 `undefined`（这条记录里压根没写过）不是一回事
 */
export function adoptSessionBinding(
  sessionId: string,
  fromRenderer: SessionProjectRef | null | undefined,
  fromRecord?: SessionProjectRef | null | undefined
): SessionProjectRef | null {
  const known = bindings.get(sessionId)

  /*
   * 执行记录优先于渲染层：任务在 A 上跑一半、用户顺手连上 B 时，续跑必须回 A。
   * 渲染层那份说的是「界面此刻怎么显示」，不是「这条任务在哪跑」。
   */
  const seed = known !== undefined ? known : fromRecord !== undefined ? fromRecord : fromRenderer
  /*
   * 旧会话可能只存了名字。只补同一归属缺失的路径，绝不覆盖已知路径或明确解绑。
   *
   * 为什么需要这一条：会话的戳只在「引擎连着那一刻」才顺带记下路径，所以从没
   * 连过引擎的会话（非 UE 工程尤其典型）永远只有一个名字。而路径盒子其实有 ——
   * 用户在侧栏登记过，躺在渲染层的 `manualProjects` 里。不接这一下，模型就只能
   * 跟用户说「我不知道这个工程在哪」，而那是句会让人火大的实话。
   *
   * **只比名字是安全的**，因为候选本身就唯一：`chatSidebarStore.addManualProject`
   * 按归一化名字去重，侧栏清单里同一个名字永远只有一条。哪天那个去重没了，
   * 这里就会在两个同名工程之间瞎猜 —— `chatSessions.test.ts` 里有一条测试钉着
   * 那个前提。
   */
  if (
    seed &&
    !seed.projectPath?.trim() &&
    fromRenderer?.projectPath?.trim() &&
    seed.projectName.trim().toLowerCase() === fromRenderer.projectName.trim().toLowerCase()
  ) {
    return setSessionBinding(sessionId, {
      ...seed,
      projectPath: fromRenderer.projectPath.trim(),
      ...(seed.engineVersion || !fromRenderer.engineVersion
        ? {}
        : { engineVersion: fromRenderer.engineVersion })
    })
  }
  if (known !== undefined) return known
  return setSessionBinding(sessionId, seed ?? null)
}

/** 会话删掉时把记录也删掉，免得进程越跑表越长 */
export function forgetSessionBinding(sessionId: string): void {
  bindings.delete(sessionId)
}

/** 只给测试用：清空整张表 */
export function __resetSessionBindingsForTest(): void {
  bindings.clear()
}
