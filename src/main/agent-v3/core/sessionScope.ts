/**
 * 「这条会话属于哪个工程」和「编辑器现在开着哪个工程」是两件事。
 *
 * 侧边栏按工程给会话分组：会话第一次发消息时盖一个工程戳，之后不再变
 * （见 `renderer/.../sessionProjectBinding.ts`）。所以一条挂在 test222 下的
 * 会话，完全可能在 UALinkDev55 连着的时候被继续聊。
 *
 * 在此之前主进程只认「当前连接」：系统提示词里的 `<environment>` 说的是它，
 * 工具也发给它。用户在 test222 下问「这是啥项目」，模型照着环境块把
 * UALinkDev55 的模块、插件、默认地图一五一十答了出来 —— 答案本身没错，
 * 但它回答的不是用户问的那个工程，而且全程没说自己换了个工程。
 *
 * 规则是**项目对项目**：
 * - 会话归属的工程**正连着**：工具发给它（多连接时不再靠「最近连接的那个」猜）
 * - 会话归属的工程**没连**：这条会话就没有引擎能力 —— ue.* 工具整个不注册。
 *   别的工程连着也不碰：那是另一个项目，替用户在它身上动手是最坏的结果。
 *   提示词里把话说明白：要在这里干活，去把 test222 打开，或者把会话移出项目。
 * - 会话**没有归属**（纯对话）：跟着当前连接走，也就是改动之前的老行为
 */

import { projectPathKey } from './projectPathKey'

/** 会话身上盖的工程戳，由渲染层随每一轮传下来 */
export interface SessionProjectRef {
  projectName: string
  projectPath?: string
  engineVersion?: string
}

/** 一个已连接的 UE 工程。字段取 `ProjectInfo` 的子集 */
export interface ConnectedProjectRef {
  connectionId: string
  projectName: string
  projectPath?: string
  engineVersion?: string
}

/**
 * 项目库里的一条工程记录（SQLite `projects` 表，首页导入/新建时写进去的）。
 *
 * 会话上的戳只有名字 —— 只有工程连着的那一刻盖的戳才顺带记下路径。
 * 于是「归入 test222」的会话，盒子其实**知道** test222 在哪（库里有），
 * 却从来没去查过：真机上模型为了找那个 `.uproject`，从 C:/ 开始整盘扫。
 */
export interface LibraryProjectRef {
  projectName?: string | null
  projectPath?: string | null
  engineVersion?: string | null
}

export interface SessionProjectScope {
  /**
   * 这条会话能不能用引擎工具。
   *
   * 归属的工程没连上时是 false —— 哪怕别的工程连得好好的。ue.* 工具因此
   * 整个不注册（见 `resolveTools`），模型想越界也没有手。
   */
  engineAvailable: boolean
  /** 这一轮工具该发往的连接。undefined = 不指定，工具回退到第一个连接 */
  targetConnectionId?: string
  /** 工具实际会操作的那个已连接工程，进 `<environment>` 的「Unreal Engine: connected」一行 */
  connectedProject?: ConnectedProjectRef
  /** 会话归属的工程，以及它此刻连没连着 */
  sessionProject?: { name: string; engineVersion?: string; path?: string; connected: boolean }
  /**
   * 连着、但不属于这条会话的工程名。
   *
   * 只在归属工程没连上时有意义：模型得知道「引擎其实开着，只是开的不是你的工程」，
   * 否则它会把用户往「装插件、连引擎」的方向引，而用户明明已经连着了。
   */
  outOfScopeProjects: string[]
}

/**
 * 比路径用**全仓库唯一**的那把尺子（`core/projectPathKey.ts`）。
 *
 * 这里以前有一份私有拷贝，它不削 `.uproject` —— 而 `retargetToProject` 用的
 * 那份削。两份坐在同一个判断的两边：戳记着 `I:/Dev/Pond/Pond.uproject`、
 * 插件报 `I:/Dev/Pond` 时，切目标那边认为是同一个工程、切了过去并告诉用户
 * 「已经改发给它」，而这里认为没连上、一个 `ue.*` 都不注册。模型手里空空，
 * 嘴上却说接上了。谁都不许再抄第二把尺子。
 */
