/**
 * `uebox team …` —— 外部团队（Claude Code 当大脑、虚幻盒子当工作室）的名册和交付闸。
 *
 * 设计稿：docs/外部大脑跑团队设计-2026-10-17.md 第 6、9 节。
 *
 * ## 交付闸为什么在这里
 *
 * 盒子里的团队，交付闸在盒子自己的 agent 循环里：制作人想收尾时还没过验收，就推它回去。
 * 外部团队的循环在 Claude Code 里，盒子看不到「它想收尾」这一刻。Claude Code 的 Stop hook
 * 看得到 —— 它跑 `uebox team gate --hook`，这里问盒子要事实（`team_gate`），按和盒子里
 * 一样的口径判拦不拦，拦的话把那句提醒交回给 Claude Code。
 *
 * 拦了几次记在本地（`.uebox/team.json`），不记在盒子里：`team_gate` 因此是只读的，
 * 模型自己去调它也不会把次数用掉。新一轮（用户发了新消息）由 UserPromptSubmit hook 跑
 * `uebox team round --hook` 清零。
 *
 * ## hook 模式绝不卡住用户
 *
 * `--hook` 时不输出信封：Stop hook 只认 `{"decision":"block","reason":…}`，其余一律放行。
 * 连不上盒子、找不到团队、读不了文件 —— 都只在 stderr 说一句、退出码 0、放行。
 * 一个坏掉的检查不该让用户的会话停不下来。
 *
 * ## 混合团队（队员在盒子里跑）
 *
 * 队员还在后台干活、或者有话没交到制作人手上时，收工就是把活扔下：拦下来让它 `team_wait`。
 * 这种拦不用掉「两次提醒」的额度（那是给「没过验收」的），另记一个上限，防的是队员卡死时
 * 制作人永远停不下来。放行时告诉盒子制作人收工了（`team_gate` 的 `phase: 'stop'`），
 * 宿主把它从「谁在跑」上摘下来，队员再找它就进信箱。新消息时（UserPromptSubmit）把用户那句话
 * 交给盒子（给验收员看），并把任务板上没动的旧账打印出来，Claude Code 会把它加进上下文。
 * docs/混合团队设计-2026-10-24.md 第 2 节。
 */

import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { success, type Envelope } from '../envelope.js'
import { UeboxError } from '../errors.js'
import * as runtime from '../runtime.js'

/** 和盒子里 `MAX_TEAM_NUDGES` 同一个数：一轮最多推两次，真卡住要让它停下来跟用户说 */
export const MAX_NUDGES = 2

/**
 * 一轮里最多为「还有活在跑 / 有话没看」拦几次。每次拦下它会 `team_wait` 最多几分钟，
 * 这个数大约是两三个小时；到了就放行，让制作人跟用户说清楚谁卡住了
 */
export const MAX_WAITS = 40

/** hook 默认的期限。Stop hook 每次收尾都跑，不能让用户干等两分钟 */
const HOOK_TIMEOUT_SECONDS = 15

const STATE_DIR = '.uebox'
const STATE_FILE = 'team.json'

/** `team_gate` 的结构化结果（盒子 `publicResult.ts` 的 `serializeTeamGate`） */
export interface GateFacts {
  teamId: string | null
  objective: string | null
  verdict: 'pass' | 'fail' | 'blocked' | null
  verdictAt: number | null
  lastWriteAt: number | null
  deliveries: number | null
  passed: boolean | null
  ended: boolean | null
  /** 混合团队：还在后台跑的活。旧盒子没有这一项 */
  pendingJobs?: number | null
  /** 混合团队：队员发给制作人、它还没看的话 */
  unreadForProducer?: number | null
}

/** 当前目录绑定的团队，以及这一轮拦过几次 */
export interface LocalTeamState {
  teamId: string
  nudges: number
  /** 这一轮为「还有活在跑」拦过几次。旧文件没有 */
  waits?: number
}

export interface GateDecision {
  block: boolean
  /** 拦的时候交回给 Claude Code 的那句话；放行时说为什么放行 */
  reason: string
  /** `wait` = 为还在跑的活拦的，不用提醒额度 */
  kind?: 'wait' | 'nudge'
}

/**
 * 拦不拦。口径同盒子里的 `createTeamGate`：
 * 过了验收（之后没再改）放行；BLOCKED 放行（验收员说「这得用户来」）；一轮拦满两次放行。
 */
