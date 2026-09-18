/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 已连接工程表。每条用例自己往里塞 */
const projects: Array<{
  connectionId: string
  projectPath: string
  isConnected: boolean
  interactive?: boolean
}> = []

let listThrows = false

vi.mock('../../../services/project/projectManager', () => ({
  projectManager: {
    getInteractiveProjects: () => {
      if (listThrows) throw new Error('工程服务还没起来')
      return projects.filter((p) => p.isConnected && p.interactive !== false)
    }
  }
}))

import {
  CLI_CONTRACT_VERSION,
  ExternalTargetError,
  normalizeProjectPath,
  resolveExternalTarget,
  UNREAL_BOX_CAPABILITY
} from './externalTarget'

beforeEach(() => {
  projects.length = 0
  listThrows = false
})

function connect(
  connectionId: string,
  projectPath: string,
  extra: { interactive?: boolean } = {}
): void {
  projects.push({ connectionId, projectPath, isConnected: true, ...extra })
}

/**
 * 这个模块决定「外部客户端这一次的命令发给哪个 UE 工程」。
 *
 * 判错的后果是静默的：命令跑成功了，只是改到了用户另一个工程的关卡里。
 * 所以这里的每一条边界都要有测试，尤其是那几条**宁可报错也不猜**的。
 */
