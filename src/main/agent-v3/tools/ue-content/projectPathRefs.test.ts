/**
 * @vitest-environment node
 *
 * 工程文本引用扫描。守的是设计 §3.4 的匹配规则和 §3.5 的边界：
 *   1. 归一化 —— .Name 后缀、_C、尾斜杠都不影响命中；建议文本把后缀一起改对
 *   2. 目录目标 —— 目录本身和底下的东西都算
 *   3. 编码 —— UTF-16 LE 带 BOM 的 ini 必须能扫到；二进制跳过、不报错
 *   4. 范围 —— Intermediate 等生成目录不进；不在 scope 里的文件不读
 *   5. 上限 —— 命中数 / 文件数撞顶要标 truncated
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let boundProject: string | undefined

vi.mock('../../../services', () => ({
  serviceManager: { getWebSocketService: () => ({}) }
}))
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1',
  getTargetProjectPath: () => boundProject
}))

import {
  CANDIDATE_NOTE,
  buildTargets,
  decodeProjectText,
  deriveMountRoots,
  normalizePackage,
  projectPathRefsTool,
  resolveProjectDir,
  scanProjectPathRefs
} from './projectPathRefs'

let projectDir = ''

function write(relative: string, content: string | Buffer): void {
  const file = join(projectDir, relative)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** 虚幻自己保存 ini 的常见形态：UTF-16 LE 带 BOM */
function utf16le(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

const CPP_LINE =
  'ConstructorHelpers::FClassFinder<APawn> PlayerPawnBPClass(TEXT("/Game/ThirdPerson/Blueprints/BP_ThirdPersonCharacter"));'

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ua-path-refs-'))
  write(
    'Demo.uproject',
    JSON.stringify({ FileVersion: 3, Plugins: [{ Name: 'PaperZD', Enabled: true }] })
  )
  write(
    'Source/X/XGameMode.cpp',
    [
      CPP_LINE,
      'static ConstructorHelpers::FClassFinder<AActor> Cls(TEXT("/Game/A/BP_X.BP_X_C"));',
      'const FString DiskPath = TEXT("C:/Projects/Game/NotAPath");',
      'const FString Both = TEXT("A=/Game/Dup;B=/Game/Dup");',
      ''
    ].join('\r\n')
  )
  write(
    'Config/DefaultEngine.ini',
    utf16le(
      [
        '[/Script/EngineSettings.GameMapsSettings]',
        'GameDefaultMap=/Game/ThirdPerson/Maps/ThirdPersonMap.ThirdPersonMap',
        ''
      ].join('\r\n')
    )
  )
  write(
    'Config/DefaultGame.ini',
    [
      '[/Script/Engine.AssetManagerSettings]',
      '+PrimaryAssetTypesToScan=(PrimaryAssetType="Map",AssetBaseClass="/Script/Engine.World",Directories=((Path="/Game/Maps")))',
      'MapToLoad=/Game/Maps/Lobby.Lobby',
      ''
    ].join('\n')
  )
  write('Plugins/Foo/Foo.uplugin', '{ "FileVersion": 3, "CanContainContent": true }')
  write('Plugins/Foo/Config/DefaultFoo.ini', 'Thing=/Foo/Things/T_Thing\n')
  // 生成目录：里面有一模一样的命中，但绝不能报出来
  write('Intermediate/junk.cpp', `${CPP_LINE}\n`)
  write('Intermediate/Junk/Junk.uplugin', '{}')
  // 在扫描范围里但是二进制：.uasset 的魔数后面全是 NUL，偶数位也有
  write(
    'Content/Data/DT_Junk.csv',
    Buffer.concat([Buffer.from([0xc1, 0x83, 0x2a, 0x9e]), Buffer.alloc(200, 0)])
  )
  // 不在扫描范围里的二进制：连读都不该读
  write('Content/Foo.uasset', Buffer.concat([Buffer.from('/Game/Dup'), Buffer.alloc(64, 0)]))
})

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

