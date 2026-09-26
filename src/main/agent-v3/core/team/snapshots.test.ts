/** @vitest-environment node */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSnapshotStore, snapshotMessage, type GitRunner } from './snapshots'

/**
 * 用真 git 跑：快照要证明的是「退回去之后磁盘上真的是那一份」，打桩证明不了。
 * 这台机器没有 git 就整组跳过。
 */

const git: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })

const hasGit = await git(['--version'], tmpdir()).then((r) => r.code === 0)

describe.skipIf(!hasGit)('工程快照', () => {
  let project: string
  const write = (rel: string, text: string): void => {
    const full = join(project, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  const read = (rel: string): string => readFileSync(join(project, rel), 'utf8')

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'uebox-snap-'))
    write('TD.uproject', '{"EngineAssociation":"5.8"}')
    write('Content/Maps/Main.umap', 'v1')
    write('Config/DefaultGame.ini', '[a]')
    write('Saved/Logs/TD.log', 'log')
    write('Binaries/Win64/TD.dll', 'bin')
  })
  afterEach(() => rmSync(project, { recursive: true, force: true }))

  it('存、没变化就不存、改了再存；只收源文件，不碰工程自己的 git', async () => {
    const store = createSnapshotStore(project, git)
    const first = await store.save('开工')
    // 标签说清「这一份里是什么」：谁触发的、改了几个文件、工程里有什么
    expect(first?.message).toBe('开工｜新增 3｜共 1 · 关卡 1')
    expect(await store.save('什么都没改')).toBeNull()

    write('Content/Maps/Main.umap', 'v2')
    const second = await store.save(snapshotMessage('地编', '改关卡\n细节…'))
    expect(second?.message).toBe('地编：改关卡｜修改 1｜共 1 · 关卡 1')
    expect((await store.list()).map((s) => s.message.split('｜')[0])).toEqual([
      '地编：改关卡',
      '开工'
    ])

    // 工程根目录下没有冒出一个 .git
    expect(existsSync(join(project, '.git'))).toBe(false)
    const tracked = await git(
      [`--git-dir=${join(project, 'Saved', 'UEBoxSnapshots', '.git')}`, 'ls-files'],
      project
    )
    expect(tracked.stdout).not.toMatch(/Saved|Binaries/)
  })

  it('退回去：改过的恢复、新建的删掉、缓存和 Saved 原样留着', async () => {
    const store = createSnapshotStore(project, git)
    const first = await store.save('开工')
    write('Content/Maps/Main.umap', 'broken')
    write('Content/New/Hero.uasset', 'new')
    write('Saved/Logs/TD.log', 'later log')
    await store.save('改坏了')

    await store.restore(first!.id)
    expect(read('Content/Maps/Main.umap')).toBe('v1')
    expect(existsSync(join(project, 'Content/New/Hero.uasset'))).toBe(false)
    expect(read('Saved/Logs/TD.log')).toBe('later log')
    expect(read('Binaries/Win64/TD.dll')).toBe('bin')
  })

  it('退回之后还能反悔：之后的快照都还在，再退回去一次就回来了', async () => {
    const store = createSnapshotStore(project, git)
    const first = await store.save('开工')
    write('Content/New/Hero.uasset', 'new')
    const later = await store.save('加了英雄')

    const restored = await store.restore(first!.id)
    expect(existsSync(join(project, 'Content/New/Hero.uasset'))).toBe(false)
    expect(restored?.message).toContain('退回快照')
    // 退回是叠上去的一份，之前那份还在列表里
    expect((await store.list()).map((s) => s.id)).toContain(later!.id)

    await store.restore(later!.id)
    expect(read('Content/New/Hero.uasset')).toBe('new')
  })

  it('编号对不上任何一份就报错 —— 回滚前用它确认，不白关编辑器', async () => {
    const store = createSnapshotStore(project, git)
    const first = await store.save('开工')
    expect(await store.resolve(first!.id)).toMatch(/^[0-9a-f]{40}$/)
    await expect(store.resolve('abc')).rejects.toThrow(/编号不对/)
    await expect(store.resolve('deadbeef')).rejects.toThrow(/没有快照/)
  })

  it('几个队员同时交活，一起存快照不会撞 git 的锁', async () => {
    const store = createSnapshotStore(project, git)
    await store.save('开工')
    write('Content/A.uasset', 'a')
    write('Content/B.uasset', 'b')
    const results = await Promise.all([store.save('甲'), store.save('乙'), store.save('丙')])
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1)
  })

  it('快照编号不像编号就拒绝，不拿它拼命令', async () => {
    const store = createSnapshotStore(project, git)
    await store.save('开工')
    await expect(store.restore('HEAD; rm -rf /')).rejects.toThrow(/编号不对/)
  })
})
