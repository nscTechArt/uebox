/**
 * `cpp_full_rebuild` —— 关编辑器、完整编译、再把工程打开。
 *
 * ## 它替掉的是哪句话
 *
 * C++ 工作流里有几种改动，正在跑的编辑器补不上，只能关掉编辑器完整编一次：
 *
 *   - 纯蓝图工程的第一个类（新模块，编辑器当场加载不了）；
 *   - Live Coding 路上改了 .Build.cs / .uproject（补丁式热更链不进新依赖）；
 *   - 模块里原来一个 UObject 都没有，热重载没有可绑定的包，引擎直接拒绝。
 *
 * 以前这几处的标准答案是「请用户关掉编辑器，在 IDE 里编一次 / 跑这条 Build.bat 命令」——
 * 把一串只有我们知道的步骤（哪个引擎、哪个 Target、什么参数）甩给用户。
 * 这些信息盒子全都有，所以由盒子来做，用户只需要在审批框里点一次同意。
 *
 * ## 四步，每一步都可能停下来，停下来就如实说停在哪
 *
 * 1. **关编辑器**：`closeEditorForProject`（和 `project_update_plugin` 共用）——
 *    有未保存的改动先拒绝、把清单交回来，和 `ue_restart_editor` 同一道闸。
 *    插件没连上（编辑器卡死）时只有用户明确同意丢弃改动才结束进程。
 * 2. **编译**：引擎自带的 Build.bat / Build.sh，编 `<工程>Editor` 这个 Target。
 *    编不过就停在这里、编辑器**保持关着** —— 带着编不过的代码打开，引擎会弹
 *    「模块缺失，要重编吗」，用户点了也一样编不过。诊断带文件名和行号回来，改完再调一次。
 * 3. **重开工程**，4. **等插件连回来并切过去**：和 `open_project` 同一套（`awaitProjectLive`）。
 *
 * ## 另一种用法：只编游戏 Target，验证打包时能不能编过
 *
 * 编辑器 Target 带着 `WITH_EDITOR`，Runtime 模块里漏包 `#if WITH_EDITOR` 的编辑器代码、
 * 或者 include 了编辑器模块，开发时全绿，要到用户打包那天才红。专家改完 Runtime 模块
 * 会单独编一次 Game Target（Development）。它的产物和编辑器的 DLL 不在一处，
 * 所以**不用关编辑器**；只编工程自己的模块，几分钟就够，不必完整打包烘焙。
 */

import { spawn } from 'child_process'
import { shell } from 'electron'
import { promises as fs } from 'fs'
import { basename, dirname, join } from 'path'
import { z } from 'zod'

import { getTargetProjectPath } from '../../../core/projectTargetContext'
import { defineTool, type UnrealAgentTool } from '../../defineTool'
import {
  engineRootFor,
  findUproject,
  killTree,
  lowerPriority,
  quoteForCmd
} from '../../builtin/projectPackage'
import { awaitProjectLive } from '../project/awaitProjectLive'
import { closeEditorForProject } from '../project/closeEditor'
import { formatDiagnostic, parseDiagnostics } from './diagnostics'

/** 一次完整编译的上限。冷编一个大工程能到半小时 */
const BUILD_TIMEOUT_MS = 60 * 60_000
/** 编辑器重新打开、插件连回来的上限（同团队快照回滚） */
const REOPEN_WAIT_MS = 8 * 60_000

/**
 * UBT 认为「还有人占着」时的原话。编辑器刚退出时 Live Coding 控制台可能还没走完，
 * 第一次会撞上，等几秒重试就好；不是代码问题，不能报成编译失败。
 */
const TRANSIENT_LOCK =
  /Unable to build while Live Coding is active|conflicting instance of UnrealBuildTool/i
const LOCK_RETRIES = 3
const LOCK_RETRY_DELAY_MS = 5_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── 纯函数（单测覆盖） ────────────────────────────────────────────────────

/**
 * 工程的编辑器 Target 名。读 Source/ 下的 *.Target.cs，认 `TargetType.Editor`。
 * 一般就是 `<工程名>Editor`，但改过名的工程不少，按文件内容认比按名字猜可靠。
 * 有多个时优先 `<工程名>Editor`。没有就是纯蓝图工程（或者源码丢了）。
 */
export function pickEditorTarget(
  projectName: string,
  targets: Array<{ file: string; content: string }>
): string | null {
  const editors = targets
    .filter((t) => /TargetType\s*\.\s*Editor\b/.test(t.content))
    .map((t) => basename(t.file).replace(/\.Target\.cs$/i, ''))
  if (editors.length === 0) return null
  return (
    editors.find((name) => name.toLowerCase() === `${projectName}Editor`.toLowerCase()) ??
    editors[0]
  )
}

