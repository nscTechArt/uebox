/**
 * 工作室模式的工程快照：每个队员交回一件活就存一次，改坏了能整个退回去。
 *
 * ## 用 git，但不用工程自己的 git
 *
 * 快照仓库放在 `<工程>/Saved/UEBoxSnapshots/.git`，工作区指向工程根目录
 * （`--git-dir` + `--work-tree`）。这样：
 * - 工程本来就在 git / Perforce 里的话，一个字节都不碰用户的仓库；
 * - `Saved/` 本来就是 UE 的临时目录，删了也不影响工程。
 *
 * 只收工程的「源」：`Content/`、`Config/`、`Source/`、`.uproject` 这些。
 * `Binaries/`、`Intermediate/`、`DerivedDataCache/`、`Saved/` 都是生成的，
 * 进快照只会让仓库暴涨、回滚时还把缓存退成旧的。
 *
 * 回滚不在这里做完整流程 —— 编辑器开着的时候改磁盘上的资产，编辑器要么占着文件、
 * 要么下次保存把旧的写回来。关编辑器、回滚文件、再打开，那一串在宿主层
 * （`ipc/teamSnapshots.ts`）。这里只管 git 这一半。
 */

import { promises as fs } from 'fs'
import { join } from 'path'

import { contentInventory, formatCounts } from './inventory'

/** 不进快照的东西：UE 生成的目录、IDE 文件、快照仓库自己 */
export const SNAPSHOT_EXCLUDES = [
  '/Binaries/',
  '/Intermediate/',
  '/DerivedDataCache/',
  '/Saved/',
  '/Build/',
  '/Plugins/*/Binaries/',
  '/Plugins/*/Intermediate/',
  '.vs/',
  '.idea/',
  '*.sln',
  '*.suo',
  '*.opensdf',
  '*.sdf',
  '*.VC.db',
  '*.VC.opendb'
]

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/** 跑一条 git 命令。由宿主提供（execFile），测试里可以换成真 git 或假的 */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>

export interface Snapshot {
  id: string
  at: number
  message: string
}

/**
 * 工作室工具看到的快照能力：存、列、回滚。回滚要关编辑器、再打开，由宿主实现
 * （`ipc/teamSnapshots.ts`）。
 */
export interface TeamSnapshots {
  /** 存一份。这一轮还没有工程、或者没变化，给 null */
  save(message: string): Promise<Snapshot | null>
  list(limit?: number): Promise<Snapshot[]>
  rollback(id: string, report: (text: string) => void): Promise<string>
}

export interface SnapshotStore {
  /** 存一份。和上一份比没变化就不存，返回 null */
  save(message: string): Promise<Snapshot | null>
  list(limit?: number): Promise<Snapshot[]>
  /** 把工程的源文件退回到这一份。新建的文件删掉，被忽略的（缓存、Saved）不动 */
  restore(id: string): Promise<void>
}

/** `git diff --name-status` → 「新增 3 · 修改 2 · 删除 1」。没变化给空串 */
export function summarizeChanges(nameStatus: string): string {
  let added = 0
  let modified = 0
  let deleted = 0
  for (const line of nameStatus.split('\n')) {
    const code = line.trim()[0]
    if (code === 'A') added++
    else if (code === 'D') deleted++
    else if (code === 'M' || code === 'R' || code === 'C') modified++
  }
  const parts = [
    added ? `新增 ${added}` : '',
    modified ? `修改 ${modified}` : '',
    deleted ? `删除 ${deleted}` : ''
  ].filter(Boolean)
  return parts.join(' · ')
}

/** 快照的提交说明只要一行：谁、干了什么。多行的派活内容只取第一句 */
export function snapshotMessage(who: string, what: string): string {
  const line = what.split('\n').find((l) => l.trim()) ?? ''
  const trimmed = line.trim().slice(0, 80)
  return `${who}：${trimmed || '（无说明）'}`
}

export function createSnapshotStore(projectDir: string, git: GitRunner): SnapshotStore {
  const gitDir = join(projectDir, 'Saved', 'UEBoxSnapshots', '.git')
  const base = [
    `--git-dir=${gitDir}`,
    `--work-tree=${projectDir}`,
    '-c',
    'user.name=Unreal Box',
    '-c',
    'user.email=team@unrealbox.local',
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.quotepath=false'
  ]

  const run = async (args: string[]): Promise<string> => {
    const result = await git([...base, ...args], projectDir)
    if (result.code !== 0) {
      throw new Error(
        `git ${args[0]} 失败：${(result.stderr || result.stdout).trim().slice(0, 300)}`
      )
    }
    return result.stdout
  }

  let ready: Promise<void> | undefined
  const ensure = (): Promise<void> =>
    (ready ??= (async () => {
      const exists = await fs
        .access(join(gitDir, 'HEAD'))
        .then(() => true)
        .catch(() => false)
      if (exists) return
      await fs.mkdir(gitDir, { recursive: true })
      await run(['init', '--quiet'])
      await fs.mkdir(join(gitDir, 'info'), { recursive: true })
      await fs.writeFile(join(gitDir, 'info', 'exclude'), `${SNAPSHOT_EXCLUDES.join('\n')}\n`)
    })())

  return {
    async save(message) {
      await ensure()
      await run(['add', '--all', '--', '.'])
      const staged = await git([...base, 'diff', '--cached', '--quiet'], projectDir)
      const hasHead = (await git([...base, 'rev-parse', '--verify', 'HEAD'], projectDir)).code === 0
      if (staged.code === 0 && hasHead) return null
      // 标签要说「这一份里是什么」，不只是「谁触发的」—— 回滚时是照着它选的。
      // 2026-09-26 真机反馈：标签只有队员留言的开头，看到编号完全不知道那一份里有什么
      const changes = summarizeChanges(await run(['diff', '--cached', '--name-status']))
      const inventory = await contentInventory(projectDir, 0).catch(() => null)
      const subject = [message, changes, inventory ? formatCounts(inventory) : '']
        .filter(Boolean)
        .join('｜')
      await run(['commit', '--quiet', '--allow-empty', '-m', subject])
      const [latest] = await this.list(1)
      return latest ?? null
    },
    async list(limit = 20) {
      await ensure()
      const hasHead = (await git([...base, 'rev-parse', '--verify', 'HEAD'], projectDir)).code === 0
      if (!hasHead) return []
      const out = await run(['log', `-n${limit}`, '--format=%h%x09%ct%x09%s'])
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [id = '', at = '0', ...rest] = line.split('\t')
          return { id, at: Number(at) * 1000, message: rest.join('\t') }
        })
    },
    async restore(id) {
      await ensure()
      if (!/^[0-9a-f]{4,40}$/i.test(id)) throw new Error(`快照编号不对：${id}`)
      await run(['reset', '--hard', '--quiet', id])
      // 快照之后新建的源文件也要删掉，不然退回去的工程里还躺着新资产的半截引用。
      // 不带 -x：被排除的缓存、Saved 原样留着
      await run(['clean', '-fd', '--quiet'])
    }
  }
}