describe('归一化与目标构造', () => {
  it('去掉 .Name 后缀、尾斜杠和 _C', () => {
    expect(normalizePackage('/Game/A/BP_X.BP_X_C')).toBe('/Game/A/BP_X')
    expect(normalizePackage('/Game/A/BP_X_C')).toBe('/Game/A/BP_X')
    expect(normalizePackage(' /Game/Maps/ ')).toBe('/Game/Maps')
  })

  it('paths：以 / 结尾的当目录，其余当资产', () => {
    expect(buildTargets({ paths: ['/Game/Maps/', '/Game/A/BP_X.BP_X'] })).toEqual([
      { package: '/Game/Maps', isFolder: true },
      { package: '/Game/A/BP_X', isFolder: false }
    ])
  })

  it('moves：目录形式的目标保留原名，否则最后一段是新名字', () => {
    expect(
      buildTargets({
        moves: [
          { source: '/Game/A/BP_X', destination: '/Game/B/' },
          { source: '/Game/A/BP_Y.BP_Y', destination: '/Game/B/BP_Z' }
        ],
        folder_moves: [{ source_folder: '/Game/Maps/', destination_folder: '/Game/Levels' }]
      })
    ).toEqual([
      { package: '/Game/A/BP_X', isFolder: false, replacement: '/Game/B/BP_X' },
      { package: '/Game/A/BP_Y', isFolder: false, replacement: '/Game/B/BP_Z' },
      { package: '/Game/Maps', isFolder: true, replacement: '/Game/Levels' }
    ])
  })

  it('空的和重复的不进目标', () => {
    expect(buildTargets({ paths: ['', '  ', '/Game/A', '/game/a.A'] })).toHaveLength(1)
  })

  it('.uproject 路径取所在目录', () => {
    expect(resolveProjectDir('D:/XG/BIKEOUT/BIKEOUT.uproject')).toBe('D:/XG/BIKEOUT')
    expect(resolveProjectDir('D:/XG/BIKEOUT')).toBe('D:/XG/BIKEOUT')
  })
})

describe('编码识别', () => {
  it('UTF-8 BOM 去掉，UTF-16 两种字节序都能读', () => {
    expect(decodeProjectText(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('a')
    expect(decodeProjectText(utf16le('a=b'))).toBe('a=b')
    const be = Buffer.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x3d, 0x00, 0x62])
    expect(decodeProjectText(be)).toBe('a=b')
  })

  it('没 BOM 的 UTF-16 LE 按 NUL 分布认出来；NUL 两边都有的是二进制', () => {
    expect(decodeProjectText(Buffer.from('Map=/Game/X\r\n', 'utf16le'))).toBe('Map=/Game/X\r\n')
    expect(decodeProjectText(Buffer.alloc(64, 0))).toBeUndefined()
    expect(decodeProjectText(Buffer.from('plain'))).toBe('plain')
  })
})

describe('挂载根', () => {
  it('Game、Engine 之外，从 .uplugin 和 .uproject 推插件名，生成目录里的不算', async () => {
    const roots = await deriveMountRoots(projectDir)
    expect(roots).toEqual(['Game', 'Engine', 'Foo', 'PaperZD'])
    expect(roots).not.toContain('Junk')
  })
})

