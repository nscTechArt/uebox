/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 已连接工程表。自愈那几条测试靠改它来模拟「编辑器重启了」 */
const projects: Array<{
  connectionId: string
  projectPath: string
  isConnected: boolean
  /** 那头是不是一个能看能点的编辑器。缺省 true，见 `services/project/types.ts` */
  interactive?: boolean
}> = []

vi.mock('../../services/project/projectManager', () => ({
  projectManager: {
    getProject: (id: string) => projects.find((p) => p.connectionId === id),
    getAllProjects: () => projects,
    // 和真实实现同源：连着、而且那头不是跑批的无头进程
    getInteractiveProjects: () => projects.filter((p) => p.isConnected && p.interactive !== false)
  }
}))

import {
  __resetSessionBindingsForTest,
  adoptSessionBinding,
  setSessionBinding
} from './sessionBinding'
import {
  getSessionProjectPath,
  getTargetConnectionId,
  getTargetProjectPath,
  isOutOfSessionScope,
  retargetToProject,
  runWithTargetConnectionId,
  setTargetConnectionId
} from './projectTargetContext'

beforeEach(() => {
  projects.length = 0
  __resetSessionBindingsForTest()
})

/**
 * 把归属钉在某个工程上再跑一段 —— 归属现在住在 `sessionBinding` 那张表里，
 * 执行流只带一个 `sessionId` 过去查。
 *
 * 以前这里是往执行流上塞 `sessionScoped` / `sessionProjectPath` 两个字段，
 * 也就是同一件事的**第二份拷贝**。改成一份之后，「两份不一致」那一整类
 * bug（三轮复查里九个）在类型上就写不出来了。
 */
function withBinding<T>(
  binding: { projectName: string; projectPath?: string } | null,
  ref: { connectionId?: string; projectPath?: string },
  fn: () => T
): T {
  const sessionId = 's-test'
  setSessionBinding(sessionId, binding)
  return runWithTargetConnectionId({ ...ref, sessionId }, fn)
}

/**
 * 这个模块本身很小，但它管的事很大：**指令发给哪个 UE 项目。**
 *
 * 所有 UE 工具都读 `getTargetConnectionId()`。读错的后果是静默的 ——
 * 用户选了 B，工具却操作 A，不报错，只是另一个项目的关卡被改了。
 *
 * 以前这里是个模块级变量。它在单会话下没问题，但工具默认并发执行、
 * 会话也可以并发，于是后来者会覆盖先来者。下面「并发隔离」那几条就是
 * 为了钉死这一点：模块级变量的实现能通过前两条，一定过不了后面几条。
 */
describe('projectTargetContext', () => {
  it('在上下文里读得到绑定的值', () => {
    runWithTargetConnectionId('conn-b', () => {
      expect(getTargetConnectionId()).toBe('conn-b')
    })
  })

  // undefined 是「不指定」。此时 WebSocketService 只在恰好一个连接时才回退，
  // 多连接会拒绝 —— 这是合法状态，不是错误
  it('绑定 undefined 表示不指定', () => {
    runWithTargetConnectionId(undefined, () => {
      expect(getTargetConnectionId()).toBeUndefined()
    })
  })

  it('上下文之外读到 undefined', () => {
    runWithTargetConnectionId('conn-b', () => undefined)
    expect(getTargetConnectionId()).toBeUndefined()
  })

  it('嵌套时内层覆盖外层，退出后恢复', () => {
    runWithTargetConnectionId('outer', () => {
      expect(getTargetConnectionId()).toBe('outer')
      runWithTargetConnectionId('inner', () => {
        expect(getTargetConnectionId()).toBe('inner')
      })
      expect(getTargetConnectionId()).toBe('outer')
    })
  })

  /**
   * 核心回归：两条会话并发，各自看到各自的目标。
   *
   * 模块级变量的实现会让 B 的赋值覆盖掉 A 的 —— A 恢复执行时读到 'conn-b'，
   * 于是 A 的指令发到 B 的工程上。这正是要防的那个 bug。
   */
  it('并发会话之间互不串台', async () => {
    const seen: Array<string | undefined> = []

    const session = async (id: string, delayMs: number): Promise<void> =>
      runWithTargetConnectionId(id, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        seen.push(getTargetConnectionId())
      })

    // A 先进入上下文但后完成；模块级变量实现下它会读到 B 的值
    await Promise.all([session('conn-a', 20), session('conn-b', 1)])

    expect(seen.sort()).toEqual(['conn-a', 'conn-b'])
  })

  it('同一上下文内并发的工具调用都读到同一个值', async () => {
    const results = await runWithTargetConnectionId('conn-a', async () =>
      Promise.all(
        [5, 1, 3].map(async (delayMs) => {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          return getTargetConnectionId()
        })
      )
    )

    expect(results).toEqual(['conn-a', 'conn-a', 'conn-a'])
  })
})

