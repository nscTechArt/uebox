/**
 * 这些函数里有 `rm -rf` 和 `rename`，所以拿**真实临时目录**测，不打桩 fs ——
 * 打桩测出来的「删对了」只证明桩写对了。
 *
 * 重点不是「正常路径能跑通」，而是**坏路径必须动不了磁盘**：
 * commit eb974c9 那次就是路径塌缩成一节，`rm -rf` 差点落到网络库根目录下的
 * 同名目录上。所以每一条拒绝分支都要有测试，而且要断言「目标还在」。
 */
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createPackage,
  deletePackage,
  readPackage,
  readPackageFile,
  renamePackage,
  scanPackages,
  updatePackage,
  writePackageFile,
  type LibraryPackageEntry
} from './libraryPackageStore'

const NOW = 1700000000000

let root: string
/** 保管库的**外面**。越界测试要往这里打，断言它毫发无伤。 */
let outside: string

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ub-pkg-'))
  root = join(base, 'vault')
  outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
})

afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true })
})

async function makeBlueprint(name: string, parentRelPath?: string): Promise<LibraryPackageEntry> {
  const entry = await createPackage(root, {
    library: 'blueprint',
    id: `id-${name}`,
    name,
    payload: { nodes: [name] },
    now: NOW,
    parentRelPath
  })
  if (!entry) throw new Error(`建包失败: ${name}`)
  return entry
}

describe('createPackage', () => {
  it('建出目录和清单，名字带扩展名', async () => {
    const entry = await makeBlueprint('跳跃逻辑')

    expect(entry.relPath).toBe('跳跃逻辑.ueblueprint')
    expect(existsSync(entry.dirPath)).toBe(true)

    const text = await readFile(join(entry.dirPath, 'blueprint.json'), 'utf-8')
    expect(JSON.parse(text)).toMatchObject({
      format: 'unreal-box-blueprint',
      id: 'id-跳跃逻辑',
      name: '跳跃逻辑',
      payload: { nodes: ['跳跃逻辑'] }
    })
  })

  it('重名自动加序号，不覆盖已有的包', async () => {
    const first = await makeBlueprint('跳跃逻辑')
    const second = await createPackage(root, {
      library: 'blueprint',
      id: 'id-2',
      name: '跳跃逻辑',
      payload: { nodes: ['second'] },
      now: NOW
    })

    expect(second?.relPath).toBe('跳跃逻辑 (2).ueblueprint')
    // 第一个原封不动
    const firstManifest = await readPackage(root, first.dirPath)
    expect(firstManifest && 'manifest' in firstManifest && firstManifest.manifest.id).toBe(
      'id-跳跃逻辑'
    )
  })

  it('能建在子目录里 —— 包就是资产，用户会在资产库里整理它', async () => {
    const entry = await makeBlueprint('移动', '角色/基础')
    expect(entry.relPath).toBe('角色/基础/移动.ueblueprint')
  })

  it('父目录越界时拒绝，且不在外面留下任何东西', async () => {
    const entry = await createPackage(root, {
      library: 'blueprint',
      id: 'x',
      name: '坏东西',
      payload: {},
      now: NOW,
      parentRelPath: '../outside'
    })

    expect(entry).toBeNull()
    expect(await readdir(outside)).toEqual([])
  })
})