describe('scanProjectPathRefs', () => {
  it('C++ 里的精确命中，文件路径相对工程根、正斜杠，建议文本把整行改好', async () => {
    const result = await scanProjectPathRefs(
      projectDir,
      buildTargets({
        moves: [
          {
            source: '/Game/ThirdPerson/Blueprints/BP_ThirdPersonCharacter',
            destination: '/Game/Characters/BP_Player'
          }
        ]
      })
    )
    expect(result.hits).toHaveLength(1)
    const [hit] = result.hits
    expect(hit.file).toBe('Source/X/XGameMode.cpp')
    expect(hit.line).toBe(1)
    expect(hit.kind).toBe('exact')
    expect(hit.token).toBe('/Game/ThirdPerson/Blueprints/BP_ThirdPersonCharacter')
    expect(hit.suggested_token).toBe('/Game/Characters/BP_Player')
    expect(hit.suggested_line).toContain('TEXT("/Game/Characters/BP_Player")')
    expect(hit.text).toBe(CPP_LINE)
    expect(result.note).toBe(CANDIDATE_NOTE)
    expect(result.truncated).toBe(false)
  })

  it('UTF-16 ini 里的命中，.Name 后缀跟着新名字一起改', async () => {
    const result = await scanProjectPathRefs(
      projectDir,
      buildTargets({
        moves: [
          {
            source: '/Game/ThirdPerson/Maps/ThirdPersonMap',
            destination: '/Game/Levels/MainMap'
          }
        ]
      })
    )
    expect(result.hits).toHaveLength(1)
    const [hit] = result.hits
    expect(hit.file).toBe('Config/DefaultEngine.ini')
    expect(hit.line).toBe(2)
    expect(hit.token).toBe('/Game/ThirdPerson/Maps/ThirdPersonMap.ThirdPersonMap')
    expect(hit.suggested_token).toBe('/Game/Levels/MainMap.MainMap')
    expect(hit.suggested_line).toBe('GameDefaultMap=/Game/Levels/MainMap.MainMap')
  })

  it('_C 归一化：BP_X.BP_X_C 命中 /Game/A/BP_X，建议里保留 _C', async () => {
    const kept = await scanProjectPathRefs(
      projectDir,
      buildTargets({ moves: [{ source: '/Game/A/BP_X', destination: '/Game/B/' }] })
    )
    expect(kept.hits).toHaveLength(1)
    expect(kept.hits[0].token).toBe('/Game/A/BP_X.BP_X_C')
    expect(kept.hits[0].package).toBe('/Game/A/BP_X')
    expect(kept.hits[0].suggested_token).toBe('/Game/B/BP_X.BP_X_C')

    const renamed = await scanProjectPathRefs(
      projectDir,
      buildTargets({ moves: [{ source: '/Game/A/BP_X', destination: '/Game/B/BP_Y' }] })
    )
    expect(renamed.hits[0].suggested_token).toBe('/Game/B/BP_Y.BP_Y_C')
  })

  it('目录搬迁：目录本身和底下的资产都命中，只换前缀', async () => {
    const result = await scanProjectPathRefs(
      projectDir,
      buildTargets({
        folder_moves: [{ source_folder: '/Game/Maps', destination_folder: '/Game/Levels' }]
      })
    )
    const byToken = new Map(result.hits.map((h) => [h.token, h]))
    const folderItself = byToken.get('/Game/Maps')
    expect(folderItself?.file).toBe('Config/DefaultGame.ini')
    expect(folderItself?.kind).toBe('exact')
    expect(folderItself?.suggested_token).toBe('/Game/Levels')
    expect(folderItself?.suggested_line).toContain('Directories=((Path="/Game/Levels"))')

    const inside = byToken.get('/Game/Maps/Lobby.Lobby')
    expect(inside?.kind).toBe('folder')
    expect(inside?.target).toBe('/Game/Maps')
    expect(inside?.suggested_token).toBe('/Game/Levels/Lobby.Lobby')
    expect(result.hits).toHaveLength(2)
  })

  it('插件挂载根：/Foo/… 在插件 ini 里能命中，paths 不给替换就没有建议', async () => {
    const result = await scanProjectPathRefs(
      projectDir,
      buildTargets({ paths: ['/Foo/Things/T_Thing'] })
    )
    expect(result.mount_roots).toContain('Foo')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].file).toBe('Plugins/Foo/Config/DefaultFoo.ini')
    expect(result.hits[0].suggested_token).toBeUndefined()
    expect(result.hits[0].suggested_line).toBeUndefined()
  })

  it('磁盘路径里的 /Game/ 不算包路径', async () => {
    const result = await scanProjectPathRefs(
      projectDir,
      buildTargets({ paths: ['/Game/NotAPath'] })
    )
    expect(result.hits).toHaveLength(0)
  })

  it('同一行同一个 token 只报一次，建议行把两处都换掉', async () => {
    const result = await scanProjectPathRefs(
      projectDir,
      buildTargets({ moves: [{ source: '/Game/Dup', destination: '/Game/New/Dup' }] })
    )
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].suggested_line).toBe(
      'const FString Both = TEXT("A=/Game/New/Dup;B=/Game/New/Dup");'
    )
  })

  it('生成目录不扫；范围外的 .uasset 不读；范围内的二进制跳过并计数', async () => {
    const result = await scanProjectPathRefs(
      projectDir,
      buildTargets({ paths: ['/Game/ThirdPerson/Blueprints/BP_ThirdPersonCharacter', '/Game/Dup'] })
    )
    expect(result.hits.some((h) => h.file.startsWith('Intermediate/'))).toBe(false)
    expect(result.hits.some((h) => h.file.endsWith('.uasset'))).toBe(false)
    // Demo.uproject、XGameMode.cpp、两个 Config ini、插件 ini = 5 个文本文件
    expect(result.scanned_files).toBe(5)
    expect(result.skipped_files).toBe(1)
  })

  it('命中数撞顶：截断并标 truncated', async () => {
    const result = await scanProjectPathRefs(
      projectDir,
      buildTargets({ folder_moves: [{ source_folder: '/Game', destination_folder: '/Game/X' }] }),
      { maxHits: 1 }
    )
    expect(result.hits).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('文件数撞顶：只扫前几个并标 truncated', async () => {
    const result = await scanProjectPathRefs(projectDir, buildTargets({ paths: ['/Game/Dup'] }), {
      maxFiles: 1
    })
    expect(result.truncated).toBe(true)
    expect(result.scanned_files + result.skipped_files).toBe(1)
  })

  it('没有目标就什么都不扫', async () => {
    const result = await scanProjectPathRefs(projectDir, [])
    expect(result.hits).toHaveLength(0)
    expect(result.scanned_files).toBe(0)
  })
})

