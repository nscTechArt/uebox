/**
 * `team_status`：团队此刻的「现状真相」，一次查全。
 *
 * ## 为什么要有它
 *
 * 2026-09-26 真机反馈：制作人一天里拿到三个版本的现状（自己搜出来的、两个队员各说的），
 * 任务板上的备注还是上一轮的旧话。每一轮都得自己重新搜一遍、编译一遍对表，
 * 两次误判后给队员发了错误的现状描述。
 *
 * 这里把能不看视角的东西放在一起：
 * - **磁盘上有什么**（`inventory.ts`）—— 存下来的就在，编辑器崩了也数得出来
 * - **谁在干什么**：谁手上有活、干了多久，谁空着
 * - **谁占着哪些资产**：资产锁表，按队友名说
 * - **最近实际改了什么**：按写操作台账记的，不是队员自己说的
 * - **任务板**里哪些「进行中」已经很久没更新（多半是过期备注）
 * - **最近的快照**
 *
 * 只读，制作人和队员都能调。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../../tools/defineTool'
import { describeLockPath, holderLabel, listLocks, teamRootOf } from '../assetLock'
import { getTargetProjectPath } from '../projectTargetContext'
import { contentInventory, formatCounts } from './inventory'
import type { TeamSnapshots } from './snapshots'
import type { TeamLive } from './teamLive'
import type { TeamStore } from './teamStore'

/** 「进行中」多久没更新就提醒一句可能是过期备注 */
const STALE_TASK_MS = 15 * 60_000

export interface TeamStatusDeps {
  store: TeamStore
  live?: TeamLive
  /** 团队的根会话 id。锁表里本团队的锁主都以它开头 */
  sessionId: string
  snapshots?: TeamSnapshots
  now?: () => number
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  return `${Math.round(minutes / 6) / 10} 小时前`
}

function firstLine(text: string, max = 60): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? '').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export async function buildTeamStatus(deps: TeamStatusDeps): Promise<string> {
  const now = deps.now ?? Date.now
  const t = now()
  const sections: string[] = []

  // ── 磁盘 ──
  const projectDir = getTargetProjectPath()
  if (projectDir) {
    const inventory = await contentInventory(projectDir).catch(() => null)
    if (inventory) {
      sections.push(
        [
          `【工程现状 · 按磁盘】${projectDir}`,
          formatCounts(inventory),
          ...(inventory.recent.length
            ? [
                '最近存过的：',
                ...inventory.recent
                  .slice(0, 8)
                  .map((item) => `- ${item.path}（${ago(t - item.modifiedAt)}）`)
              ]
            : []),
          '（只数存到磁盘上的。编辑器里改了还没存的不在这里 —— 那不算交付）'
        ].join('\n')
      )
    }
  } else {
    sections.push('【工程现状】这一轮还没有连着的工程。')
  }

  // ── 谁在干什么 ──
  const roster = await deps.store.roster()
  const busy = new Map((deps.live?.assignments() ?? []).map((a) => [a.member.toLowerCase(), a]))
  if (roster.length) {
    sections.push(
      [
        '【谁在干什么】',
        ...roster.map((member) => {
          const job = busy.get(member.name.toLowerCase())
          return job
            ? `- ${member.name}：在干「${firstLine(job.text)}」（已 ${Math.max(1, Math.round((t - job.since) / 60_000))} 分钟）`
            : `- ${member.name}：空闲${deps.live?.isRunning(member.name) ? '' : '（要它干活用 team_send）'}`
        })
      ].join('\n')
    )
  }

  // ── 锁 ──
  const locks = listLocks()
  const ours = locks.filter((lock) => teamRootOf(lock.owner) === deps.sessionId)
  const others = locks.length - ours.length
  sections.push(
    [
      '【谁占着哪些资产】',
      ...(ours.length
        ? ours.map(
            (lock) =>
              `- ${describeLockPath(lock.path)} ← ${holderLabel(lock.owner)}（已占 ${Math.max(1, Math.round((t - lock.acquiredAt) / 60_000))} 分钟，它这件活交回时放）`
          )
        : ['- 团队里没人占着资产']),
      ...(others > 0 ? [`- 另有 ${others} 个资产被盒子里别的会话占着`] : [])
    ].join('\n')
  )

  // ── 最近改动 ──
  const activity = await deps.store.activity(8)
  if (activity.length) {
    sections.push(
      [
        '【最近实际改了什么】（按写操作记账，不是队员自己说的）',
        ...[...activity]
          .reverse()
          .map(
            (a) =>
              `- ${ago(t - a.at)} ${a.who}「${firstLine(a.what, 40)}」：${a.writes || '没有写操作'}`
          )
      ].join('\n')
    )
  }

  // ── 任务板 ──
  const board = await deps.store.board()
  if (board.length) {
    const count = (status: string): number => board.filter((task) => task.status === status).length
    const stale = board.filter(
      (task) =>
        (task.status === 'doing' || task.status === 'blocked') && t - task.updatedAt > STALE_TASK_MS
    )
    sections.push(
      [
        `【任务板】${board.length} 项：待办 ${count('todo')} · 进行中 ${count('doing')} · 完成 ${count('done')} · 卡住 ${count('blocked')}`,
        ...(stale.length
          ? [
              '这些很久没更新，备注可能已经过期（对照上面的磁盘和最近改动再信）：',
              ...stale.map(
                (task) =>
                  `- ${task.id} ${task.title}${task.owner ? ` @${task.owner}` : ''}（${ago(t - task.updatedAt)}更新）`
              )
            ]
          : [])
      ].join('\n')
    )
  }

  // ── 快照 ──
  if (deps.snapshots && projectDir) {
    const snapshots = await deps.snapshots.list(3).catch(() => [])
    if (snapshots.length) {
      sections.push(
        ['【最近快照】', ...snapshots.map((s) => `- ${s.id} ${ago(t - s.at)} ${s.message}`)].join(
          '\n'
        )
      )
    }
  }

  return sections.join('\n\n')
}

const statusInput = z.object({})

export function createStatusTool(deps: TeamStatusDeps): UnrealAgentTool<unknown> {
  return defineTool<typeof statusInput, unknown>({
    name: 'team_status',
    namespace: 'core',
    risk: 'safe',
    concurrency: 'parallel',
    description:
      '团队此刻的现状，一次查全：磁盘上的资产概况和最近存过的文件、谁在干什么、谁占着哪些资产（已占多久）、' +
      '最近实际改了什么（按写操作记账）、任务板上很久没更新的项、最近的快照。' +
      '队员说的和你查的对不上时，以这里为准；派活前先看一眼，别给队员发过期的现状。',
    input: statusInput,
    execute: async () => ({ text: await buildTeamStatus(deps) })
  })
}