export function decideGate(facts: GateFacts, nudges: number, waits = 0): GateDecision {
  if (facts.ended) return { block: false, reason: '团队已结束。' }
  const pending = facts.pendingJobs ?? 0
  const unread = facts.unreadForProducer ?? 0
  if ((pending > 0 || unread > 0) && waits < MAX_WAITS) {
    return {
      block: true,
      kind: 'wait',
      reason: [
        '[Unreal Box team · automatic check] This is not the user speaking.',
        [
          pending > 0 ? `${pending} teammate job(s) are still running.` : '',
          unread > 0 ? `${unread} message(s) from teammates have not reached you yet.` : ''
        ]
          .filter(Boolean)
          .join(' '),
        'Call team_wait to collect them before you finish.'
      ].join('\n')
    }
  }
  if (facts.passed) return { block: false, reason: '已过验收，之后没有改动。' }
  if (facts.verdict === 'blocked') return { block: false, reason: '验收员说缺的东西得用户给。' }
  if (nudges >= MAX_NUDGES) {
    return { block: false, reason: `这一轮已经提醒过 ${MAX_NUDGES} 次，放行让制作人跟用户说清楚。` }
  }
  const why =
    facts.verdict === 'fail'
      ? 'The last acceptance run failed.'
      : facts.verdict === 'pass'
        ? 'The project changed after the last PASS, so that PASS no longer counts.'
        : 'The game has not been through acceptance yet.'
  return {
    block: true,
    kind: 'nudge',
    reason: [
      '[Unreal Box team · automatic check] This is not the user speaking.',
      `${why} Delivery only counts once a uebox-acceptor subagent records PASS with team_verdict.`,
      'Keep working toward it. If you genuinely cannot go on without the user, say exactly what you need from them and stop.'
    ].join('\n')
  }
}

// ── 本地状态 ────────────────────────────────────────────────────────────

/** 从 `start` 往上找最近的 `.uebox/team.json` */
export async function findLocalState(
  start: string
): Promise<{ file: string; state: LocalTeamState } | null> {
  let dir = resolve(start)
  for (;;) {
    const file = join(dir, STATE_DIR, STATE_FILE)
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<LocalTeamState>
      if (typeof raw.teamId === 'string' && raw.teamId) {
        return {
          file,
          state: {
            teamId: raw.teamId,
            nudges: typeof raw.nudges === 'number' ? raw.nudges : 0,
            ...(typeof raw.waits === 'number' && raw.waits > 0 ? { waits: raw.waits } : {})
          }
        }
      }
    } catch {
      // 没有或读不了就接着往上找
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function writeLocalState(file: string, state: LocalTeamState): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

// ── 盒子那头 ────────────────────────────────────────────────────────────

export interface TeamOptions {
  configPath?: string
  timeoutSeconds?: number
  env?: NodeJS.ProcessEnv
  /** 位置参数里给的团队 id */
  teamId?: string
  /** 找 `.uebox/team.json` 从哪开始。默认当前目录 */
  cwd?: string
  /** hook 放行时告诉盒子制作人收工了（混合团队摘信箱） */
  stopOnAllow?: boolean
  /** 新一轮时用户说的那句话（UserPromptSubmit hook 的 prompt） */
  prompt?: string
}

async function withRuntime<T>(
  options: TeamOptions,
  fn: (rt: runtime.Runtime) => Promise<T>
): Promise<T> {
  const rt = await runtime.open({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.env ? { env: options.env } : {})
  })
  try {
    return await fn(rt)
  } finally {
    await rt.close()
  }
}

async function fetchGate(rt: runtime.Runtime, teamId: string): Promise<GateFacts> {
  const result = await runtime.callTool(rt, 'team_gate', { team_id: teamId })
  const facts = result.structuredContent as GateFacts | undefined
  if (!facts || typeof facts !== 'object') {
    throw new UeboxError(
      'INCOMPATIBLE_SERVER',
      '虚幻盒子没有返回交付闸的结构化结果。',
      '升级虚幻盒子 到支持外部团队的版本。'
    )
  }
  return facts
}

async function resolveTeamId(options: TeamOptions): Promise<{
  teamId: string
  local: { file: string; state: LocalTeamState } | null
}> {
  const local = await findLocalState(options.cwd ?? process.cwd())
  const teamId = options.teamId ?? local?.state.teamId
  if (!teamId) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      '没有指定团队，当前目录往上也没有 .uebox/team.json。',
      '给出团队 id，或者先在工作目录里运行 uebox team use <id>。'
    )
  }
  // 位置参数给的是别的团队时，本地记的拦截次数不归它
  return { teamId, local: local && local.state.teamId === teamId ? local : null }
}

// ── 命令 ────────────────────────────────────────────────────────────────

export async function runTeamList(options: TeamOptions): Promise<Envelope> {
  return withRuntime(options, async (rt) => {
    const result = await runtime.callTool(rt, 'team_list', {})
    const teams = (result.structuredContent?.teams as unknown[] | undefined) ?? []
    return success({ data: { teams, count: teams.length } })
  })
}

export async function runTeamStatus(options: TeamOptions): Promise<Envelope> {
  const { teamId, local } = await resolveTeamId(options)
  return withRuntime(options, async (rt) => {
    const facts = await fetchGate(rt, teamId)
    const nudges = local?.state.nudges ?? 0
    return success({ data: { ...facts, nudges, decision: decideGate(facts, nudges) } })
  })
}

