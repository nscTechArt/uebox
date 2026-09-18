/**
 * `scanEngines()` 的 `degraded`：这一趟读成没读成。
 *
 * 这是整批改动的核心契约，之前一条测试都没有 —— 于是它连着两轮都被修在了错的
 * 层上：第一次以为 `success:false` 能兜住（主进程根本不回这个），第二次以为
 * `collectEngines()` 会抛（两个读函数早把自己的异常吞了）。真正决定 degraded 的
 * 是每个来源自己报的 `ok`，所以测试从文件系统那一层灌进去。
 *
 * 判据只有一条：**「读成了，一个都没有」和「压根没读到」必须分得开**。
 * 分不开的话，界面会对着装了四个引擎的用户说「没有找到已安装的虚幻引擎」，
 * Agent 会直接告诉模型这台机器没装引擎，而首页还会顺手删掉用户存的默认引擎。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home' } }))
vi.mock('../sqliteDataBase', () => ({ getPublicDatabase: () => null }))
vi.mock('../sqliteDataBase/models/customEngine', () => ({
  addCustomEngine: vi.fn(),
  getAllCustomEngines: vi.fn(() => []),
  removeCustomEngine: vi.fn()
}))

const { readFile, readdir } = vi.hoisted(() => ({ readFile: vi.fn(), readdir: vi.fn() }))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, promises: { ...actual.promises, readFile, readdir } }
})

// 引擎可执行文件一律当作存在，否则 filterExistingEngines 会把结果全滤掉
vi.mock('./unrealEnginePlatform', () => ({
  discoverMacEngineRoots: vi.fn(async () => []),
  normalizeEngineRoot: (p: string) => p,
  readEngineBuildVersion: vi.fn(async () => null),
  resolveEngineExecutable: vi.fn(async (root: string) => `${root}/UnrealEditor.exe`)
}))
vi.mock('./macEngineInstallations', () => ({
  registeredMacEngineRoots: vi.fn(async () => []),
  resolveMacEngineAssociation: vi.fn(async () => null)
}))

/**
 * 每条用例都重新 import 一次模块。
 *
 * `cacheEngines` 是模块级单例，上一条用例读成功之后它就是热的，下一条读失败时
 * 会命中「读不出来就用上次结果」那条兜底，断言就跟用例顺序绑死了。
 */
async function freshUtil(): Promise<typeof import('./UnrealPathManager').default> {
  vi.resetModules()
  return (await import('./UnrealPathManager')).default
}

/**
 * Epic 的两份记录：manifest 目录一个 .item，汇总文件一个条目。
 *
 * 用 Buffer 而不是字符串：这两份文件现在经 readUeTextFile 读（不传编码，拿到的是
 * 原始字节，编码按 BOM 判）—— 引擎和启动器写的文件可能是 UTF-16，见 utils/ueTextFile.ts。
 */
const MANIFEST = Buffer.from(
  JSON.stringify({
    AppName: 'UE_5.5',
    AppVersionString: '5.5.4',
    InstallLocation: 'C:/UE_5.5'
  })
)
const EMPTY_INSTALLED_DAT = Buffer.from(JSON.stringify({ InstallationList: [] }))

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}
function eacces(): NodeJS.ErrnoException {
  return Object.assign(new Error('EACCES'), { code: 'EACCES' })
}

describe('scanEngines 的 degraded', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readdir.mockReset()
    readFile.mockReset()
  })

  it('两份记录都读到了 —— degraded=false', async () => {
    readdir.mockResolvedValue(['UE_5.5.item'])
    readFile.mockImplementation(async (p: string) =>
      String(p).endsWith('.item') ? MANIFEST : EMPTY_INSTALLED_DAT
    )

    const { engines, degraded } = await (await freshUtil()).scanEngines()
    expect(degraded).toBe(false)
    expect(engines.map((e) => e.version)).toEqual(['5.5'])
  })

  /*
   * 这条是主菜。没装启动器（ENOENT）和读不了（EACCES）都会让两个读函数回空数组，
   * 但含义天差地别 —— 前者是「真的没有」，后者是「这次没读到」。
   */
  it('文件不存在 = 没装启动器，不算降级', async () => {
    readdir.mockRejectedValue(enoent())
    readFile.mockRejectedValue(enoent())

    const { engines, degraded } = await (await freshUtil()).scanEngines()
    expect(degraded).toBe(false)
    expect(engines).toEqual([])
  })

  it('权限读不了 = 降级，哪怕结果同样是空的', async () => {
    readdir.mockRejectedValue(eacces())
    readFile.mockRejectedValue(eacces())

    const { degraded } = await (await freshUtil()).scanEngines()
    expect(degraded).toBe(true)
  })

  it('只有一份读不了也算降级', async () => {
    readdir.mockResolvedValue(['UE_5.5.item'])
    readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith('.item')) return MANIFEST
      throw eacces() // LauncherInstalled.dat 读不了
    })

    const { engines, degraded } = await (await freshUtil()).scanEngines()
    expect(degraded).toBe(true)
    // 读到的那部分照样要给出去 —— 界面靠它避免显示成「一个都没有」
    expect(engines.map((e) => e.version)).toEqual(['5.5'])
  })

  it('单个 manifest 读不了：跳过它，但这一趟不能自称读全了', async () => {
    readdir.mockResolvedValue(['UE_5.5.item', 'UE_5.6.item'])
    readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith('UE_5.5.item')) return MANIFEST
      if (String(p).endsWith('UE_5.6.item')) throw eacces()
      return EMPTY_INSTALLED_DAT
    })

    const { engines, degraded } = await (await freshUtil()).scanEngines()
    expect(degraded).toBe(true)
    expect(engines.map((e) => e.version)).toEqual(['5.5'])
  })

  it('findUnrealEnginePaths 仍然只回列表，不受影响', async () => {
    readdir.mockResolvedValue(['UE_5.5.item'])
    readFile.mockImplementation(async (p: string) =>
      String(p).endsWith('.item') ? MANIFEST : EMPTY_INSTALLED_DAT
    )

    const engines = await (await freshUtil()).findUnrealEnginePaths()
    expect(engines.map((e) => e.version)).toEqual(['5.5'])
  })
})
