/**
 * `uebox actors spawn / move / delete` —— V1.1 的三条写命令。
 *
 * 三条都是关卡内对象，都满足 的准入条件：调用方给定
 * 身份、有回退路径（agent 撤销栈）、回读判据单一确定。准入判定和参数收窄在
 * `write.ts`，执行与回读在 `runtime.ts` 的 `runWrite`，这里只负责把命令行
 * 选项拼成工具参数、把结果拼成信封。
 *
 * ## 报成功之前一定回读
 *
 * 「工具返回成功」不等于「引擎里真的变成那样了」。这三条命令一律回读一次再
 * 下结论，回读对不上就报失败 —— 哪怕引擎那边说它成功了。
 *
 * ## 撤销办法随成功结果一起给
 *
 * 写成功之后顺手告诉用户怎么撤。不给的话，一个刚把 Actor 放错位置的人得先去
 * 翻文档才能退回去，而这期间他很可能先手动改一遍 —— 那正是 §12.5 说的
 * 交叉编辑，会让后面的 `ue_undo` 把他自己的改动一起还原。
 */

import { parseVector } from '../args.js'
import { success, type Envelope } from '../envelope.js'
import { UeboxError } from '../errors.js'
import * as runtime from '../runtime.js'
import { requireSupported } from '../tools.js'
import { admittedWrite } from '../write.js'

const XYZ = ['x', 'y', 'z'] as const
const PITCH_YAW_ROLL = ['pitch', 'yaw', 'roll'] as const

export interface ActorsWriteOptions {
  configPath?: string
  timeoutSeconds?: number
  project?: string
  env?: NodeJS.ProcessEnv
  allowWrite: boolean
  name?: string
  asset?: string
  location?: string
  rotation?: string
  scale?: string
}

function openOptions(options: ActorsWriteOptions): runtime.RuntimeOptions {
  return {
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.env ? { env: options.env } : {})
  }
}

/** 三条写命令共用的骨架：连上 → 确认工具能调 → 定工程 → 跑写 → 拼信封 */
async function write(
  options: ActorsWriteOptions,
  toolName: string,
  buildArgs: () => Record<string, unknown>,
  describe: (subject: string) => { summary: string; undoHint: string }
): Promise<Envelope> {
  const op = admittedWrite(toolName)
  if (!op) {
    // 走到这里说明准入表和命令表对不上了，是我们自己的 bug，不是用户的问题
    throw new UeboxError('RISK_NOT_SUPPORTED', `${toolName} 不在写操作准入表里。`)
  }

  const args = buildArgs()
  // 参数问题在连接之前就报出来：写错一个选项不该先去打扰盒子和引擎
  op.constrain(args)

  const rt = await runtime.open(openOptions(options))
  try {
    const catalog = await runtime.catalog(rt)
    requireSupported(catalog, toolName, options.allowWrite)

    const project = await runtime.targetProject(rt, options.project)
    const outcome = await runtime.runWrite(rt, op, args, project)
    const subject = op.subject(args)
    const { summary, undoHint } = describe(subject)

    if (!outcome.verdict.done) {
      throw new UeboxError(
        'TOOL_FAILED',
        `${summary}没有生效：${outcome.verdict.detail}`,
        '引擎那侧没有报错，但回读对不上 —— 以回读为准。' +
          `用 uebox actors list --name "${subject}" 看现在的实际状态。`,
        'failed'
      )
    }

    return success({
      project: { name: project.name, path: project.path },
      data: {
        tool: toolName,
        actorName: subject,
        // 回读结果原样带上：这是「做成了」的证据，不是一句自述
        verified: outcome.verdict,
        actor: outcome.actor
      },
      warnings: [undoHint]
    })
  } finally {
    await rt.close()
  }
}