/** 工程的游戏 Target 名：认 `TargetType.Game`，有多个时优先和工程同名的。没有返回 null */
export function pickGameTarget(
  projectName: string,
  targets: Array<{ file: string; content: string }>
): string | null {
  const games = targets
    .filter((t) => /TargetType\s*\.\s*Game\b/.test(t.content))
    .map((t) => basename(t.file).replace(/\.Target\.cs$/i, ''))
  if (games.length === 0) return null
  return games.find((name) => name.toLowerCase() === projectName.toLowerCase()) ?? games[0]
}

export function buildScript(engineRoot: string, platform = process.platform): string {
  if (platform === 'win32') return join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat')
  const sub = platform === 'darwin' ? 'Mac' : 'Linux'
  return join(engineRoot, 'Engine', 'Build', 'BatchFiles', sub, 'Build.sh')
}

export function buildArgs(target: string, uproject: string, platform = process.platform): string[] {
  const ubtPlatform = platform === 'win32' ? 'Win64' : platform === 'darwin' ? 'Mac' : 'Linux'
  return [target, ubtPlatform, 'Development', `-Project=${uproject}`, '-WaitMutex', '-utf8output']
}

export interface BuildOutcome {
  exitCode: number | null
  output: string
  minutes: number
  timedOut: boolean
}

export function describeBuild(build: BuildOutcome): { ok: boolean; text: string } {
  const ok = build.exitCode === 0
  if (ok) return { ok, text: `✓ 编译成功（${build.minutes} 分钟）。` }

  const lines = [
    build.timedOut
      ? `✗ 编译 ${Math.round(BUILD_TIMEOUT_MS / 60_000)} 分钟没结束，已经停掉。`
      : `✗ 编译失败（退出码 ${build.exitCode ?? '无'}，${build.minutes} 分钟）。`
  ]
  const diagnostics = parseDiagnostics(build.output)
  const errors = diagnostics.filter((d) => d.severity === 'error')
  if (errors.length > 0) {
    lines.push(...errors.map(formatDiagnostic))
  } else {
    // 解析器认不出（UHT 报错、UBT 自己抛异常）也不能让原因消失
    lines.push(
      '没能解析出结构化的错误，下面是输出的最后几十行原文：',
      build.output.split(/\r?\n/).slice(-40).join('\n').trim() || '(输出是空的)'
    )
  }
  return { ok, text: lines.join('\n') }
}

// ── 副作用 ──────────────────────────────────────────────────────────────

async function readTargets(projectDir: string): Promise<Array<{ file: string; content: string }>> {
  const sourceDir = join(projectDir, 'Source')
  const names = await fs.readdir(sourceDir).catch(() => [] as string[])
  const out: Array<{ file: string; content: string }> = []
  for (const name of names.filter((n) => /\.Target\.cs$/i.test(n))) {
    out.push({
      file: name,
      content: await fs.readFile(join(sourceDir, name), 'utf8').catch(() => '')
    })
  }
  return out
}

async function runBuild(
  script: string,
  args: string[],
  signal: AbortSignal | undefined,
  onLine: (line: string) => void
): Promise<BuildOutcome> {
  const started = Date.now()
  const child =
    process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${[script, ...args].map(quoteForCmd).join(' ')}"`], {
          windowsVerbatimArguments: true,
          windowsHide: true,
          cwd: dirname(script)
        })
      : spawn(script, args, { detached: true, cwd: dirname(script) })
  // 和打包一样降一档：编译是满载的活，用户这时候可能在别的窗口干活
  lowerPriority(child)

  const chunks: string[] = []
  let size = 0
  const onData = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    chunks.push(text)
    size += text.length
    // 只留尾部 512 KB：报错在后面，全留会把一次冷编的几万行进度都攒在内存里
    while (size > 512 * 1024 && chunks.length > 1) size -= chunks.shift()!.length
    for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line)
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)

  let timedOut = false
  const onAbort = (): void => killTree(child)
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, BUILD_TIMEOUT_MS)

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code))
    child.on('error', () => resolve(null))
  }).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  })

  return {
    exitCode,
    output: chunks.join(''),
    minutes: Math.round((Date.now() - started) / 6_000) / 10,
    timedOut
  }
}

/** 装插件那一步按需加载：它的模块一加载就连数据库、读设置（同 teamSnapshots） */
async function ensurePlugin(uproject: string): Promise<void> {
  const { ensureUnrealAgentLinkPlugin } = await import('../../../../sqliteDataBase/ipc/project')
  await ensureUnrealAgentLinkPlugin(uproject)
}

// ── 工具 ────────────────────────────────────────────────────────────────

