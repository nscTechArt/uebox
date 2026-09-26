/**
 * 每个成员仓库一份的稀疏"影子工作副本"（设计 2.4）。
 *
 * - 放在 %LOCALAPPDATA%（不是漫游的 %APPDATA%）：它可能很大，而且随时可以删掉重建。
 * - 用 `lore clone --view <空视图>` 创建：几乎不拉任何东西（F-001：任何规模 ~0.25 秒）。
 * - 视图文件 `.lore/view` 是排除式的：第一行 `**` 排除一切，`!<路径>` 把某个文件放回来。
 * - **扩视图之后必须 `lore reset --targets <清单>`**：单纯 `lore sync` 什么都不物化（F-001）。
 * - 同一个副本上的 lore 调用串行执行；不同副本互不影响。
 *
 * 导入：同步到分支顶点 → 复制文件进来并加入视图 → `lore stage --targets` →
 * `lore commit` → `lore push`。移动文件时同时暂存两个路径，从不用跨目录的
 * `lore stage move`（V11：它提交时丢了删除）。
 */
import { promises as fs } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  runLoreChecked,
  runLore,
  isTransientLoreFailure,
  LoreCommandError,
  type LoreResult
} from './loreCli'

export interface ShadowTarget {
  serverId: string
  repositoryId: string
  branch: string
  /** 完整远端地址，例如 lores://host:8441/<repo> */
  remote: string
}

export interface ShadowContext {
  binary: string
  identityToken: () => Promise<string>
  caFile: string | null
  signal?: AbortSignal
}

const VIEW_HEADER = '**'

/** 仓库内路径统一成正斜杠、不带前导斜杠；拒绝 `..` 逃出副本 */
export function repoRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`Invalid repository path: ${path}`)
  }
  return normalized
}

/** 视图文件的内容 → 已放回的路径集合 */
export function parseView(text: string): Set<string> {
  const included = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('!')) included.add(line.slice(1))
  }
  return included
}

export function renderView(included: Iterable<string>): string {
  return `${[VIEW_HEADER, ...[...included].sort().map((path) => `!${path}`)].join('\n')}\n`
}

/** 仓库名里只留安全字符当目录名 */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || '_'
}