/**
 * 编辑器崩了或重启之后的自愈。
 *
 * connectionId 是**一次连接**的 id，不是工程的 id：编辑器回来时是一条新连接、
 * 新 uuid，旧记录在断开时已经被 `deleteProject()` 删了。而目标是每轮开始时
 * 算一次就定死的，于是这一轮剩下的每条引擎命令都发往那个死 id，一律回
 * 「客户端不存在或已断开」—— 而盒子界面上明明写着已连接。模型据此咬定
 * 「引擎没连上」，让用户去连一个他早就连好的工程。
 *
 * 自愈只认**同一个工程路径**。这条边界比自愈本身更重要：目标死了就顺手改发
 * 给旁边那个连着的工程，是静默改错别人工程 —— 比报错糟糕得多。
 */
describe('目标连接的自愈', () => {
  const bind = <T>(connectionId: string, projectPath: string, fn: () => T): T =>
    runWithTargetConnectionId({ connectionId, projectPath }, fn)

  it('目标还活着时原样返回，不去翻别的连接', () => {
    projects.push({ connectionId: 'conn-1', projectPath: 'I:/Dev/MyGame', isConnected: true })

    bind('conn-1', 'I:/Dev/MyGame', () => {
      expect(getTargetConnectionId()).toBe('conn-1')
    })
  })

  // 核心回归：这就是「AI 咬定没连上，其实早就连上了」的那一幕
  it('编辑器重启换了新 id，按工程路径认回来', () => {
    projects.push({ connectionId: 'conn-NEW', projectPath: 'I:/Dev/MyGame', isConnected: true })

    bind('conn-DEAD', 'I:/Dev/MyGame', () => {
      expect(getTargetConnectionId()).toBe('conn-NEW')
    })
  })

  // 路径大小写和斜杠方向两边可能不一致（进程扫的是反斜杠，插件报的是正斜杠）
  it('路径比对忽略大小写和斜杠方向', () => {
    projects.push({ connectionId: 'conn-NEW', projectPath: 'I:\\Dev\\MyGame\\', isConnected: true })

    bind('conn-DEAD', 'i:/dev/mygame', () => {
      expect(getTargetConnectionId()).toBe('conn-NEW')
    })
  })

  /**
   * 这条是安全边界。别的工程连着不是「可以顶上」的理由 ——
   * 顶上去就是静默改错工程，而那正是这套上下文最初要防的事。
   */
  it('只认同一个工程，绝不改发给旁边那个连着的工程', () => {
    projects.push({
      connectionId: 'conn-OTHER',
      projectPath: 'I:/Dev/OtherGame',
      isConnected: true
    })

    bind('conn-DEAD', 'I:/Dev/MyGame', () => {
      expect(getTargetConnectionId()).toBe('conn-DEAD')
    })
  })

  /**
   * 同一个工程的**无头**进程不算「编辑器回来了」。
   *
   * 插件在 commandlet / `-unattended` / `-nullrhi` 里也连同一个端口，工程路径
   * 一模一样。按路径认回来时不看运行模式的话，用户关掉编辑器之后，命令会被
   * 悄悄改发给一个跑批进程 —— 它没有视口、没有交互，命令看起来「成功」了，
   * 用户的工程里什么都没变。
   */
  it('同路径的无头进程不算编辑器回来了', () => {
    projects.push({
      connectionId: 'conn-HEADLESS',
      projectPath: 'I:/Dev/MyGame',
      isConnected: true,
      interactive: false
    })

    bind('conn-DEAD', 'I:/Dev/MyGame', () => {
      expect(getTargetConnectionId()).toBe('conn-DEAD')
    })
  })

  // 返回死 id 而不是 undefined：undefined 会让 WebSocketService 自己挑一个连接，
  // 在单连接场景下正好挑中别人。报错要带着那个 id，让人看得出发生了什么
  it('那个工程没连着时返回原来的 id，不返回 undefined', () => {
    projects.push({
      connectionId: 'conn-OTHER',
      projectPath: 'I:/Dev/OtherGame',
      isConnected: false
    })

    bind('conn-DEAD', 'I:/Dev/MyGame', () => {
      expect(getTargetConnectionId()).toBe('conn-DEAD')
    })
  })

  it('没记住工程路径就不自愈 —— 宁可让调用方拿到真实的失败信息', () => {
    projects.push({ connectionId: 'conn-NEW', projectPath: 'I:/Dev/MyGame', isConnected: true })

    runWithTargetConnectionId('conn-DEAD', () => {
      expect(getTargetConnectionId()).toBe('conn-DEAD')
    })
  })

  /**
   * 认回来要写回 store，不能每次读都重算：并发的兄弟工具和子 Agent
   * 得一起切过去，它们操作的本来就是同一个工程。
   */
  it('认回来之后写回上下文，并发的兄弟工具跟着切', () => {
    projects.push({ connectionId: 'conn-NEW', projectPath: 'I:/Dev/MyGame', isConnected: true })

    bind('conn-DEAD', 'I:/Dev/MyGame', () => {
      expect(getTargetConnectionId()).toBe('conn-NEW')
      // 新连接此刻从表里消失（又断了）——已经写回的值不该被回滚成死 id
      projects.length = 0
      expect(getTargetConnectionId()).toBe('conn-NEW')
    })
  })

  it('绑定时记下的工程路径读得到', () => {
    bind('conn-1', 'I:/Dev/MyGame', () => {
      expect(getTargetProjectPath()).toBe('I:/Dev/MyGame')
    })
  })

  // ue_restart_editor 自己抓到新连接时走这条，比自愈更早
  it('setTargetConnectionId 顺手把工程路径更新成新连接报的那份', () => {
    projects.push({ connectionId: 'conn-2', projectPath: 'I:/Dev/MyGame', isConnected: true })

    bind('conn-1', 'i:/dev/mygame', () => {
      expect(setTargetConnectionId('conn-2')).toBe(true)
      expect(getTargetConnectionId()).toBe('conn-2')
      expect(getTargetProjectPath()).toBe('I:/Dev/MyGame')
    })
  })
})