/** 把当前目录绑到一个团队。先问盒子这个团队在不在，免得 hook 以后每次都白找 */
export async function runTeamUse(options: TeamOptions): Promise<Envelope> {
  const teamId = options.teamId
  if (!teamId) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      'team use 需要一个团队 id。',
      '运行 uebox team list 看有哪些。'
    )
  }
  return withRuntime(options, async (rt) => {
    const facts = await fetchGate(rt, teamId)
    const file = join(resolve(options.cwd ?? process.cwd()), STATE_DIR, STATE_FILE)
    await writeLocalState(file, { teamId, nudges: 0 })
    return success({ data: { teamId, objective: facts.objective, file } })
  })
}

export async function runTeamGate(options: TeamOptions): Promise<Envelope> {
  const { teamId, local } = await resolveTeamId(options)
  return withRuntime(options, async (rt) => {
    const facts = await fetchGate(rt, teamId)
    const nudges = local?.state.nudges ?? 0
    const waits = local?.state.waits ?? 0
    const decision = decideGate(facts, nudges, waits)
    const next = {
      nudges: decision.block && decision.kind !== 'wait' ? nudges + 1 : nudges,
      waits: decision.block && decision.kind === 'wait' ? waits + 1 : waits
    }
    if (decision.block && local) await writeLocalState(local.file, { ...local.state, ...next })
    if (!decision.block && options.stopOnAllow) {
      await runtime.callTool(rt, 'team_gate', { team_id: teamId, phase: 'stop' })
    }
    return success({ data: { ...facts, ...next, decision } })
  })
}

export async function runTeamRound(options: TeamOptions): Promise<Envelope> {
  const local = await findLocalState(options.cwd ?? process.cwd())
  if (!local) return success({ data: { teamId: null, reset: false } })
  await writeLocalState(local.file, { teamId: local.state.teamId, nudges: 0 })
  return success({ data: { teamId: local.state.teamId, reset: true } })
}

/**
 * 新一轮告诉盒子：用户刚说的话记给验收员，回来的是任务板上没动的旧账（没有就是空串）。
 * 旧盒子不认 `phase` 也没关系：它回的是交付闸那句话，这里只取 round 的回话
 */
async function announceRound(options: TeamOptions, teamId: string): Promise<string> {
  return withRuntime(options, async (rt) => {
    const result = await runtime.callTool(rt, 'team_gate', {
      team_id: teamId,
      phase: 'round',
      ...(options.prompt?.trim() ? { latest_request: options.prompt.trim() } : {})
    })
    const text = (result.content ?? [])
      .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('\n')
      .trim()
    return text.includes('<team_board_carryover>') ? text : ''
  })
}

// ── hook 模式 ───────────────────────────────────────────────────────────

/** hook 的 stdin（Claude Code 的约定）。用得到 cwd 和 UserPromptSubmit 的 prompt */
function hookInput(stdin: string): { cwd?: string; prompt?: string } {
  try {
    const input = JSON.parse(stdin) as { cwd?: unknown; prompt?: unknown }
    return {
      ...(typeof input.cwd === 'string' && input.cwd ? { cwd: input.cwd } : {}),
      ...(typeof input.prompt === 'string' && input.prompt ? { prompt: input.prompt } : {})
    }
  } catch {
    return {}
  }
}

export interface HookResult {
  stdout: string
  stderr: string
}

/**
 * `uebox team gate|round --hook`。永远退出码 0；只有拦的时候 stdout 有东西。
 */
export async function runTeamHook(
  sub: 'gate' | 'round',
  options: TeamOptions,
  stdin: string
): Promise<HookResult> {
  const input = hookInput(stdin)
  const cwd = input.cwd ?? options.cwd
  const opts: TeamOptions = {
    ...options,
    ...(cwd ? { cwd } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    timeoutSeconds: options.timeoutSeconds ?? HOOK_TIMEOUT_SECONDS
  }
  try {
    if (sub === 'round') {
      const reset = await runTeamRound(opts)
      const teamId = (reset.data as { teamId: string | null }).teamId
      // 清零是本地的事，一定做；告诉盒子是锦上添花，连不上就算了
      const carryOver = teamId
        ? await announceRound(opts, teamId).catch((error: unknown) => {
            throw new Error(
              `新一轮没告诉盒子：${error instanceof Error ? error.message : String(error)}`
            )
          })
        : ''
      return { stdout: carryOver ? `${carryOver}\n` : '', stderr: '' }
    }
    // 没绑团队的目录：不是团队会话，什么都不做
    if (!opts.teamId && !(await findLocalState(opts.cwd ?? process.cwd()))) {
      return { stdout: '', stderr: '' }
    }
    const envelope = await runTeamGate({ ...opts, stopOnAllow: true })
    const decision = (envelope.data as { decision: GateDecision }).decision
    return decision.block
      ? {
          stdout: `${JSON.stringify({ decision: 'block', reason: decision.reason })}\n`,
          stderr: ''
        }
      : { stdout: '', stderr: '' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { stdout: '', stderr: `uebox team ${sub}：没检查成，放行。${message}\n` }
  }
}
