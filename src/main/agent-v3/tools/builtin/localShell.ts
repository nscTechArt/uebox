/**
 * 本地写文件、改文件、跑命令。
 *
 * ## 为什么之前没接
 *
 * 我先前判断「用户是虚幻美术，用不上写代码和跑命令」—— 这个前提是错的。
 * 虚幻盒子的用户是**所有虚幻引擎用户**，包括引擎和游戏开发者：他们的机器上
 * 有 Visual Studio、有 Git、每天都在改 C++ 和 Build.cs。按错的用户画像
 * 砍掉的能力，正好是这部分人最需要的。
 *
 * ## 但不能假设人人都有
 *
 * 纯蓝图工程不需要 Visual Studio，也不一定装 Git。所以：
 *
 *   - **写 / 改文件**：无条件提供，只依赖文件系统。
 *   - **跑命令**：只在真的找得到 shell 时才注册。沿用 `ue.*` 那套做法 ——
 *     没连引擎就不给引擎工具，没有 shell 就不给 shell 工具。让模型看见
 *     一个必定失败的工具，它会反复去试，然后拿一串看不懂的报错糊到用户脸上。
 *
 * ## 风险等级
 *
 * 三个都标 `destructive`（每次都问）。理由是它们动的是**用户自己的硬盘**，
 * 不是虚幻工程里可以重新生成的资产。`auto-edit` 是我们的默认模式，
 * 在那个模式下 `mutating` 会静默放行 —— 静默改源码这件事，第一版不做。
 * 想要无人值守的用户可以自己切到全放行。
 */

import { createEditTool, createWriteTool, createBashTool } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { app } from 'electron'

import type { UnrealAgentTool } from '../defineTool'
import { assertInAccessScope } from './accessScope'
import { getExecutionEnv } from './localFiles'
import { captureFile, withFileChangeLock } from './fileChangeCapture'
import { assertCommandAllowed, assertPathAllowed } from './pathBoundary'
import { assertNotCopyingEngineTemplate, assertNotWritingUproject } from './projectCreationGuard'

/**
 * 把 pi 的 harness 工具包成我们的工具。
 *
 * pi 的 `execute` 比我们的多收一个 context 参数，绑上 `{ env }` 即可；
 * 另外它没有 `unrealBox` 元数据，必须补 —— `resolveTools` 靠它过滤、
 * 审批门靠它判 risk，缺了会在**造 agent 的时候**就抛。
 */
interface HarnessToolLike {
  execute: (...args: unknown[]) => unknown
}

/**
 * `guard` 收整个 params 而不是一个 `guardPath: boolean`。
 *
 * 原先是布尔的，写命令工具时因为「命令没有 path 参数，路径检查无从谈起」
 * 就填了 `false` —— 于是 `cat ~/.ssh/id_rsa` 从写文件那边锁着的门旁边
 * 大摇大摆走了过去。参数形状不一样，不等于这道边界不该管它。
 *
 * 允许返回 Promise：用户设的访问范围（`accessScope.ts`）要查工程清单和引擎
 * 清单才判得出来。反正 `execute` 本来就是 async，等一下不多花什么。
 */
function wrap(
  inner: HarnessToolLike,
  meta: {
    name: string
    description: string
    namespace: string
    guard: (params: Record<string, unknown>) => Promise<string | undefined> | string | undefined
    /**
     * 写成功之后追加给模型看的一段话。返回空串就什么都不加。
     *
     * 用来挂写完即查的体检（见 `capabilities/skillLint.ts`）—— 挂在**返回值**
     * 里而不是另做一个工具，是因为另做工具就要靠模型记得调，而它最该调的
     * 那一次恰恰是它以为已经写完的那一次。
     */
    afterWrite?: (params: Record<string, unknown>) => Promise<string>
  }
): UnrealAgentTool<never> {
  return {
    ...inner,
    unrealBox: { namespace: meta.namespace, risk: 'destructive' },
    name: meta.name,
    description: meta.description,
    execute: async (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown) => {
      const denied = await meta.guard((params ?? {}) as Record<string, unknown>)
      if (denied) return { content: [{ type: 'text', text: denied }], isError: true }

      const target = (params as { path?: string })?.path
      // Match pi's resolveToolPath normalization before capturing either snapshot.
      const resolved =
        meta.namespace === 'local' && typeof target === 'string'
          ? await getExecutionEnv().absolutePath(
              target.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '')
            )
          : undefined
      const filePath = resolved?.ok ? resolved.value : undefined
      return withFileChangeLock(filePath, async () => {
        const before = filePath ? await captureFile(filePath) : undefined
        const result = (await inner.execute(toolCallId, params, signal, onUpdate, {
          env: getExecutionEnv()
        })) as {
          content?: Array<{ type: string; text?: string }>
          isError?: boolean
          details?: Record<string, unknown>
        }

        if (filePath && !result?.isError) {
          const after = await captureFile(filePath)
          result.details = {
            ...result.details,
            message: result.content
              ?.filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n'),
            ...(before && after && !after.missing
              ? {
                  fileChange: {
                    path: filePath,
                    before: before.text,
                    after: after.text,
                    created: before.missing
                  }
                }
              : { fileChangeUnavailable: filePath })
          }
        }

        // 写失败时不体检 —— 那会在一条真实的报错后面再糊一句「读不回来」，
        // 把模型的注意力从真正的原因上引开
        if (!meta.afterWrite || result?.isError) return result

        // 体检自己出问题不该让一次成功的写入变成失败
        const note = await meta
          .afterWrite((params ?? {}) as Record<string, unknown>)
          .catch(() => '')
        if (!note) return result

        return { ...result, content: [...(result.content ?? []), { type: 'text', text: note }] }
      })
    }
  } as unknown as UnrealAgentTool<never>
}