describe('ue_project_path_refs 工具', () => {
  const text = (r: { content: { type: string; text?: string }[] }): string =>
    r.content.map((c) => ('text' in c ? c.text : '')).join('')

  it('是只读的 ue.content 工具', () => {
    expect(projectPathRefsTool.name).toBe('ue_project_path_refs')
    expect(projectPathRefsTool.unrealBox.risk).toBe('safe')
    expect(projectPathRefsTool.unrealBox.namespace).toBe('ue.content')
  })

  it('没绑定工程也没给 project 就报错', async () => {
    boundProject = undefined
    await expect(projectPathRefsTool.execute('c1', { paths: ['/Game/Dup'] })).rejects.toThrow(
      '没有绑定工程，也没给 project 参数'
    )
  })

  it('什么目标都没给就报错', async () => {
    boundProject = join(projectDir, 'Demo.uproject')
    await expect(projectPathRefsTool.execute('c1', {})).rejects.toThrow('至少要给')
  })

  it('用绑定工程的 .uproject 路径扫，摘要列命中和建议、带候选清单提示', async () => {
    boundProject = join(projectDir, 'Demo.uproject')
    const result = await projectPathRefsTool.execute('c1', {
      moves: [{ source: '/Game/A/BP_X', destination: '/Game/B/' }]
    })
    const summary = text(result)
    expect(summary).toContain('命中 1 处')
    expect(summary).toContain(
      '- Source/X/XGameMode.cpp:2  /Game/A/BP_X.BP_X_C  → 建议 /Game/B/BP_X.BP_X_C'
    )
    expect(summary).toContain(CANDIDATE_NOTE)
    expect(result.details.project_dir).toBe(projectDir)
    expect(result.details.hits).toHaveLength(1)
  })

  it('显式 project 参数优先，不存在的目录报清楚', async () => {
    boundProject = undefined
    const result = await projectPathRefsTool.execute('c1', {
      project: projectDir,
      paths: ['/Game/Nowhere']
    })
    expect(text(result)).toContain('没有发现指向这些路径的文本引用')

    await expect(
      projectPathRefsTool.execute('c1', {
        project: join(projectDir, 'Missing'),
        paths: ['/Game/Dup']
      })
    ).rejects.toThrow('工程目录不存在')
  })
})