const InputSchema = z.object({
  project_path: z
    .string()
    .optional()
    .describe('工程目录（含 .uproject 的那一层）。省略 = 这一轮正在干的工程'),
  discard_unsaved: z
    .boolean()
    .optional()
    .describe(
      '编辑器里有未保存的改动时，丢掉它们强行关闭。**只有用户明确说可以丢时才用**，不可撤销。' +
        '正常做法是先 ue_save 再调'
    ),
  reopen_on_failure: z
    .boolean()
    .optional()
    .describe(
      '编译失败时也把编辑器打开（默认不开：带着编不过的代码打开，引擎只会再弹一次「要重编吗」）。' +
        '决定放弃修复、要把编辑器还给用户时才设 true'
    ),
  game_target_only: z
    .boolean()
    .optional()
    .describe(
      '只编独立游戏的 Target（Development），**不关编辑器、不重开**。用来验证打包时能不能编过：' +
        '改过 Runtime 模块、动过 include 或 WITH_EDITOR 相关代码，交付前编一次。几分钟，不烘焙'
    )
})

export interface FullRebuildResult {
  closedEditor: boolean
  built: boolean
  reopened: boolean
  live: boolean
  target: string
  minutes?: number
}

export function createCppFullRebuildTool(): UnrealAgentTool<FullRebuildResult> {
  return defineTool<typeof InputSchema, FullRebuildResult>({
    name: 'cpp_full_rebuild',
    namespace: 'ue.cpp',
    // 声明最坏情况：discard_unsaved 会丢掉未保存的改动
    risk: 'destructive',
    // 不丢改动的那次（有未保存就拒绝并列清单）按 mutating 走：关了还会重开
    riskFor: ({ discard_unsaved, game_target_only }) =>
      discard_unsaved === true && game_target_only !== true ? 'destructive' : 'mutating',
    concurrency: 'sequential',
    input: InputSchema,
    description:
      '关掉虚幻编辑器 → 用引擎的 Build 脚本完整编译工程 → 重新打开工程并等插件连回来。' +
      '整套由盒子完成，**不要把「关编辑器、跑 Build.bat、在 IDE 里编」这些步骤交给用户**。\n\n' +
      '【什么时候用】正在跑的编辑器补不上的改动，cpp_compile 之后：\n' +
      '- cpp_add_class 报「建好了工程主模块」（纯蓝图工程的第一个类）；\n' +
      '- cpp_compile 报编译没有发起，原因是模块里没有可热重载的 UObject；\n' +
      '- Live Coding 路上 cpp_compile 报 needs_full_rebuild（改了 .Build.cs / .uproject）。\n' +
      '普通的改 .cpp/.h 用 cpp_compile，别用这个 —— 它要关编辑器，慢得多。\n' +
      '【先存盘】编辑器里有未保存的改动会被拒绝并列出清单，先 ue_save 再调。\n' +
      '【编不过时编辑器保持关着】返回带文件名行号的报错，改完直接再调一次（会跳过关编辑器那步）。\n' +
      '【返回 live=true 就是已经连回来了】可以直接接着发引擎命令。\n' +
      '【game_target_only=true】只编游戏 Target 验证打包能否编过，不关编辑器（见参数说明）。',
    execute: async (
      { project_path, discard_unsaved, reopen_on_failure, game_target_only },
      ctx
    ) => {
      const projectDir = project_path ?? getTargetProjectPath()
      if (!projectDir) throw new Error('不知道编哪个工程：这一轮没有连着的工程，请给 project_path')
      const uproject = await findUproject(projectDir)
      const projectName = basename(uproject, '.uproject')

      if (game_target_only) {
        const gameTarget = pickGameTarget(projectName, await readTargets(projectDir))
        if (!gameTarget) {
          throw new Error(
            `${projectName} 的 Source/ 下没有游戏 Target（TargetType.Game 的 *.Target.cs），` +
              '没法单独验证打包编译。纯蓝图工程不需要这一步'
          )
        }
        const gameScript = buildScript(await engineRootFor(uproject))
        await fs.access(gameScript).catch(() => {
          throw new Error(`引擎里没有编译脚本 ${gameScript}，这份引擎装得不完整`)
        })
        const gameArgs = buildArgs(gameTarget, uproject)
        if (process.platform === 'win32') [gameScript, ...gameArgs].forEach(quoteForCmd)

        ctx.report({ text: `编译游戏 Target ${gameTarget}（不关编辑器）…` })
        const build = await runBuild(gameScript, gameArgs, ctx.signal, (line) => {
          if (/^\[\d+\/\d+\]/.test(line)) ctx.report({ text: `编译：${line.slice(0, 120)}` })
        })
        ctx.signal?.throwIfAborted()
        const described = describeBuild(build)
        const lines = [described.text]
        if (described.ok) {
          lines.push('游戏 Target 编过了：Runtime 模块没有混进只在编辑器里才有的代码。')
        } else if (TRANSIENT_LOCK.test(build.output)) {
          lines.push(
            '编译被另一个 UnrealBuildTool 或 Live Coding 占着，不是代码问题。' +
              '等编辑器里的编译结束再调一次。'
          )
        } else {
          lines.push(
            '编辑器里编得过、这里编不过，通常是 Runtime 模块用了编辑器专用的代码：' +
              '包进 #if WITH_EDITOR，或者把它挪到 Editor 模块。编辑器没动过，还开着。'
          )
        }
        return {
          text: lines.join('\n'),
          details: {
            closedEditor: false,
            built: described.ok,
            reopened: false,
            live: false,
            target: gameTarget,
            minutes: build.minutes
          }
        }
      }

      const target = pickEditorTarget(projectName, await readTargets(projectDir))
      if (!target) {
        throw new Error(
          `${projectName} 的 Source/ 下没有编辑器 Target（*Editor.Target.cs）。` +
            '纯蓝图工程先用 cpp_add_class 建第一个类（会顺带生成 Target），再调这个工具。'
        )
      }
      const engineRoot = await engineRootFor(uproject)
      const script = buildScript(engineRoot)
      await fs.access(script).catch(() => {
        throw new Error(`引擎里没有编译脚本 ${script}，这份引擎装得不完整`)
      })
      // 参数先拼一遍：带了没法安全传给 cmd 的字符，在关编辑器之前就报错
      const args = buildArgs(target, uproject)
      if (process.platform === 'win32') [script, ...args].forEach(quoteForCmd)

      // ── 1. 关编辑器 ──
      const result: FullRebuildResult = {
        closedEditor: false,
        built: false,
        reopened: false,
        live: false,
        target
      }
      result.closedEditor = await closeEditorForProject({
        projectDir,
        uproject,
        discardUnsaved: discard_unsaved,
        purpose: '编译',
        report: (text) => ctx.report({ text }),
        signal: ctx.signal
      })
      ctx.signal?.throwIfAborted()

      // ── 2. 编译 ──
      ctx.report({ text: `完整编译 ${target}…` })
      let build: BuildOutcome | undefined
      for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
        build = await runBuild(script, args, ctx.signal, (line) => {
          // UBT 的进度行形如 [12/240] Compile Foo.cpp —— 只报这类，别把几万行都推给界面
          if (/^\[\d+\/\d+\]/.test(line)) ctx.report({ text: `编译：${line.slice(0, 120)}` })
        })
        if (build.exitCode === 0 || !TRANSIENT_LOCK.test(build.output)) break
        if (attempt < LOCK_RETRIES) await sleep(LOCK_RETRY_DELAY_MS)
      }
      ctx.signal?.throwIfAborted()
      const described = describeBuild(build!)
      result.built = described.ok
      result.minutes = build!.minutes

      // ── 3/4. 重开、等连回来 ──
      // 第一句只说编译结果（✓/✗），关没关编辑器跟在后面 —— 失败时不能先来一句「已关闭」像是办成了
      const lines: string[] = [described.text]
      if (result.closedEditor) lines.push('（编译前已关闭编辑器。）')

      if (described.ok || reopen_on_failure) {
        ctx.report({ text: '重新打开工程…' })
        await ensurePlugin(uproject)
        const openError = await shell.openPath(uproject)
        if (openError) {
          lines.push(`✗ 打开工程失败：${openError}`)
        } else {
          result.reopened = true
          const live = await awaitProjectLive({
            projectPath: projectDir,
            timeoutMs: REOPEN_WAIT_MS,
            signal: ctx.signal
          })
          result.live = live.live && live.retargeted
          lines.push(
            result.live
              ? '✓ 编辑器已重新打开并连上，这一轮的引擎命令已经发往它，可以接着干活。'
              : '编辑器已经在启动，但还没连上（大工程首次加载要编着色器，几分钟是常态）。' +
                  '用 ue_session_health 带 wait_seconds 等它，**不要再调一次这个工具**。'
          )
        }
      } else {
        lines.push(
          '',
          '编辑器**保持关着**：带着编不过的代码打开，引擎只会再弹一次「要重编吗」。',
          '按上面的报错改代码，改完直接再调 cpp_full_rebuild（这次不用关编辑器了）。' +
            '决定不修了，就带 reopen_on_failure=true 调一次，把编辑器还给用户。'
        )
      }

      const text = lines.join('\n')
      // 编不过不抛：那是模型要读进去改代码的正常结果（同 cpp_compile）。第一句已经是 ✗
      return { text, details: result }
    }
  })
}