export class ShadowCopies {
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly root: string) {}

  dirFor(target: Pick<ShadowTarget, 'serverId' | 'repositoryId'>): string {
    return join(this.root, safeSegment(target.serverId), safeSegment(target.repositoryId))
  }

  private get storeDir(): string {
    return join(this.root, 'store')
  }

  private get tempDir(): string {
    return join(this.root, 'tmp')
  }

  /** 同一个副本上的操作排队 */
  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(work)
    this.queues.set(key, next)
    try {
      return await next
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key)
    }
  }

  private async lore(
    context: ShadowContext,
    cwd: string,
    args: string[],
    timeoutMs = 30 * 60_000
  ): Promise<LoreResult> {
    await fs.mkdir(this.tempDir, { recursive: true })
    let attempt = 0
    for (;;) {
      const identityToken = await context.identityToken()
      const result = await runLore(context.binary, args, {
        cwd,
        identityToken,
        caFile: context.caFile,
        signal: context.signal,
        timeoutMs,
        tempDir: this.tempDir
      })
      if (result.code === 0) return result
      if (attempt < 2 && isTransientLoreFailure(result) && !context.signal?.aborted) {
        attempt += 1
        await new Promise((done) => setTimeout(done, 2000))
        continue
      }
      throw new LoreCommandError(args, result)
    }
  }

  async exists(target: ShadowTarget): Promise<boolean> {
    try {
      await fs.access(join(this.dirFor(target), '.lore'))
      return true
    } catch {
      return false
    }
  }

  /** 没有就用空视图克隆一份 */
  async ensure(target: ShadowTarget, context: ShadowContext): Promise<string> {
    const dir = this.dirFor(target)
    if (await this.exists(target)) return dir
    await fs.mkdir(dirname(dir), { recursive: true })
    await fs.mkdir(this.storeDir, { recursive: true })
    // 上次克隆到一半留下的残骸先清掉
    await fs.rm(dir, { recursive: true, force: true })
    const viewFile = join(dirname(dir), `view-empty-${randomUUID()}.txt`)
    await fs.writeFile(viewFile, `${VIEW_HEADER}\n`, 'utf8')
    try {
      await this.lore(context, dirname(dir), [
        'clone',
        target.remote,
        dir,
        '--view',
        viewFile,
        '--branch',
        target.branch,
        '--use-shared-store',
        '--shared-store-path',
        this.storeDir
      ])
    } finally {
      await fs.rm(viewFile, { force: true })
    }
    return dir
  }

  private async readView(dir: string): Promise<Set<string>> {
    try {
      return parseView(await fs.readFile(join(dir, '.lore', 'view'), 'utf8'))
    } catch {
      return new Set()
    }
  }

  private async writeTargets(paths: string[]): Promise<string> {
    await fs.mkdir(this.tempDir, { recursive: true })
    const file = join(this.tempDir, `targets-${randomUUID()}.txt`)
    await fs.writeFile(file, `${paths.join('\n')}\n`, 'utf8')
    return file
  }

  /**
   * 把这些路径物化到副本里，返回本机绝对路径（顺序与输入一致，不存在的给 null）。
   * `revision` 给了就先把副本同步到那个修订（闭包是在固定修订上算的）。
   */
  async materialise(
    target: ShadowTarget,
    paths: string[],
    context: ShadowContext,
    revision?: string | null
  ): Promise<Array<string | null>> {
    const dir = await this.ensure(target, context)
    return await this.serial(dir, async () => {
      const wanted = paths.map(repoRelativePath)
      const view = await this.readView(dir)
      let widened = false
      for (const path of wanted) {
        if (!view.has(path)) {
          view.add(path)
          widened = true
        }
      }
      if (widened) await fs.writeFile(join(dir, '.lore', 'view'), renderView(view), 'utf8')
      await this.lore(context, dir, revision ? ['sync', revision] : ['sync'])
      const targets = await this.writeTargets(wanted)
      try {
        await this.lore(context, dir, ['reset', '--targets', targets])
      } finally {
        await fs.rm(targets, { force: true })
      }
      const out: Array<string | null> = []
      for (const path of wanted) {
        const local = resolve(dir, path)
        if (!local.startsWith(resolve(dir) + sep)) {
          out.push(null)
          continue
        }
        try {
          await fs.access(local)
          out.push(local)
        } catch {
          out.push(null)
        }
      }
      return out
    })
  }

  /**
   * 以美术本人身份导入：复制进副本 → 暂存 → 提交 → 推送。
   * files 的 target 是仓库内路径。返回提交输出里的修订签名（读得出来的话）。
   */
  async importFiles(
    target: ShadowTarget,
    files: Array<{ source: string; target: string }>,
    message: string,
    context: ShadowContext,
    onPhase?: (
      phase: 'syncing' | 'copying' | 'staging' | 'committing' | 'pushing',
      done: number,
      total: number
    ) => void
  ): Promise<{ signature: string | null; paths: string[] }> {
    const dir = await this.ensure(target, context)
    return await this.serial(dir, async () => {
      const paths = files.map((file) => repoRelativePath(file.target))
      onPhase?.('syncing', 0, files.length)
      await this.lore(context, dir, ['sync'])
      const view = await this.readView(dir)
      for (const path of paths) view.add(path)
      await fs.writeFile(join(dir, '.lore', 'view'), renderView(view), 'utf8')
      let copied = 0
      for (const file of files) {
        const destination = resolve(dir, repoRelativePath(file.target))
        if (!destination.startsWith(resolve(dir) + sep))
          throw new Error(`Invalid target ${file.target}`)
        await fs.mkdir(dirname(destination), { recursive: true })
        // 复制，不做硬链接：美术之后改工程里的文件不能连带改影子副本（设计 2.4 第 3 条）
        await fs.copyFile(file.source, destination)
        copied += 1
        onPhase?.('copying', copied, files.length)
      }
      onPhase?.('staging', copied, files.length)
      const targets = await this.writeTargets(paths)
      try {
        await this.lore(context, dir, ['stage', '--targets', targets])
      } finally {
        await fs.rm(targets, { force: true })
      }
      onPhase?.('committing', copied, files.length)
      const committed = await this.lore(context, dir, ['commit', message])
      onPhase?.('pushing', copied, files.length)
      await this.lore(context, dir, ['push', '--fast-forward-merge'])
      const signature = /Signature\s*:\s*([0-9a-f]{64})/i.exec(committed.stdout)?.[1] ?? null
      return { signature, paths }
    })
  }

  /** 状态（给诊断用） */
  async status(target: ShadowTarget, context: ShadowContext): Promise<string> {
    const dir = this.dirFor(target)
    const result = await runLoreChecked(context.binary, ['status'], {
      cwd: dir,
      identityToken: await context.identityToken(),
      caFile: context.caFile,
      tempDir: this.tempDir
    })
    return result.stdout
  }

  /** 整个副本删掉（设置里"清理本机副本"）；共享存储留着，别的副本还要用 */
  async remove(target: Pick<ShadowTarget, 'serverId' | 'repositoryId'>): Promise<void> {
    await fs.rm(this.dirFor(target), { recursive: true, force: true })
  }
}
