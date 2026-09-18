/**
 * V3 工具树在测试里的打桩工厂。
 *
 * `registry.ts` 会 eager import 全部工具模块，这些模块在**加载时**就有副作用：
 * electron 是 CJS，vitest 的 ESM 环境取不到具名导出；`services` 一路拖到
 * `better-sqlite3` 的原生绑定（AGENTS.md §7 的那个 segfault）。
 *
 * 所以任何 import 到 registry 的测试都要打这几个桩。工厂集中在这里，
 * 测试文件只写 `vi.mock(路径, 工厂)` 一行 —— 知识不用抄第二遍。
 *
 * 这里**没有 sentryMock**。社区版一行遥测都不带，`@sentry/electron` 连依赖都不在
 * `package.json` 里；给一个不存在的模块打桩只会让人以为它还在用。
 *
 * 用法（`vi.mock` 会被提升，所以必须写在测试文件自己里，不能在这里代劳）：
 *
 * ```ts
 * import { electronMock, servicesMock, targetContextMock } from '../testSupport/toolMocks'
 *
 * vi.mock('electron', electronMock)
 * vi.mock('../../services', servicesMock)
 * vi.mock('../../agent-v3/core/projectTargetContext', targetContextMock)
 * ```
 */

export const electronMock = (): Record<string, unknown> => ({
  // `getAppPath` 不是可有可无的：`skillDirectories()` 靠它拼内置 skill 目录
  // （capabilities/skills.ts）。缺了它 `discoverEnabledSkills()` 会抛，而调用处
  // 是 catch 住按「没有 skill」继续的 —— 于是测试里 skill 清单**静默为空**，
  // 任何量「一轮请求到底有多大」的测试都会偏小。指向仓库根，和开发态一致。
  app: {
    getPath: (): string => '/tmp',
    getAppPath: (): string => process.cwd(),
    getVersion: (): string => '0.0.0',
    isPackaged: false
  },
  BrowserWindow: Object.assign(class {}, { getAllWindows: (): unknown[] => [] }),
  ipcMain: { handle: (): void => undefined, on: (): void => undefined },
  shell: { openPath: async (): Promise<string> => '' },
  // Agent 浏览器只在真正 open 时才碰 session；给个空壳是为了让
  // `import { session } from 'electron'` 这行不炸
  session: { fromPartition: (): unknown => ({}) }
})

export const servicesMock = (): Record<string, unknown> => ({
  serviceManager: {
    getWebSocketService: () => ({
      callRequest: async (): Promise<unknown> => ({ ok: true }),
      getConnectionCount: (): number => 1
    })
  },
  config: {
    baseUrl: '',
    token: '',
    get: (): undefined => undefined
  }
})

/**
 * `core/projectTargetContext` 的替身。
 *
 * 整体语义是「不在执行流上下文里」——和真实实现在无头跑、外部 MCP 调用下的
 * 行为一致。
 *
 * ## 为什么要 `importOriginal`
 *
 * `vi.mock` 是**整模块替换**：漏掉一个导出，引用它的模块拿到的就是 undefined，
 * 而报错指向调用点而不是这里，排查要绕一大圈。手写清单挡不住这件事 ——
 * 它已经落后过一次（模块加到 8 个导出，清单还停在 5 个）。
 *
 * 所以先把原模块整个摊进来，再只覆盖**需要变成「没有上下文」**的那几个。
 * 新增导出自动带上，纯函数（`normalizeProjectPath` 这种）保持真实行为，
 * 清单永远追得上。
 *
 * 代价说清楚：`importOriginal()` 会真的加载 `projectTargetContext`，它 import
 * `services/project/projectManager` —— 那是个模块级单例，还顺着 `logger` 拉起
 * `electron-log`。所以装了这个桩的用例会比以前多背一小段 import 链
 * （`graphPins.test.ts` 是唯一一个以前完全不碰 `services/project` 的）。
 * 目前它们都已经打了 `electron` 的桩，跑得起来；哪天这条链上出现新的模块级
 * 副作用，报错会指向一个和被测代码毫无关系的地方 —— 那时把纯函数拆进
 * `core/projectPathKey.ts` 那样的零依赖模块，比回去手抄清单强。
 */
export const targetContextMock = async (
  importOriginal: <T>() => Promise<T>
): Promise<Record<string, unknown>> => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTargetConnectionId: (): undefined => undefined,
  getTargetProjectPath: (): undefined => undefined,
  runWithTargetConnectionId: <T>(_id: string | undefined, fn: () => T): T => fn(),
  setTargetConnectionId: (): boolean => false,
  retargetToProject: (): { ok: false; reason: 'no-context' } => ({
    ok: false,
    reason: 'no-context'
  })
})