/** 改文件：看 `path`。敏感位置（永远挡）+ 用户设的访问范围 */
const guardPath = async (params: Record<string, unknown>): Promise<string | undefined> => {
  const target = typeof params.path === 'string' ? params.path : ''
  return assertPathAllowed(target) ?? (await assertInAccessScope(target))
}

/**
 * 写文件：敏感位置 + 访问范围 + 「别自己写 .uproject 建工程」。
 *
 * 只有 write 加最后这一条，edit 不加 —— 改一个已有工程的 .uproject（启用插件、
 * 改引擎版本）是正当需求，而那只可能用 edit 做。见 `projectCreationGuard.ts`。
 */
const guardWritePath = async (params: Record<string, unknown>): Promise<string | undefined> => {
  const target = typeof params.path === 'string' ? params.path : ''
  return (
    assertPathAllowed(target) ??
    assertNotWritingUproject(target) ??
    (await assertInAccessScope(target))
  )
}

/**
 * 跑命令：敏感位置 + 「别自己拷引擎模板建工程」。挡得住什么见两个模块各自的头部。
 *
 * **访问范围这一层不管命令。** 一条命令里可以出现任意多个路径，还能拼接、
 * 能编码，在字符串里做白名单只会得到一个到处漏的假边界 —— 而假边界比没有
 * 边界更糟，用户会以为自己收紧了。这条限制写在 `accessScope.ts` 头部，
 * 也写进了「仅虚幻相关」那一档的界面说明里。命令这条路兜底的是审批门。
 */
const guardCommand = (params: Record<string, unknown>): string | undefined => {
  const command = typeof params.command === 'string' ? params.command : ''
  return assertCommandAllowed(command) ?? assertNotCopyingEngineTemplate(command)
}

export interface LocalWriteOptions {
  /**
   * 写成功后追加给模型看的一段话（体检报告）。
   *
   * 由调用方注入而不是这里直接引 `skillLint` —— 体检要问工具注册表有哪些
   * 工具名，而注册表要 import 这个模块，直接引会成环。注册表在
   * `registry.ts` 里把两头接起来。
   */
  afterWrite?: (params: Record<string, unknown>) => Promise<string>
}

/** 写文件与改文件。不依赖 shell，无条件提供 */
export function createLocalWriteTools(options: LocalWriteOptions = {}): UnrealAgentTool<never>[] {
  const afterWrite = options.afterWrite ? { afterWrite: options.afterWrite } : {}

  return [
    wrap(createWriteTool() as unknown as HarnessToolLike, {
      name: 'write_local_file',
      namespace: 'local',
      guard: guardWritePath,
      ...afterWrite,
      description:
        '在用户电脑上创建一个新文件，或**整个覆盖**一个已有文件。\n\n' +
        '【什么时候用】新建脚本、生成清单/报告、创建配置文件。\n' +
        '【建 UE 工程不用这个】新建虚幻工程一律走 project_manage 的 create_project，' +
        '不要自己写 .uproject、也不要拷引擎的 Templates 目录 —— ' +
        '那样建出来的工程不会进用户的「我的项目」，用户在盒子里看不到它。\n' +
        '【什么时候不用】只改文件里的几行 —— 那要用 edit_local_file。' +
        '用 write 会把这个文件的其余内容**全部丢掉**，包括你没读过的部分。\n' +
        '【动手之前】覆盖已有文件前先 read_local_file 看一眼，' +
        '确认你要覆盖的确实是你以为的那个文件。'
    }),
    wrap(createEditTool() as unknown as HarnessToolLike, {
      name: 'edit_local_file',
      namespace: 'local',
      guard: guardPath,
      ...afterWrite,
      description:
        '精确修改用户电脑上的一个文件：把 oldText 换成 newText，可一次改多处。\n\n' +
        '【匹配规则】oldText 必须与文件里的内容**逐字符一致**（含缩进和换行），' +
        '匹配不到就整次失败，不会改半截。\n' +
        '【多处修改】一次调用传多个 edits，不要拆成多次调用。' +
        '每个 oldText 都是对着**原始文件**匹配的，不是前一次修改后的结果 —— ' +
        '所以不要写互相重叠或嵌套的修改。\n' +
        '【oldText 要短】只取足以在文件里唯一定位的那一小段，' +
        '不要为了保险把大段没改动的内容也贴进来。'
    })
  ]
}

