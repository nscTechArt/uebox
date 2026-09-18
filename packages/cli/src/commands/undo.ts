/**
 * `uebox actors undo` —— 撤销 CLI 自己做过的那一步。
 *
 * ## 为什么不能让用户去按 Ctrl+Z
 *
 * 外部评审抓到的一条，而且是我上一轮"修好了"的那条又错了：
 *
 * CLI 的写入落在 **agent 那条独立撤销栈**上（`FUAL_ScopedTransaction` 在事务
 * 期间把 `GEditor->Trans` 换成 agent 缓冲），事务一结束 `PopScope()` 就把
 * 编辑器的缓冲换了回去。所以编辑器里按 Ctrl+Z 走的是**用户自己那条栈** ——
 * 撤掉的是用户上一步手动操作，而 CLI 的改动原封不动留在那里。
 *
 * 把用户往这个动作上推，比不给撤销办法更糟：他以为回退了，实际上既没回退，
 * 还额外毁掉了自己的一次编辑。
 *
 * ## 怎么核实撤销真的生效了
 *
 * 和三条写命令同一个原则：不信工具的自述，比对引擎的实际状态。
 *
 * 撤之前读一次 `ue_undo_history`（栈深度 + 栈顶标题），撤之后再读一次。
 * 深度少一、并且原来的栈顶不见了，才算撤成功。**只看深度不够** ——
 * 这条栈是盒子内的 agent 和 CLI 共用的，中间要是有别的写入，深度差会骗人
 * 。
 *
 * ## 一次只撤一步
 *
 * `ue_undo` 不填 steps 是"把这一轮做的全撤了"。CLI 这头固定 `steps: 1`：
 * 一步是能说清楚的（撤之前就告诉你要撤哪一步），"全部"不是。
 */

import { success, type Envelope } from '../envelope.js'
import { UeboxError } from '../errors.js'
import * as runtime from '../runtime.js'
import { requireSupported } from '../tools.js'
import { UNDO_HISTORY_TOOL, UNDO_TOOL } from '../write.js'

export interface UndoOptions {
  configPath?: string
  timeoutSeconds?: number
  project?: string
  env?: NodeJS.ProcessEnv
  allowWrite: boolean
}

interface Snapshot {
  undoable: number | null
  topTitle: string | null
  topPackages: string[]
}

/** 读一次撤销栈。拿不到结构化数据就直接失败 —— 没有它就无从核实 */
async function readStack(rt: runtime.Runtime, projectPath: string): Promise<Snapshot> {
  const result = await runtime.callTool(rt, UNDO_HISTORY_TOOL, { limit: 1 }, projectPath)
  const data = result.structuredContent

  if (!data || typeof data.undoable !== 'number') {
    throw new UeboxError(
      'INCOMPATIBLE_SERVER',
      '虚幻盒子没有返回结构化的撤销历史，无法核实撤销结果。',
      '升级虚幻盒子 —— 旧版本只把撤销栈写在一段文字里，没法当接口用。'
    )
  }

  const top = Array.isArray(data.entries) ? (data.entries[0] as Record<string, unknown>) : undefined

  return {
    undoable: data.undoable,
    topTitle: typeof top?.title === 'string' ? top.title : null,
    topPackages: Array.isArray(top?.packages)
      ? (top.packages as unknown[]).filter((p): p is string => typeof p === 'string')
      : []
  }
}

/**
 * 撤销结局不明时给的话。
 *
 * ## 判据只能是栈深度，**绝对不能是栈顶标题**
 *
 * 这里错过一版：原来写的是「栈顶标题没变 = 没撤成，可以重来」。
 * 而引擎的事务标题是写死的字面量（`UAL_ActorCommands.cpp` 里就是
 * `生成Actor`、`删除Actor` 这几个），**连着生成两个 Actor，栈上就是两条
 * 一模一样的「生成Actor」**。撤掉一条之后栈顶标题当然还是它 —— 照那句话重试，
 * 就把另一个对象也撤了。
 *
 * 标题是描述，不是身份。深度才会变：撤成功就少一步。
 *
 * 深度也有它的前提：这条栈是盒子内的 AI 和 CLI 共用的，中间要是有别的写入，
 * 深度会被推回去，判断就不成立（§12.5）。这一点必须一起说，不能让人拿一个
 * 有前提的判据当确定结论用。
 */
function unknownUndo(
  before: Snapshot,
  project: { path: string },
  /** 撤销请求本身已经收到回应，只是随后的回读超时 */
  afterApplied = false
): UeboxError {
  const depth = before.undoable
  const message = afterApplied
    ? 'ue_undo 已经回报成功，但随后的回读超时，没能核实撤销栈的实际状态。'
    : 'ue_undo 的执行结局不明：请求已经发给引擎了，没等到结果。'

  return new UeboxError(
    'TIMEOUT',
    message,
    '不要直接重发 —— 重发会再撤一步。先看现在的栈：\n' +
      `  uebox tools call ${UNDO_HISTORY_TOOL} --project "${project.path}"\n` +
      `撤之前是 ${depth ?? '?'} 步。现在还是 ${depth ?? '?'} 步 = 没撤成，可以重来；` +
      `变成 ${depth === null ? '?' : depth - 1} 步 = 已经撤过了，不要再撤。\n` +
      '注意只能看步数，不能看栈顶标题 —— 引擎的标题是固定的几个词，' +
      '连着做两次同类操作就完全一样。另外这条栈是盒子内的 AI 和 CLI 共用的，' +
      '中间要是有别的写入，步数也会对不上，那就只能去核对现场。',
    'unknown'
  )
}