describe('scanPackages', () => {
  it('找得到根目录和子目录里的包', async () => {
    await makeBlueprint('A')
    await makeBlueprint('B', '角色/基础')

    const { entries, problems } = await scanPackages(root)

    expect(problems).toEqual([])
    expect(entries.map((e) => e.relPath).sort()).toEqual([
      'A.ueblueprint',
      '角色/基础/B.ueblueprint'
    ])
  })

  it('不递归进包 —— 包里的 cover.png 和 textures/ 属于这个包，不是独立内容', async () => {
    const entry = await makeBlueprint('带贴图的')
    await mkdir(join(entry.dirPath, 'textures'), { recursive: true })
    await writeFile(join(entry.dirPath, 'textures', 'moss.png'), 'x')
    // 包里再放一个「看起来像包」的目录，扫描不该看见它
    await mkdir(join(entry.dirPath, '内嵌.ueblueprint'), { recursive: true })

    const { entries } = await scanPackages(root)
    expect(entries.map((e) => e.relPath)).toEqual(['带贴图的.ueblueprint'])
  })

  it('手动拷进来的包也认 —— 这是「磁盘是唯一真相源」的试金石', async () => {
    const dirPath = join(root, '别人给的.ueblueprint')
    await mkdir(dirPath, { recursive: true })
    await writeFile(
      join(dirPath, 'blueprint.json'),
      JSON.stringify({
        format: 'unreal-box-blueprint',
        formatVersion: 1,
        id: 'from-friend',
        name: '别人给的',
        createdAt: NOW,
        updatedAt: NOW,
        cover: '',
        payload: { nodes: [] }
      })
    )

    const { entries } = await scanPackages(root)
    expect(entries).toHaveLength(1)
    expect(entries[0].manifest.id).toBe('from-friend')
  })

  it('两个库一起扫，各自认出来', async () => {
    await makeBlueprint('蓝图')
    await createPackage(root, {
      library: 'material',
      id: 'm1',
      name: '苔藓',
      payload: {},
      now: NOW
    })

    const { entries } = await scanPackages(root)
    expect(entries.map((e) => e.library).sort()).toEqual(['blueprint', 'material'])
  })

  it('跳过点开头的目录 —— .thumbnails / .migration-backups 是保管库自己的东西', async () => {
    await mkdir(join(root, '.migration-backups', '旧的.ueblueprint'), { recursive: true })

    const { entries, problems } = await scanPackages(root)
    expect(entries).toEqual([])
    expect(problems).toEqual([])
  })

  it('坏包报成 problem，而不是默默消失 —— 用户得知道哪个包坏了', async () => {
    await mkdir(join(root, '没清单.ueblueprint'), { recursive: true })

    const broken = join(root, '清单坏了.ueblueprint')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'blueprint.json'), '{ 不是 JSON')

    const { entries, problems } = await scanPackages(root)
    expect(entries).toEqual([])
    expect(problems.map((p) => [p.relPath, p.reason]).sort()).toEqual([
      ['没清单.ueblueprint', 'manifest-missing'],
      ['清单坏了.ueblueprint', 'manifest-invalid']
    ])
  })

  it('保管库不存在时返回空，不抛', async () => {
    const result = await scanPackages(join(root, '不存在'))
    expect(result).toEqual({ entries: [], problems: [] })
  })
})

describe('updatePackage', () => {
  it('改 payload 和时间戳，不动目录名', async () => {
    const entry = await makeBlueprint('跳跃')
    const updated = await updatePackage(root, entry.dirPath, {
      payload: { nodes: ['改过了'] },
      now: NOW + 5000
    })

    expect(updated?.manifest.payload).toEqual({ nodes: ['改过了'] })
    expect(updated?.manifest.updatedAt).toBe(NOW + 5000)
    expect(updated?.manifest.createdAt).toBe(NOW)
    expect(updated?.relPath).toBe('跳跃.ueblueprint')
  })

  it('写清单是原子的：改完之后立刻读得到完整内容', async () => {
    const entry = await makeBlueprint('跳跃')
    await updatePackage(root, entry.dirPath, { payload: { v: 2 }, now: NOW + 1 })

    const reread = await readPackage(root, entry.dirPath)
    expect(reread && 'manifest' in reread && reread.manifest.payload).toEqual({ v: 2 })
    // 临时文件不该留在包里
    expect(await readdir(entry.dirPath)).toEqual(['blueprint.json'])
  })

  it('封面路径想往外爬时整个拒绝', async () => {
    const entry = await makeBlueprint('跳跃')
    const updated = await updatePackage(root, entry.dirPath, {
      cover: '../../偷看.png',
      now: NOW + 1
    })
    expect(updated).toBeNull()
  })

  it('清单坏掉的包不给改 —— 改了等于拿默认值把用户数据盖掉', async () => {
    const dirPath = join(root, '坏的.ueblueprint')
    await mkdir(dirPath, { recursive: true })
    await writeFile(join(dirPath, 'blueprint.json'), 'garbage')

    expect(await updatePackage(root, dirPath, { payload: {}, now: NOW })).toBeNull()
  })
})