const normalizePath = projectPathKey

function normalizeName(value: string | undefined): string {
  return (value || '').trim().toLowerCase()
}

/**
 * 在已连接的工程里找出这条会话归属的那个。
 *
 * 先比路径后比名字：名字重名很常见（同一个工程复制一份改改就是另一个），
 * 路径才是唯一的。老会话的戳可能没存路径，那时只能退到名字。
 */
export function matchConnectedProject(
  sessionProject: SessionProjectRef | null | undefined,
  connected: ConnectedProjectRef[]
): ConnectedProjectRef | undefined {
  if (!sessionProject) return undefined

  const path = normalizePath(sessionProject.projectPath)
  if (path) {
    // 已知路径就是工程身份；同名备份不能替代未连接的原工程。
    return connected.find((project) => normalizePath(project.projectPath) === path)
  }

  const name = normalizeName(sessionProject.projectName)
  if (!name) return undefined

  return connected.find((project) => normalizeName(project.projectName) === name)
}

/**
 * 戳上没有路径时，去项目库里按名字补一个。
 *
 * 名字是会话戳里唯一靠得住的东西，而项目库是用户自己在首页登记的那份，
 * 里面有完整路径和引擎版本。补上之后有两个好处：匹配连接可以走路径
 * （比名字准），提示词里也能直接写出工程在哪，模型不用再满盘找。
 */
export function fillProjectPath(
  sessionProject: SessionProjectRef | null | undefined,
  library: LibraryProjectRef[] = []
): SessionProjectRef | null | undefined {
  const name = normalizeName(sessionProject?.projectName)
  if (!sessionProject || !name || sessionProject.projectPath) return sessionProject

  const record = library.find((item) => normalizeName(item.projectName ?? undefined) === name)
  const libraryPath = record?.projectPath?.trim()
  if (!libraryPath) return sessionProject

  return {
    ...sessionProject,
    projectPath: libraryPath,
    ...(sessionProject.engineVersion || !record?.engineVersion
      ? {}
      : { engineVersion: record.engineVersion })
  }
}

/**
 * @param sessionProject 会话归属的工程；没盖过戳就是 null/undefined（纯对话）
 * @param connected 当前所有已连接的工程
 * @param current 「当前工程」（最近连接的那个），纯对话跟着它走
 * @param library 项目库里的工程，用来给没有路径的戳补上路径
 */
export function resolveSessionScope(
  sessionProject: SessionProjectRef | null | undefined,
  connected: ConnectedProjectRef[],
  current?: ConnectedProjectRef,
  library: LibraryProjectRef[] = []
): SessionProjectScope {
  const stamped = fillProjectPath(sessionProject, library)
  const name = stamped?.projectName?.trim()

  // 纯对话：没定过归属，跟着当前连接走。
  // engineAvailable 恒为 true —— 有没有引擎交给宿主的 `isUeConnected()` 判，
  // 那边看的是 WebSocket 连接数，握手还没走完时比 projectManager 更早知道。
  if (!name) {
    return {
      engineAvailable: true,
      ...(current ? { targetConnectionId: current.connectionId, connectedProject: current } : {}),
      outOfScopeProjects: []
    }
  }

  const matched = matchConnectedProject(stamped, connected)

  // 归属工程连着时，版本/路径以引擎报上来的为准 —— 会话上那份是盖戳当时的快照
  const session = {
    name,
    connected: Boolean(matched),
    ...(matched?.engineVersion || stamped?.engineVersion
      ? { engineVersion: matched?.engineVersion || stamped?.engineVersion }
      : {}),
    ...(matched?.projectPath || stamped?.projectPath
      ? { path: matched?.projectPath || stamped?.projectPath }
      : {})
  }

  if (!matched) {
    return {
      engineAvailable: false,
      sessionProject: session,
      outOfScopeProjects: connected.map((project) => project.projectName)
    }
  }

  return {
    engineAvailable: true,
    targetConnectionId: matched.connectionId,
    connectedProject: matched,
    sessionProject: session,
    outOfScopeProjects: connected
      .filter((project) => project.connectionId !== matched.connectionId)
      .map((project) => project.projectName)
  }
}