/**
 * 换工程 —— 自愈之外的另一条路。
 *
 * 自愈只认**同一个工程**：目标死了、同一个工程重新连上，就认回新连接。它绝不
 * 改发给别的工程，因为那种情况下盒子不知道用户想要哪个，猜错就是静默写坏。
 *
 * 这里是另一回事。`open_project` 是模型**明确调用**的，工程路径是它自己给的
 * 参数。真机上曾经的表现：模型建好新工程、把它打开、编辑器也跑起来了，
 * 而这一轮剩下的每条引擎命令仍然发往旧工程 —— 模型只能请用户去界面上
 * 切一次工程，或者再发一条消息。用户一个字的信息都补不了，那一步纯属盒子偷懒。
 */
describe('retargetToProject —— 工具自己打开工程之后把这一轮切过去', () => {
  it('纯对话会话（没盖工程戳）切得过去', () => {
    projects.push({ connectionId: 'conn-old', projectPath: 'I:/Dev/Old', isConnected: true })
    projects.push({ connectionId: 'conn-new', projectPath: 'I:/Dev/New', isConnected: true })

    runWithTargetConnectionId({ connectionId: 'conn-old', projectPath: 'I:/Dev/Old' }, () => {
      const outcome = retargetToProject('I:/Dev/New')
      expect(outcome).toEqual({ ok: true, connectionId: 'conn-new', changed: true })
      // 后面的工具（含并发的兄弟、子 agent）读到的都是新工程
      expect(getTargetConnectionId()).toBe('conn-new')
      expect(getTargetProjectPath()).toBe('I:/Dev/New')
    })
  })

  // 传 .uproject 文件路径是模型最常见的写法，插件报上来的却是工程目录。
  // 比不出来的后果不是报错，是**永远认不出这就是同一个工程**
  it('给 .uproject 文件路径也认得出是同一个工程', () => {
    projects.push({ connectionId: 'conn-new', projectPath: 'I:/Dev/New', isConnected: true })

    runWithTargetConnectionId({}, () => {
      expect(retargetToProject('I:\\Dev\\New\\New.uproject')).toEqual({
        ok: true,
        connectionId: 'conn-new',
        changed: true
      })
    })
  })

  /**
   * 这条是整个改动的安全边界。
   *
   * 用户把会话归到了 A 工程下（侧边栏的工程分组），这一轮的引擎工具就是按 A
   * 注册的。此时切到 B 等于绕开「项目对项目」，让模型在一条挂在 A 下面的会话里
   * 动 B 的资产 —— 静默改错工程，比报一个错糟糕得多。
   */
  it('会话被钉在别的工程上时不切，并说明钉的是哪个', () => {
    projects.push({ connectionId: 'conn-a', projectPath: 'I:/Dev/A', isConnected: true })
    projects.push({ connectionId: 'conn-b', projectPath: 'I:/Dev/B', isConnected: true })

    withBinding(
      { projectName: 'A', projectPath: 'I:/Dev/A' },
      { connectionId: 'conn-a', projectPath: 'I:/Dev/A' },
      () => {
        expect(retargetToProject('I:/Dev/B')).toEqual({
          ok: false,
          reason: 'session-scoped',
          sessionProjectPath: 'I:/Dev/A'
        })
        expect(getTargetConnectionId()).toBe('conn-a')
      }
    )
  })

  /**
   * 归属工程没开着的会话：`projectPath`（此刻连着谁）是空的，可它照样是钉住的。
   *
   * 只看 `projectPath` 的话这种会话看起来像「没钉住」，模型开个别的工程就溜进去了。
   * 所以比对必须拿 `sessionProjectPath`。
   */
  it('归属工程没连着时仍然算钉住，不许溜进别的工程', () => {
    projects.push({ connectionId: 'conn-b', projectPath: 'I:/Dev/B', isConnected: true })

    withBinding({ projectName: 'A', projectPath: 'I:/Dev/A' }, {}, () => {
      expect(retargetToProject('I:/Dev/B')).toMatchObject({
        ok: false,
        reason: 'session-scoped'
      })
    })
  })

  /*
   * 嵌套的执行流会继承外层的会话。
   *
   * 导入之后放场景那段自己开了一层（`projectTool.ts` 的 `placeImportedAssetsInScene`），
   * 它换的是「这一段发给哪个连接」，从来不是「这条对话属于谁」。而归属全靠
   * `sessionId` 去表里查，漏传就等于「这条流没有归属」，跨工程那道闸对整段
   * 静默失效 —— 不报错，只是模型能在钉住 A 的会话里往 B 写东西。
   */
  it('嵌套执行流不给 sessionId 时继承外层的，闸门不会掉', () => {
    projects.push({ connectionId: 'conn-b', projectPath: 'I:/Dev/B', isConnected: true })

    withBinding({ projectName: 'A', projectPath: 'I:/Dev/A' }, { connectionId: 'conn-a' }, () => {
      expect(isOutOfSessionScope('I:/Dev/B')).toBe(true)

      // 只给连接和路径，不给 sessionId —— 出问题的那种写法
      runWithTargetConnectionId({ connectionId: 'conn-b', projectPath: 'I:/Dev/B' }, () => {
        expect(isOutOfSessionScope('I:/Dev/B')).toBe(true)
        expect(retargetToProject('I:/Dev/B')).toMatchObject({ reason: 'session-scoped' })
      })
    })
  })

  // 反过来：外层压根没有会话（外部 MCP 调用、HTTP 接口、无头跑）时继承出来还是空的，
  // 闸门不对它们生效 —— 那些路径本来就没有「这条对话」可言
  it('外层没有会话时，嵌套流照样没有归属', () => {
    projects.push({ connectionId: 'conn-b', projectPath: 'I:/Dev/B', isConnected: true })

    runWithTargetConnectionId({ connectionId: 'conn-b' }, () => {
      expect(isOutOfSessionScope('I:/Dev/B')).toBe(false)
    })
  })

  /*
   * 路径都说不出来（戳上只有名字 —— 侧边栏「在这个工程下新建会话」盖的就是这种）
   * 时照切，和 `isOutOfSessionScope()` 同一个方向：证不明越界就别挡。
   *
   * 这里一度是反的。两道闸方向相反的代价是实打实的死路：`open_project` 每次
   * 都被 `session-scoped` 挡下，而错误信息里的工程名是空的，模型连「你这条对话
   * 属于谁」都转告不了用户；与此同时真正写东西的那道闸对同一个状态是放行的 ——
   * 挡住的只有正当操作，该挡的一个没挡住。
   */
  it('钉住了但连路径都不知道时照切 —— 和写入那道闸同方向', () => {
    projects.push({ connectionId: 'conn-b', projectPath: 'I:/Dev/B', isConnected: true })

    withBinding({ projectName: 'A' }, {}, () => {
      expect(retargetToProject('I:/Dev/B')).toMatchObject({ ok: true, connectionId: 'conn-b' })
      // 同一个状态下写入那道闸也是放行的，两边必须一致
      expect(isOutOfSessionScope('I:/Dev/B')).toBe(false)
    })
  })

  // 用户打开的就是会话归属的那个工程（崩了之后重开）—— 这不是越界，照切
  it('打开的正是会话归属的工程时照切', () => {
    projects.push({ connectionId: 'conn-a2', projectPath: 'I:/Dev/A', isConnected: true })

    withBinding({ projectName: 'A', projectPath: 'i:\\dev\\a' }, {}, () => {
      expect(retargetToProject('I:/Dev/A')).toEqual({
        ok: true,
        connectionId: 'conn-a2',
        changed: true
      })
    })
  })

  it('工程还没连上时报 not-connected，等的人自己再来一遍', () => {
    runWithTargetConnectionId({}, () => {
      expect(retargetToProject('I:/Dev/New')).toEqual({ ok: false, reason: 'not-connected' })
    })
  })

  // 无头跑、外部 MCP 调用这些路径本来就没有「这一轮的目标」可切
  it('不在执行流上下文里时报 no-context，而不是去改一个不存在的目标', () => {
    projects.push({ connectionId: 'conn-new', projectPath: 'I:/Dev/New', isConnected: true })
    expect(retargetToProject('I:/Dev/New')).toEqual({ ok: false, reason: 'no-context' })
  })

  // 无头跑批（commandlet）不是用户能看能点的编辑器，不该被当成切换目标
  it('只认交互式编辑器，不认无头进程', () => {
    projects.push({
      connectionId: 'conn-headless',
      projectPath: 'I:/Dev/New',
      isConnected: true,
      interactive: false
    })

    runWithTargetConnectionId({}, () => {
      expect(retargetToProject('I:/Dev/New')).toEqual({ ok: false, reason: 'not-connected' })
    })
  })
})

