/** @vitest-environment node */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// @ts-expect-error —— 出包脚本是 .mjs，没有类型声明；这里只测它的纯函数
import { findExcludedEntries, shouldExcludeFromZip } from '../../scripts/build-plugin.mjs'
// @ts-expect-error —— 同上
import { findMissingHostLink, findStaleBinary } from '../../scripts/build-plugin.mjs'
// @ts-expect-error —— 同上
import { checkStaleness, zipNameForEngine } from '../../scripts/build-plugin.mjs'
// @ts-expect-error —— 同上
import { writeSourceStamp } from '../../scripts/build-plugin.mjs'

const AdmZip = createRequire(import.meta.url)('adm-zip')
const root = mkdtempSync(join(tmpdir(), 'ual-pack-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/**
 * 分发包里不该出现编译中间产物。
 *
 * ## 为什么值得单独一组测试
 *
 * 这条规则漏掉过一次，代价是可量化的：8 个插件包从 39MB 涨到 **150MB**，
 * 其中 `.pdb` 调试符号一个就 16.7MB、占单包体积的 83%。而且它是**渐进扩散**
 * 的 —— 先污染一个包，再随批量出包蔓延到七个。
 *
 * 最要命的是发现方式：靠一句「我记得插件包没这么大」，不是任何自动检查。
 * 没有那句话，150MB 会跟着安装包发给用户。
 *
 * 所以这里钉的不只是正例，更是**边界**：改这个正则时很容易顺手放宽，
 * 而放宽的代价用户是看不见的。
 */
describe('分发包排除规则', () => {
  it.each([
    'Binaries/Win64/UnrealEditor-UnrealAgentLink.pdb',
    'Binaries/Win64/UnrealEditor-UnrealAgentLink.exp',
    'Binaries/Win64/UnrealEditor-UnrealAgentLink.lib'
  ])('挡掉 %s', (name) => {
    expect(shouldExcludeFromZip(name)).toBe(true)
  })

  it.each([
    'Binaries/Win64/UnrealEditor-UnrealAgentLink.dll',
    'Binaries/Win64/UnrealEditor.modules',
    'Source/UnrealAgentLink/Private/Commands/UAL_EditorCommands.cpp',
    'Content/Materials/M_UAMaster.uasset',
    'UnrealAgentLink.uplugin',
    '.ual-build'
  ])('放行 %s', (name) => {
    expect(shouldExcludeFromZip(name)).toBe(false)
  })

  /** 大小写不敏感：Windows 上 .PDB 和 .pdb 是同一个文件 */
  it('后缀大小写不影响判断', () => {
    expect(shouldExcludeFromZip('X.PDB')).toBe(true)
    expect(shouldExcludeFromZip('X.Pdb')).toBe(true)
  })

  /**
   * 只看后缀，不看文件名里出现的字样。
   *
   * 写成 /pdb/ 而不是 /\.pdb$/ 的话，`Source/PdbHelper.cpp` 这种正常源码
   * 会被静默丢掉 —— 而丢文件比多带文件更难发现。
   */
  it.each(['Source/PdbHelper.cpp', 'Content/lib_texture.uasset', 'Docs/exp-notes.md'])(
    '名字里含 pdb/lib/exp 但后缀正常的不挡：%s',
    (name) => {
      expect(shouldExcludeFromZip(name)).toBe(false)
    }
  )

  it('空值不炸', () => {
    expect(shouldExcludeFromZip(undefined)).toBe(false)
    expect(shouldExcludeFromZip('')).toBe(false)
  })
})

describe('findExcludedEntries', () => {
  const makeZip = (name: string, entries: string[]): string => {
    const zip = new AdmZip()
    for (const e of entries) zip.addFile(e, Buffer.from('x'))
    const path = join(root, name)
    zip.writeZip(path)
    return path
  }

  it('干净的包返回空数组', () => {
    const p = makeZip('clean.zip', [
      'Binaries/Win64/UnrealEditor-UnrealAgentLink.dll',
      'Source/A.cpp',
      '.ual-build'
    ])
    expect(findExcludedEntries(p)).toEqual([])
  })

  /** 这正是真机上发生过的那个包的形状 */
  it('混进 .pdb 的包会被指名道姓', () => {
    const p = makeZip('dirty.zip', [
      'Binaries/Win64/UnrealEditor-UnrealAgentLink.dll',
      'Binaries/Win64/UnrealEditor-UnrealAgentLink.pdb'
    ])
    expect(findExcludedEntries(p)).toEqual(['Binaries/Win64/UnrealEditor-UnrealAgentLink.pdb'])
  })

  it('多个违规条目全部列出', () => {
    const p = makeZip('multi.zip', ['a.pdb', 'b.lib', 'c.exp', 'd.dll'])
    expect(findExcludedEntries(p).sort()).toEqual(['a.pdb', 'b.lib', 'c.exp'])
  })

  /**
   * 读不了的文件返回空，不冒充成「干净」也不抛。
   *
   * zip 损坏是另一个问题，由别的检查去报 —— 在这里抛异常会让整条门禁
   * 因为一个坏文件而中断，看不到其余包的结论。
   */
  it('不是 zip 的文件不抛异常', () => {
    const bad = join(root, 'notazip.zip')
    mkdirSync(root, { recursive: true })
    writeFileSync(bad, 'this is not a zip')
    expect(findExcludedEntries(bad)).toEqual([])
  })

  it('文件不存在时返回空', () => {
    expect(findExcludedEntries(join(root, '不存在.zip'))).toEqual([])
  })
})

/**
 * 「编了但没编插件」这个失败模式。
 *
 * ## 为什么值得单独一组测试
 *
 * 宿主工程的 `Plugins/` 下没有联接时，UBT 只编宿主工程自己的模块，**退出码是 0**。
 * 脚本原先就此往下走，把当前源码的指纹盖到一个装着旧 DLL 的 zip 上 ——
 * 比单纯的构建失败更糟：`--check` 那道新鲜度门禁从此认为包和源码一致，
 * 「改了源码没出包」被主动掩盖，而那正是这道门禁存在的全部理由。
 */
describe('构建产物校验', () => {
  const mkPlugin = (name: string, opts: { dll?: boolean } = {}): string => {
    const dir = join(root, name)
    mkdirSync(join(dir, 'Source'), { recursive: true })
    writeFileSync(join(dir, 'Source', 'A.cpp'), 'x')
    if (opts.dll !== false) {
      mkdirSync(join(dir, 'Binaries', 'Win64'), { recursive: true })
      writeFileSync(join(dir, 'Binaries', 'Win64', 'UnrealEditor-UnrealAgentLink.dll'), 'x')
    }
    return dir
  }

  /** 把一个文件的 mtime 挪到相对现在的某个秒数（负数表示过去） */
  const touch = (file: string, offsetSec: number): void => {
    const t = new Date(Date.now() + offsetSec * 1000)
    utimesSync(file, t, t)
  }

  it('DLL 比源码新 —— 放行', () => {
    const dir = mkPlugin('built')
    touch(join(dir, 'Source', 'A.cpp'), -60)
    expect(findStaleBinary(dir)).toBeNull()
  })

  /** 联接没建时的形状：源码在，Binaries/ 从来没生成过 */
  it('压根没有 DLL —— 拦下', () => {
    const dir = mkPlugin('never-built', { dll: false })
    expect(findStaleBinary(dir)).toContain('没有找到插件二进制')
  })

  /** 联接建了但插件没被编（工程里没启用、目标规则没引用）时的形状 */
  it('DLL 比源码旧 —— 拦下', () => {
    const dir = mkPlugin('stale')
    touch(join(dir, 'Binaries', 'Win64', 'UnrealEditor-UnrealAgentLink.dll'), -3600)
    expect(findStaleBinary(dir)).toContain('比源码还旧')
  })

  /**
   * 源码没变时 UBT 会跳过链接（"Target is up to date"），DLL 不会被碰。
   * 拿「构建开始时间」当基准的话这里必然误报，连出两次同一个版本的包就会踩到。
   */
  it('源码没变、UBT 跳过重编 —— 仍然放行', () => {
    const dir = mkPlugin('up-to-date')
    touch(join(dir, 'Source', 'A.cpp'), -7200)
    touch(join(dir, 'Binaries', 'Win64', 'UnrealEditor-UnrealAgentLink.dll'), -3600)
    expect(findStaleBinary(dir)).toBeNull()
  })

  /**
   * 只比 `Source/`：Content/Config 变了不会触发 UBT 重编，
   * 拿它们当基准会卡死在「重跑也过不了」。
   */
  it('只有 Content 变新不算旧', () => {
    const dir = mkPlugin('content-only')
    mkdirSync(join(dir, 'Content'), { recursive: true })
    writeFileSync(join(dir, 'Content', 'M.uasset'), 'x')
    touch(join(dir, 'Source', 'A.cpp'), -7200)
    touch(join(dir, 'Binaries', 'Win64', 'UnrealEditor-UnrealAgentLink.dll'), -3600)
    expect(findStaleBinary(dir)).toBeNull()
  })
})

describe('宿主工程联接校验', () => {
  it('Plugins 下没有 UnrealAgentLink —— 拦下', () => {
    const host = join(root, 'host-nolink')
    mkdirSync(host, { recursive: true })
    expect(findMissingHostLink(join(host, 'X.uproject'), join(root, 'src'))).toContain(
      '没有插件联接'
    )
  })

  it('联接指向别的目录 —— 拦下', () => {
    const host = join(root, 'host-wrong')
    const other = join(root, 'other-plugin')
    mkdirSync(join(host, 'Plugins', 'UnrealAgentLink'), { recursive: true })
    mkdirSync(other, { recursive: true })
    expect(findMissingHostLink(join(host, 'X.uproject'), other)).toContain('不是本仓库这一份')
  })

  /**
   * 真联接指回本仓库时放行。
   *
   * 这里不建真的 junction（Windows 上要权限、CI 上不一定有），
   * 直接把「插件源码目录」指成挂载点本身 —— realpath 相等，等价于联接生效后的样子。
   */
  it('联接指向本仓库插件源码 —— 放行', () => {
    const host = join(root, 'host-ok')
    const linked = join(host, 'Plugins', 'UnrealAgentLink')
    mkdirSync(linked, { recursive: true })
    expect(findMissingHostLink(join(host, 'X.uproject'), linked)).toBeNull()
  })
})

/**
 * 分发包新鲜度的两档要求。
 *
 * ## 为什么要分档
 *
 * 这道检查原先在 `pnpm verify` 里就要求九个 zip 全部和源码一致。做不到 ——
 * 出一个包要装对应引擎、跑一遍 UBT，九个版本一轮接近一小时，而本机也不一定
 * 装齐九个引擎。结果就是它长期全红，然后被当成背景噪音跳过，等于不存在。
 *
 * 现在：日常门禁只钉 5.5（开发时实际编的那个），发版门禁（`--all`，null）
 * 要求每个包都新鲜 —— 发版少一个版本，那个版本的用户就真的装到旧插件。
 *
 * 这里钉住的是**两档的边界**：把日常那档收严会让它回到没人看的状态，
 * 把发版那档放宽则等于把七个月脱节的老问题放回来。
 */
describe('分发包新鲜度', () => {
  const FRESH = 'be0d4888d135a373'
  const OLD = '2ae5e818b051ca02'

  let dist: string
  let seq = 0

  /** 造一个带构建标记的分发包；stamp 传 null 表示手工出的老包（没有标记） */
  const putZip = (name: string, stamp: string | null, extra: string[] = []): void => {
    const zip = new AdmZip()
    zip.addFile('Binaries/Win64/UnrealEditor-UnrealAgentLink.dll', Buffer.from('x'))
    if (stamp !== null) {
      const engine = name.replace(/^UnrealAgentLink(\d)(\d+)\.zip$/, '$1.$2')
      zip.addFile('.ual-build', Buffer.from(JSON.stringify({ fingerprint: stamp, engine })))
    }
    for (const e of extra) zip.addFile(e, Buffer.from('x'))
    zip.writeZip(join(dist, name))
  }

  beforeEach(() => {
    dist = join(root, `dist-${seq++}`)
    mkdirSync(dist, { recursive: true })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  /** 九个版本各一个包，除了 except 里点名的，其余都用 stamp */
  const putAll = (stamp: string, except: Record<string, string | null> = {}): void => {
    for (const v of ['50', '51', '52', '53', '54', '55', '56', '57', '58']) {
      const name = `UnrealAgentLink${v}.zip`
      putZip(name, name in except ? except[name] : stamp)
    }
  }

  describe('日常门禁（pnpm verify）—— 只钉 5.5', () => {
    it('5.5 新鲜 —— 其余八个版本全过期也放行', () => {
      putAll(OLD, { 'UnrealAgentLink55.zip': FRESH })
      expect(checkStaleness(FRESH, dist)).toBe(true)
    })

    it('5.5 过期 —— 拦住', () => {
      putZip('UnrealAgentLink55.zip', OLD)
      expect(checkStaleness(FRESH, dist)).toBe(false)
    })

    /**
     * 没有构建标记 = 判不了新旧。
     *
     * 对不要求的版本这只是「未知」，但对要求新鲜的那个，说不清它是不是旧的
     * 就不能算通过 —— 那等于用「不知道」冒充「没问题」。
     */
    it('5.5 没有构建标记 —— 判不了新旧，同样拦住', () => {
      putZip('UnrealAgentLink55.zip', null)
      expect(checkStaleness(FRESH, dist)).toBe(false)
    })

    it('5.5 的包根本不存在 —— 拦住', () => {
      putZip('UnrealAgentLink54.zip', FRESH)
      expect(checkStaleness(FRESH, dist, ['5.5'], 'win32', true)).toBe(false)
    })

    /** 分发包目录整个不在，也不能算通过 */
    it('分发包目录不存在 —— 拦住', () => {
      expect(checkStaleness(FRESH, join(root, '压根没有这个目录'), ['5.5'], 'win32', true)).toBe(
        false
      )
    })

    it('要求哪些版本新鲜是可配的', () => {
      putZip('UnrealAgentLink55.zip', FRESH)
      putZip('UnrealAgentLink58.zip', OLD)
      expect(checkStaleness(FRESH, dist, ['5.5', '5.8'])).toBe(false)
    })
  })

  describe('发版门禁（--all）—— 每个版本都要新鲜', () => {
    it('只有 5.5 的真实形状包，也必须报告缺少其余版本', () => {
      putZip('UnrealAgentLink55.zip', FRESH)
      expect(checkStaleness(FRESH, dist, null)).toBe(false)
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('UnrealAgentLink58.zip'))
    })

    it('包名与构建标记中的引擎版本不一致时拒绝发版', () => {
      putAll(FRESH)
      const zip = new AdmZip(join(dist, 'UnrealAgentLink58.zip'))
      zip.updateFile(
        '.ual-build',
        Buffer.from(JSON.stringify({ fingerprint: FRESH, engine: '5.5' }))
      )
      zip.writeZip(join(dist, 'UnrealAgentLink58.zip'))
      expect(checkStaleness(FRESH, dist, null)).toBe(false)
    })
    it('九个包全新鲜 —— 放行', () => {
      putAll(FRESH)
      expect(checkStaleness(FRESH, dist, null)).toBe(true)
    })

    /** 这正是日常门禁会放过、而发版绝不能放过的那种状态 */
    it('只有 5.5 新鲜、其余过期 —— 拦住', () => {
      putAll(OLD, { 'UnrealAgentLink55.zip': FRESH })
      expect(checkStaleness(FRESH, dist, null)).toBe(false)
    })

    it('随便哪一个版本过期都拦得住', () => {
      putAll(FRESH, { 'UnrealAgentLink52.zip': OLD })
      expect(checkStaleness(FRESH, dist, null)).toBe(false)
    })

    it('有一个包没有构建标记 —— 判不了新旧，拦住', () => {
      putAll(FRESH, { 'UnrealAgentLink57.zip': null })
      expect(checkStaleness(FRESH, dist, null)).toBe(false)
    })

    /** 一个包都没有不是「没发现问题」，是没东西可发 */
    it('一个分发包都没有 —— 拦住', () => {
      expect(checkStaleness(FRESH, dist, null)).toBe(false)
    })
  })

  /**
   * 混进 .pdb 和新旧无关，两档都拦。
   *
   * 日常那档放宽的是**覆盖面**，不是体积规则：150MB 那次事故里坏包是从一个
   * 扩散到七个的，只盯 5.5 会让另外八个继续带着 16MB 的调试符号躺在仓库里。
   */
  it('不被要求新鲜的版本混进 .pdb —— 日常门禁照样拦住', () => {
    putZip('UnrealAgentLink55.zip', FRESH)
    putZip('UnrealAgentLink58.zip', FRESH, ['Binaries/Win64/UnrealEditor-UnrealAgentLink.pdb'])
    expect(checkStaleness(FRESH, dist)).toBe(false)
  })

  it.each([
    ['5.5', 'UnrealAgentLink55.zip'],
    ['5.8', 'UnrealAgentLink58.zip'],
    ['5.10', 'UnrealAgentLink510.zip']
  ])('引擎 %s 对应包名 %s', (engine, name) => {
    expect(zipNameForEngine(engine)).toBe(name)
  })
})

/**
 * 编完要把指纹写进插件源码目录。
 *
 * 只写进 zip 是不够的：开发时宿主工程的 `Plugins/UnrealAgentLink` 是一条指向
 * 源码目录的联接，插件从那里加载，根本不经过 zip。少了这一步，插件在开发机上
 * 通过 `ue_get_project_info` 报出来的构建指纹永远是 unknown ——
 * 而开发机恰恰是最需要它的地方。
 *
 * 这个机制本身就是为了终结一类白跑：改完代码没重新出包，回归测试在旧 DLL 上
 * 跑出「修复未生效」，接下来整轮排查都在找一个不存在的 bug。已经发生过两次。
 */
describe('writeSourceStamp', () => {
  it('把指纹和引擎版本写成 .ual-build，插件运行时读的就是它', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ual-stamp-'))

    const written = writeSourceStamp('5.5', 'deadbeef1234', dir)

    expect(written).toBe(join(dir, '.ual-build'))
    const stamp = JSON.parse(readFileSync(written, 'utf8'))
    expect(stamp.fingerprint).toBe('deadbeef1234')
    expect(stamp.engine).toBe('5.5')
    expect(typeof stamp.builtAt).toBe('string')

    rmSync(dir, { recursive: true, force: true })
  })

  /** 重编一次要覆盖掉旧值，否则会一直报着上一次的指纹，比没有更坏 */
  it('重复写会覆盖，不会留着上一次的指纹', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ual-stamp-'))

    writeSourceStamp('5.5', 'old-one', dir)
    writeSourceStamp('5.5', 'new-one', dir)

    expect(JSON.parse(readFileSync(join(dir, '.ual-build'), 'utf8')).fingerprint).toBe('new-one')

    rmSync(dir, { recursive: true, force: true })
  })
})