describe('renamePackage', () => {
  it('目录跟着改名，清单里的 name 也改', async () => {
    const entry = await makeBlueprint('旧名字')
    const renamed = await renamePackage(root, entry.dirPath, '新名字', NOW + 1)

    expect(renamed?.relPath).toBe('新名字.ueblueprint')
    expect(renamed?.manifest.name).toBe('新名字')
    expect(existsSync(entry.dirPath)).toBe(false)
    expect(existsSync(renamed!.dirPath)).toBe(true)
  })

  it('改成已存在的名字时加序号，不覆盖别人', async () => {
    await makeBlueprint('占位')
    const entry = await makeBlueprint('待改')

    const renamed = await renamePackage(root, entry.dirPath, '占位', NOW + 1)
    expect(renamed?.relPath).toBe('占位 (2).ueblueprint')
    expect(existsSync(join(root, '占位.ueblueprint'))).toBe(true)
  })

  it('名字洗完没变化时不做无谓的移动', async () => {
    const entry = await makeBlueprint('稳定')
    const renamed = await renamePackage(root, entry.dirPath, '稳定', NOW + 1)
    expect(renamed?.dirPath).toBe(entry.dirPath)
  })
})

describe('deletePackage —— 每一条拒绝分支都要断言目标还在', () => {
  it('正常删掉一个包，连同里面的东西', async () => {
    const entry = await makeBlueprint('要删的')
    await writeFile(join(entry.dirPath, 'cover.png'), 'x')

    expect(await deletePackage(root, entry.dirPath)).toBe(true)
    expect(existsSync(entry.dirPath)).toBe(false)
  })

  it('拒绝删保管库根目录本身', async () => {
    await makeBlueprint('还在')
    expect(await deletePackage(root, root)).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it('拒绝删普通目录 —— 名字不是包名就绝不动手', async () => {
    const plain = join(root, 'Textures')
    await mkdir(plain, { recursive: true })
    await writeFile(join(plain, 'a.png'), 'x')

    expect(await deletePackage(root, plain)).toBe(false)
    expect(existsSync(join(plain, 'a.png'))).toBe(true)
  })

  it('拒绝删保管库外面的东西，哪怕名字长得像包', async () => {
    const evil = join(outside, '外面的.ueblueprint')
    await mkdir(evil, { recursive: true })
    await writeFile(join(evil, 'blueprint.json'), '{}')

    expect(await deletePackage(root, evil)).toBe(false)
    expect(existsSync(evil)).toBe(true)
  })

  it('拒绝用 .. 爬出保管库', async () => {
    const evil = join(outside, '外面的.ueblueprint')
    await mkdir(evil, { recursive: true })

    expect(await deletePackage(root, join(root, '..', 'outside', '外面的.ueblueprint'))).toBe(false)
    expect(existsSync(evil)).toBe(true)
  })

  it('拒绝兄弟目录 —— 前缀相同不等于在里面', async () => {
    // root 叫 .../vault，这个叫 .../vaultXXX：裸 startsWith 会把它判成「在里面」
    const sibling = `${root}XXX`
    const evil = join(sibling, '兄弟.ueblueprint')
    await mkdir(evil, { recursive: true })

    expect(await deletePackage(root, evil)).toBe(false)
    expect(existsSync(evil)).toBe(true)
  })

  it('本来就不存在时返回 false，不抛', async () => {
    expect(await deletePackage(root, join(root, '没有的.ueblueprint'))).toBe(false)
  })
})

describe('包内文件读写', () => {
  it('写得进、读得出封面', async () => {
    const entry = await makeBlueprint('带封面')
    expect(await writePackageFile(root, entry.dirPath, 'cover.png', Buffer.from('PNG'))).toBe(true)
    expect((await readPackageFile(root, entry.dirPath, 'cover.png'))?.toString()).toBe('PNG')
  })

  it('子目录自动建出来 —— 材质以后要往 textures/ 里放贴图', async () => {
    const entry = await makeBlueprint('带贴图')
    expect(
      await writePackageFile(root, entry.dirPath, 'textures/moss.png', Buffer.from('IMG'))
    ).toBe(true)
    expect(existsSync(join(entry.dirPath, 'textures', 'moss.png'))).toBe(true)
  })

  it('拒绝写到包外面，且外面确实没被写出东西', async () => {
    const entry = await makeBlueprint('老实的')
    expect(
      await writePackageFile(root, entry.dirPath, '../../outside/坏.png', Buffer.from('BAD'))
    ).toBe(false)
    expect(await readdir(outside)).toEqual([])
  })

  it('拒绝读包外面的东西', async () => {
    const entry = await makeBlueprint('老实的')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    expect(await readPackageFile(root, entry.dirPath, '../../outside/secret.txt')).toBeNull()
  })

  it('读不存在的文件返回 null，不抛', async () => {
    const entry = await makeBlueprint('空的')
    expect(await readPackageFile(root, entry.dirPath, 'cover.png')).toBeNull()
  })
})