/** 探测结果只算一次。`where bash.exe` 要起子进程，每次造 agent 都跑一遍不值当 */
let shellProbe: Promise<boolean> | undefined

/**
 * 这台机器上有没有可用的 shell。
 *
 * pi 在 Windows 上找 `Program Files\Git\bin\bash.exe` 或 PATH 上的 bash.exe
 * （明确排除 `System32\bash.exe` 那个 WSL 入口）。装了 Git for Windows 就有，
 * 引擎开发者机器上通常都有，纯蓝图工程的用户则未必。
 */
export function isShellAvailable(): Promise<boolean> {
  if (!shellProbe) {
    shellProbe = (async () => {
      try {
        const env = new NodeExecutionEnv({ cwd: app.getPath('home') })
        const result = await env.exec('echo ua-probe', { timeout: 10 })
        return result.ok === true
      } catch {
        return false
      }
    })()
  }
  return shellProbe
}

/** 仅供测试重置探测缓存 */
export function __resetShellProbe(): void {
  shellProbe = undefined
}

/**
 * 跑 shell 命令。
 *
 * 命名空间单独用 `local.shell`，`resolveTools` 据此在没有 shell 的机器上
 * 整个不注册。
 */
export function createShellTool(): UnrealAgentTool<never> {
  return wrap(createBashTool() as unknown as HarnessToolLike, {
    name: 'run_shell_command',
    namespace: 'local.shell',
    guard: guardCommand,
    description:
      '在用户电脑上执行一条 shell 命令（bash 语法）。\n\n' +
      '【什么时候用】git 操作、跑构建或测试、批量文件处理 —— ' +
      '那些没有专用工具、又确实需要命令行的事。\n' +
      '【先用专用工具】列目录用 list_local_dir，找文件用 find_local_files，' +
      '搜内容用 grep_local_files，读文件用 read_local_file。' +
      '它们更快、输出更整齐，而且在没有 shell 的机器上也能用。\n' +
      '【建工程不用这个】新建虚幻工程一律走 project_manage 的 create_project，' +
      '不要自己拷引擎的 Templates 目录 —— 拷出来的工程不会进用户的「我的项目」，' +
      '依赖共享内容包的模板还会一打开就是丢失引用。这条是硬拦的。\n' +
      '【编译 UE 工程不用这个】改完 C++ 用 cpp_compile —— 它编进正在跑的编辑器，' +
      '**不需要用户关编辑器**，编不过还能给出带文件名和行号的报错。\n' +
      '【真要用命令行编的时候】只有改了 .Build.cs 依赖、加了新模块、改了 .uproject 时才需要，' +
      '那种改动必须完整重新链接。命令用 UnrealBuildTool（' +
      (process.platform === 'darwin'
        ? '<Engine>/Build/BatchFiles/Mac/Build.sh'
        : '<Engine>/Build/BatchFiles/Build.bat') +
      '），' +
      '不要直接调编译器。这时候要先请用户关掉编辑器 —— ' +
      (process.platform === 'darwin'
        ? '编辑器运行时的 Hot Reload 可能产出带后缀的动态库，不是干净重编。'
        : 'Live Coding 开着时 UBT 会直接拒绝执行，关着时它会转而产出带后缀的热重载 DLL，' +
          '两种都不是你要的干净重编。') +
      '**不要自己去杀编辑器进程。**\n' +
      // 2026-09-26 真机反馈：`powershell -Command "… $_.IsReadOnly …"` 连试三次，$_ 每次都被
      // bash 先展开成 `/usr/bin/bash.`，报错也看不出是引号的锅
      (process.platform === 'win32'
        ? '【调 PowerShell】这里是 bash：双引号里的 $_、$env:X 会先被 bash 展开掉。' +
          "把 -Command 后面整段用单引号包起来（-Command '…'），长的写成 .ps1 再用 -File 执行。\n"
        : '') +
      '【输出】过长会截断。命令失败时把 stderr 原文读清楚再决定下一步。'
  })
}