/**
 * 改归属这条路。
 *
 * 归属现在只有一个主人（`core/sessionBinding.ts`），执行流靠 `sessionId` 去查。
 * 这里验的是查得对不对，以及那道「一条挂在 A 下面的对话不许写 B」的闸。
 */
describe('会话归属', () => {
  it('绑上之后能说出归属的是哪个工程', () => {
    withBinding({ projectName: 'Pond', projectPath: 'I:/Dev/Pond' }, {}, () => {
      expect(getSessionProjectPath()).toBe('I:/Dev/Pond')
    })
  })

  /**
   * **改归属不许动 `connectionId`。**
   *
   * 一度试过「换工程就把旧连接清空」，结果多出两个洞：解除归属会把一条好好的
   * 连接也扔掉（这一轮剩下的命令全落空），而「同一个工程但插件没报路径」
   * 会被当成换了工程。越界该挡在真正越界的那条路上，不在这里。
   */
  it('改归属不动这一轮的目标连接', () => {
    projects.push({ connectionId: 'conn-a', projectPath: 'I:/Dev/A', isConnected: true })

    withBinding(
      { projectName: 'A', projectPath: 'I:/Dev/A' },
      { connectionId: 'conn-a', projectPath: 'I:/Dev/A' },
      () => {
        setSessionBinding('s-test', { projectName: 'B', projectPath: 'I:/Dev/B' })
        expect(getTargetConnectionId()).toBe('conn-a')

        setSessionBinding('s-test', null)
        expect(getTargetConnectionId()).toBe('conn-a')
      }
    )
  })

  /**
   * 归属**不在**执行流上，所以它跨轮活着。
   *
   * 这条是整次重构的落点：以前归属是随每条消息传下来的，模型改完之后
   * 下一条消息的旧戳又把它盖回去。现在表说了算，渲染层那份只在表还空着时
   * 用来初始化。
   */
  it('表里有记录时，渲染层带下来的旧戳盖不掉它', () => {
    setSessionBinding('s-live', { projectName: 'New', projectPath: 'I:/Dev/New' })

    expect(
      adoptSessionBinding('s-live', { projectName: 'Old', projectPath: 'I:/Dev/Old' })
    ).toEqual({ projectName: 'New', projectPath: 'I:/Dev/New' })
  })

  // 明确解除过（`null`）和从没定过（`undefined`）必须分得开：
  // 混在一起的话，解除之后下一条消息带上来的旧戳会把归属原样复活
  it('明确解除过之后，旧戳同样盖不回来', () => {
    setSessionBinding('s-cleared', null)

    expect(
      adoptSessionBinding('s-cleared', { projectName: 'Old', projectPath: 'I:/Dev/Old' })
    ).toBeNull()
  })

  it('表里空着时才用给进来的那份初始化，执行记录优先于渲染层', () => {
    expect(
      adoptSessionBinding(
        's-new',
        { projectName: 'FromRenderer', projectPath: 'I:/R' },
        { projectName: 'FromRecord', projectPath: 'I:/D' }
      )
    ).toEqual({ projectName: 'FromRecord', projectPath: 'I:/D' })
  })

  // 解除之后这条会话就是纯对话，`getSessionProjectPath()` 说不出工程来
  it('解除归属之后不再钉住任何工程', () => {
    withBinding(null, {}, () => {
      expect(getSessionProjectPath()).toBeUndefined()
      expect(isOutOfSessionScope('I:/Dev/B')).toBe(false)
    })
  })
})