/**
 * 撤销提示。
 *
 * ## 这句话前后错过两次，两次的错法不一样
 *
 * 第一版写「跑 `uebox tools call ue_undo --allow-write`」——那条命令必然被
 * 准入表挡下，退出码 6。
 *
 * 第二版改成「在编辑器里按 Ctrl+Z」——更糟。CLI 的写入落在 **agent 那条独立
 * 撤销栈**上，事务结束时 `PopScope()` 把 `GEditor->Trans` 换回用户的缓冲
 * （`UAL_AgentUndo.cpp`）。所以 Ctrl+Z 走的是用户自己那条栈：**撤掉的是用户
 * 上一步手动操作，CLI 的改动一点没动。** 等于把人推向一个会误伤他自己编辑的动作。
 *
 * 现在指向 `uebox actors undo`，它前后各读一次撤销栈来确认撤的是哪一步。
 *
 * 另外一定要提醒「撤销栈是共用的」：盒子里的 agent 和 CLI 用同一条栈，
 * 中间只要有别的写入，撤掉的就不是你刚做的那一步（§12.5）。
 */
function undoHintFor(what: string): string {
  return (
    `${what}。要退回去：uebox actors undo --allow-write。` +
    '不要在编辑器里按 Ctrl+Z —— CLI 的改动落在一条独立的撤销栈上，' +
    'Ctrl+Z 撤的是你自己上一步手动操作，CLI 这一步不会动。' +
    '这条栈是盒子内的 AI 和 CLI 共用的，中间如果还有别的写入，撤掉的就不是这一步。'
  )
}

/** 生成一个 Actor。名字必须由调用方给定，否则没有回读判据 */
export async function runActorsSpawn(options: ActorsWriteOptions): Promise<Envelope> {
  if (!options.name) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      'actors spawn 需要 --name 给这个 Actor 命名。',
      '不给名字的话由引擎分配（Cube_2 这种），一旦超时就分不清场上那个是不是这次生成的。'
    )
  }
  if (!options.asset) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      'actors spawn 需要 --asset 说明要生成什么。',
      '别名、资产路径（/Game/...）或类名都行，例如 --asset StaticMeshActor。'
    )
  }

  return write(
    options,
    'ue_spawn_actor',
    () => ({
      name: options.name,
      asset_id: options.asset,
      ...(transformFrom(options) ? { transform: transformFrom(options) } : {})
    }),
    (subject) => ({
      summary: `生成 ${subject}`,
      undoHint: undoHintFor(`已经生成 ${subject}`)
    })
  )
}

/** 移动/旋转/缩放一个 Actor。只做绝对设置 —— 增量不幂等，进不了准入表 */
export async function runActorsMove(options: ActorsWriteOptions): Promise<Envelope> {
  if (!options.name) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      'actors move 需要 --name 点名一个 Actor。',
      '用 uebox actors list 看关卡里有哪些。'
    )
  }

  const set = transformFrom(options)
  if (!set) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      'actors move 至少要给 --location / --rotation / --scale 之一。',
      '例如 --location z=200（只抬高到 2 米，X/Y 保持原样）。'
    )
  }

  return write(
    options,
    'ue_set_transform',
    () => ({ targets: { names: [options.name] }, operation: { set } }),
    (subject) => ({
      summary: `把 ${subject} 的变换设成请求值`,
      undoHint: undoHintFor(`已经改了 ${subject} 的变换`)
    })
  )
}

/** 删除一个 Actor。删已经删掉的是空操作，所以重发安全 */
export async function runActorsDelete(options: ActorsWriteOptions): Promise<Envelope> {
  if (!options.name) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      'actors delete 需要 --name 点名一个 Actor。',
      '这一版不支持按过滤器批量删除 —— 部分成功之后说不清哪些删了。'
    )
  }

  return write(
    options,
    'ue_destroy_actor',
    () => ({ targets: { names: [options.name] } }),
    (subject) => ({
      summary: `删除 ${subject}`,
      undoHint: undoHintFor(`已经删掉 ${subject}`)
    })
  )
}

/**
 * 把 `--location` / `--rotation` / `--scale` 拼成一个变换。
 *
 * 三个都没给时返回 `undefined`，让调用方决定这算不算错 ——
 * `spawn` 不给是「用默认位置」，`move` 不给是无事可做。
 */
function transformFrom(options: ActorsWriteOptions): Record<string, unknown> | undefined {
  const transform: Record<string, unknown> = {}

  if (options.location) transform.location = parseVector(options.location, XYZ, '--location')
  if (options.rotation) {
    transform.rotation = parseVector(options.rotation, PITCH_YAW_ROLL, '--rotation')
  }
  if (options.scale) transform.scale = parseVector(options.scale, XYZ, '--scale')

  return Object.keys(transform).length > 0 ? transform : undefined
}