export async function runActorsUndo(options: UndoOptions): Promise<Envelope> {
  const rt = await runtime.open({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.env ? { env: options.env } : {})
  })

  try {
    const catalog = await runtime.catalog(rt)
    requireSupported(catalog, UNDO_TOOL, options.allowWrite)
    requireSupported(catalog, UNDO_HISTORY_TOOL)

    const project = await runtime.targetProject(rt, options.project)
    const before = await readStack(rt, project.path)

    if (before.undoable === 0) {
      throw new UeboxError(
        'TOOL_FAILED',
        '这条撤销栈上没有可撤销的步骤。',
        'CLI 和盒子内的 AI 共用一条栈，栈是空的说明这一轮没有它们做过的改动。' +
          '用户自己手动做的操作不在这条栈上 —— 那些请在编辑器里按 Ctrl+Z。',
        'not_started'
      )
    }

    let result: runtime.ToolCallResult
    try {
      result = await runtime.callTool(rt, UNDO_TOOL, { steps: 1, direction: 'undo' }, project.path)
    } catch (error) {
      // 撤销超时和写操作超时是同一类问题：可能已经撤了
      throw error instanceof UeboxError && error.code === 'TIMEOUT'
        ? unknownUndo(before, project)
        : error
    }

    // 撤销已经发出去了，这次回读要是也超时，同样不能报「失败」——
    // 报失败会让调用方重来一次，那就是多撤一步
    let after: Snapshot
    try {
      after = await readStack(rt, project.path)
    } catch (error) {
      throw error instanceof UeboxError && error.code === 'TIMEOUT'
        ? unknownUndo(before, project, true)
        : error
    }

    const undone = result.structuredContent
    const stepsApplied = typeof undone?.stepsApplied === 'number' ? undone.stepsApplied : null

    /*
     * 引擎明说这一次一步都没撤。**这条最优先，且不看深度。**
     *
     * 原来它被写成 `!depthDropped && stepsApplied === 0` —— 于是「引擎说没撤、
     * 深度却少了一步」这种组合两个分支都躲过去，一路掉到成功里。而那个组合正是
     * 危险的那个：两个客户端都看到同一个栈顶，别人先撤掉了，深度是被**他**减掉的，
     * 我们却报 `verified.done: true`，等于把别人干的事记在自己账上。
     *
     * `stepsApplied` 是引擎对**这一次调用**的直接回答，深度只是间接推断而且会被
     * 并发写入干扰。强证据不该由弱证据来开门。
     */
    if (stepsApplied === 0) {
      throw new UeboxError(
        'TOOL_FAILED',
        '撤销没有生效：引擎报告这次一步都没撤。',
        '用 uebox tools call ue_undo_history 看看栈上还有什么。' +
          '如果栈确实变浅了，那是别的客户端撤的 —— 这条栈是盒子内的 AI 和 CLI 共用的。',
        'not_started'
      )
    }

    // 深度是次一级的判据。
    //
    // 不比栈顶标题：引擎的事务标题是写死的几个词（`生成Actor`、`删除Actor`），
    // 连着做两次同类操作，撤掉一条之后标题照样一样，拿它当身份会得出错误结论。
    const depthDropped =
      before.undoable !== null && after.undoable !== null && after.undoable === before.undoable - 1

    /*
     * 步数对不上，但引擎报告确实撤了。
     *
     * 这**不是失败**。第二轮评审给的场景：撤之前 2 步，撤成功剩 1 步，回读之前
     * 盒子里的 AI 又写了 1 步，回读又是 2 步 —— 撤销明明生效了，深度却对不上。
     * 原来这里一律报 `failed`，等于诱导调用方重试，而重试就是多撤一步。
     *
     * 引擎已经给了正面证据（`stepsApplied >= 1`），只是我们没法确认最终状态，
     * 那就如实说「确认不了」。并发前提之前只写进了超时提示，正常回读这条路
     * 同样需要它。
     */
    if (!depthDropped) {
      throw new UeboxError(
        'TIMEOUT',
        `撤销结果无法确认：引擎报告已撤销 ${stepsApplied ?? '若干'} 步，` +
          `但撤之前栈上有 ${before.undoable} 步、撤之后是 ${after.undoable} 步，对不上。`,
        '不要直接重发 —— 引擎说它撤过了，再撤一次就是多撤一步。\n' +
          '最可能的原因是这期间盒子里的 AI 也写了东西：这条撤销栈是共用的，' +
          '别人加一步，步数就抵消了。\n' +
          '用 uebox actors list 核对现场，确认关卡是不是你要的样子。',
        'unknown'
      )
    }

    const affected = Array.isArray(undone?.affectedPackages)
      ? (undone.affectedPackages as unknown[]).filter((p): p is string => typeof p === 'string')
      : []

    return success({
      project: { name: project.name, path: project.path },
      data: {
        // 标题是**描述**，不是身份：引擎那几个词是写死的，两次同类操作完全同名。
        // 字段名点明这一点，免得调用方拿它去做判断
        undoneStepDescription: before.topTitle,
        stepTitles: undone?.stepTitles ?? null,
        remaining: after.undoable,
        affectedPackages: affected,
        verified: {
          done: true,
          detail: `撤销前 ${before.undoable} 步、撤销后 ${after.undoable} 步。`
        }
      },
      warnings: [
        // 这条不说清楚，用户会以为已经回退干净了
        '撤销只改了编辑器内存里的内容，磁盘上还是撤销前的样子。' +
          (affected.length > 0
            ? `受影响的 ${affected.length} 个资产需要在编辑器里保存一次才会落盘。`
            : '需要在编辑器里保存一次才会落盘。')
      ]
    })
  } finally {
    await rt.close()
  }
}