describe('resolveExternalTarget', () => {
  it('没给元数据就不绑定 —— 旧客户端行为一个字不变', () => {
    expect(resolveExternalTarget(undefined)).toBeUndefined()
    expect(resolveExternalTarget(null)).toBeUndefined()
    expect(resolveExternalTarget({})).toBeUndefined()
  })

  it('只给了契约版本、没给工程路径，同样不绑定', () => {
    expect(resolveExternalTarget({ cliContractVersion: CLI_CONTRACT_VERSION })).toBeUndefined()
  })

  it('工程在线时解析出它的 connectionId，并把路径一起带上', () => {
    connect('conn-a', 'D:/Games/Demo')

    const target = resolveExternalTarget({
      cliContractVersion: CLI_CONTRACT_VERSION,
      projectPath: 'D:/Games/Demo'
    })

    // 路径必须一起带走：编辑器中途重启时 `getTargetConnectionId()` 靠它认回新连接
    expect(target).toEqual({ connectionId: 'conn-a', projectPath: 'D:/Games/Demo' })
  })

  /**
   * 这是整个模块最重要的一条。
   *
   * 显式点名的工程没连上时，绝不能因为「反正只有一个连着的」就改发给它 ——
   * 那正是用户看到「命令成功了，但我的场景没变」的那一幕。
   */
  it('点名的工程不在线时报 PROJECT_NOT_CONNECTED，不回退到另一个在线工程', () => {
    connect('conn-other', 'D:/Games/Other')

    try {
      resolveExternalTarget({ projectPath: 'D:/Games/Demo' })
      expect.unreachable('应该抛出')
    } catch (error) {
      expect(error).toBeInstanceOf(ExternalTargetError)
      expect((error as ExternalTargetError).code).toBe('PROJECT_NOT_CONNECTED')
      // 报错里不能出现那个无关工程的 id
      expect((error as ExternalTargetError).message).not.toContain('conn-other')
    }
  })

  it('同一路径匹配到多条连接时报 PROJECT_AMBIGUOUS，不取最近那条', () => {
    connect('conn-1', 'D:/Games/Demo')
    connect('conn-2', 'D:/Games/Demo')

    expect(() => resolveExternalTarget({ projectPath: 'D:/Games/Demo' })).toThrow(
      /PROJECT_AMBIGUOUS|匹配到 2 条/
    )
    try {
      resolveExternalTarget({ projectPath: 'D:/Games/Demo' })
    } catch (error) {
      expect((error as ExternalTargetError).code).toBe('PROJECT_AMBIGUOUS')
    }
  })

  /**
   * commandlet / `-unattended` 跑起来的进程也会连上来（见 `services/project/types.ts`）。
   * 那是我们自己跑的批处理，不是用户面前那个编辑器，不能当成目标。
   */
  it('非交互式连接不算数', () => {
    connect('conn-headless', 'D:/Games/Demo', { interactive: false })

    expect(() => resolveExternalTarget({ projectPath: 'D:/Games/Demo' })).toThrow(/没有连接/)
  })

  it('斜杠方向和结尾斜杠不影响匹配', () => {
    connect('conn-a', 'D:/Games/Demo')

    expect(resolveExternalTarget({ projectPath: 'D:\\Games\\Demo\\' })?.connectionId).toBe('conn-a')
  })

  /**
   * 协议说好了传工程根目录，但第三方客户端很容易把用户手上那个 `.uproject`
   * 原样发过来。砍掉文件名不可能砍错，而报一个「找不到工程」让人自己去查
   * 差在哪，没有任何价值。
   */
  it('传 .uproject 文件路径也认，自动落到它所在的目录', () => {
    connect('conn-a', 'D:/Games/Demo')

    expect(
      resolveExternalTarget({ projectPath: 'D:/Games/Demo/Demo.uproject' })?.connectionId
    ).toBe('conn-a')
  })

  /** `D:/Games/Demo` 不能匹配上 `D:/Games/Demo2`，更不能匹配上 `D:/Games` */
  it('不做前缀匹配', () => {
    connect('conn-demo2', 'D:/Games/Demo2')

    expect(() => resolveExternalTarget({ projectPath: 'D:/Games/Demo' })).toThrow(/没有连接/)
    expect(() => resolveExternalTarget({ projectPath: 'D:/Games' })).toThrow(/没有连接/)
  })

  it('契约版本对不上时报 INVALID_ARGUMENT，并说清楚本服务是几版', () => {
    try {
      resolveExternalTarget({ cliContractVersion: 99, projectPath: 'D:/Games/Demo' })
      expect.unreachable('应该抛出')
    } catch (error) {
      expect((error as ExternalTargetError).code).toBe('INVALID_ARGUMENT')
      expect((error as ExternalTargetError).message).toContain(String(CLI_CONTRACT_VERSION))
    }
  })

  it('元数据不是对象、路径不是字符串都被挡下', () => {
    expect(() => resolveExternalTarget('D:/Games/Demo')).toThrow(/必须是一个对象/)
    expect(() => resolveExternalTarget([1, 2])).toThrow(/必须是一个对象/)
    expect(() => resolveExternalTarget({ projectPath: 42 })).toThrow(/非空字符串/)
    expect(() => resolveExternalTarget({ projectPath: '   ' })).toThrow(/非空字符串/)
  })

  /**
   * 说不清楚的时候要说说不清楚。
   *
   * 把「查不了」报成「工程没连」会把用户支去检查一个其实是好的编辑器。
   */
  it('工程服务查不了时报出真实原因，不谎称工程没连', () => {
    listThrows = true

    try {
      resolveExternalTarget({ projectPath: 'D:/Games/Demo' })
      expect.unreachable('应该抛出')
    } catch (error) {
      expect((error as ExternalTargetError).message).toContain('工程服务还没起来')
    }
  })
})

describe('normalizeProjectPath', () => {
  it('抹平斜杠方向与结尾斜杠', () => {
    expect(normalizeProjectPath('D:\\Games\\Demo\\')).toBe(normalizeProjectPath('D:/Games/Demo'))
  })

  /**
   * Windows 文件系统不区分大小写，转小写是对的。
   * 而 Linux/macOS 上 `Demo` 和 `demo` 是两个真实存在的不同目录 ——
   * 无条件转小写会让它们被认成同一个，那就是静默发错工程。
   */
  it('大小写按平台处理', () => {
    const same = normalizeProjectPath('D:/Games/DEMO') === normalizeProjectPath('D:/Games/demo')
    expect(same).toBe(process.platform === 'win32')
  })
})

describe('契约声明', () => {
  it('三个字段齐全，版本与常量一致', () => {
    expect(UNREAL_BOX_CAPABILITY).toEqual({
      cliContractVersion: CLI_CONTRACT_VERSION,
      projectTargeting: true,
      publicResults: true
    })
  })
})