/**
 * 越界判断。
 *
 * `project_manage` 的导入动作按**参数**点名工程，还会自己开一个嵌套的执行流
 * 上下文，所以它够不着「归属工程没连上就不给 ue.* 工具」那道过滤 ——
 * 一条挂在 A 下面的对话曾经可以把资产拷进 B、把 Actor 生成到 B 的关卡里。
 */
describe('isOutOfSessionScope', () => {
  it('钉住 A 时，往 B 写算越界', () => {
    withBinding({ projectName: 'A', projectPath: 'I:/Dev/A' }, {}, () => {
      expect(isOutOfSessionScope('I:/Dev/B')).toBe(true)
    })
  })

  // 同一个工程的两种写法不算越界 —— 库里存 .uproject、插件报目录是常态
  it('同一个工程的不同写法不算越界', () => {
    withBinding({ projectName: 'A', projectPath: 'I:/Dev/A' }, {}, () => {
      expect(isOutOfSessionScope('i:\\dev\\a\\A.uproject')).toBe(false)
    })
  })

  it('纯对话（没钉住）怎么写都不算越界', () => {
    runWithTargetConnectionId({}, () => {
      expect(isOutOfSessionScope('I:/Dev/B')).toBe(false)
    })
  })

  // 说不出归属路径就别拦：证不明越界不该挡住用户正常的活
  it('钉住了但说不出路径时不拦', () => {
    withBinding({ projectName: 'A' }, {}, () => {
      expect(isOutOfSessionScope('I:/Dev/B')).toBe(false)
    })
  })
})
