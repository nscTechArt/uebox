/** @vitest-environment node */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// @ts-expect-error —— 检查脚本是 .mjs，没有类型声明；这里只测它的纯函数
import { checkReleasePackages, checkSelectedPackage } from '../../scripts/plugin-check.mjs'
import {
  findExcludedEntries,
  isFingerprintedPath,
  shouldExcludeFromZip,
  sourceFingerprint,
  zipNameForEngine
  // @ts-expect-error —— 同上
} from '../../scripts/plugin-package-format.mjs'

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
 * 「哪些文件改了会让包过期」必须和源码指纹是同一个判断 ——
 * 否则指纹变了、日常门禁却说不适用（或者反过来）。
 */
describe('打包输入与源码指纹一致', () => {
  it.each([
    'plugin/UnrealAgentLink/Source/UnrealAgentLink/Private/A.cpp',
    'plugin/UnrealAgentLink/Config/FilterPlugin.ini',
    'plugin/UnrealAgentLink/Content/M.uasset',
    'plugin/UnrealAgentLink/Resources/Docs/模型导入优化方案.md',
    'plugin/UnrealAgentLink/UnrealAgentLink.uplugin'
  ])('算打包输入：%s', (path) => {
    expect(isFingerprintedPath(path)).toBe(true)
  })

  it.each([
    'plugin/UnrealAgentLink/LICENSE',
    'plugin/UnrealAgentLink/README.md',
    'plugin/UnrealAgentLink/Binaries/Win64/UnrealEditor-UnrealAgentLink.dll',
    'plugin/UnrealAgentLink/SourceNotes.md',
    'scripts/build-plugin.mjs',
    'src/main/utils/UnrealPathManager.ts'
  ])('不算打包输入：%s', (path) => {
    expect(isFingerprintedPath(path)).toBe(false)
  })

  it('改打包输入会改指纹，改 LICENSE 不会', () => {
    const dir = join(root, 'fingerprint-src')
    mkdirSync(join(dir, 'Source'), { recursive: true })
    writeFileSync(join(dir, 'Source/A.cpp'), 'a')
    writeFileSync(join(dir, 'LICENSE'), 'license')
    const before = sourceFingerprint(dir)
    writeFileSync(join(dir, 'LICENSE'), 'license v2')
    expect(sourceFingerprint(dir)).toBe(before)
    writeFileSync(join(dir, 'Source/A.cpp'), 'b')
    expect(sourceFingerprint(dir)).not.toBe(before)
  })
})

/**
 * 开发检查只看显式选择的那一个包；发版检查保持完整集合要求。
 * 两档都不依赖引擎安装情况，缺少必需包始终失败。
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

  /** 改写选中包里的构建标记；传字符串就原样写进去（用来造坏 JSON） */
  const rewriteStamp = (name: string, stamp: Record<string, string> | string): void => {
    const zip = new AdmZip(join(dist, name))
    zip.updateFile(
      '.ual-build',
      Buffer.from(typeof stamp === 'string' ? stamp : JSON.stringify(stamp))
    )
    zip.writeZip(join(dist, name))
  }

  describe('显式选择 UE 5.5', () => {
    it('5.5 新鲜 —— 其余版本过期、损坏或混进 .pdb 都不影响', () => {
      putAll(OLD, { 'UnrealAgentLink55.zip': FRESH })
      writeFileSync(join(dist, 'UnrealAgentLink50.zip'), 'not a zip')
      putZip('UnrealAgentLink58.zip', FRESH, ['Binaries/Win64/UnrealEditor-UnrealAgentLink.pdb'])
      expect(checkSelectedPackage(FRESH, '5.5', dist)).toBe(true)
    })

    it('5.5 过期 —— 拦住', () => {
      putZip('UnrealAgentLink55.zip', OLD)
      expect(checkSelectedPackage(FRESH, '5.5', dist)).toBe(false)
    })

    /**
     * 没有构建标记 = 判不了新旧。
     *
     * 说不清选中的包是不是旧的，就不能算通过。
     */
    it('5.5 没有构建标记 —— 判不了新旧，同样拦住', () => {
      putZip('UnrealAgentLink55.zip', null)
      expect(checkSelectedPackage(FRESH, '5.5', dist)).toBe(false)
    })

    it('5.5 的构建标记不是合法 JSON —— 拦住', () => {
      putZip('UnrealAgentLink55.zip', FRESH)
      rewriteStamp('UnrealAgentLink55.zip', '{invalid JSON')
      expect(checkSelectedPackage(FRESH, '5.5', dist)).toBe(false)
    })

    it('5.5 的包不是 zip —— 拦住', () => {
      writeFileSync(join(dist, 'UnrealAgentLink55.zip'), 'not a zip')
      expect(checkSelectedPackage(FRESH, '5.5', dist)).toBe(false)
    })

    it('包名是 5.5、构建标记却是别的版本 —— 拦住', () => {
      putZip('UnrealAgentLink55.zip', FRESH)
      rewriteStamp('UnrealAgentLink55.zip', { fingerprint: FRESH, engine: '5.7' })
      expect(checkSelectedPackage(FRESH, '5.5', dist)).toBe(false)
    })

    /** 缺的是 5.5，就不能拿旁边新鲜的 5.4 顶上 */
    it('5.5 的包根本不存在 —— 拦住，不拿别的版本顶替', () => {
      putZip('UnrealAgentLink54.zip', FRESH)
      expect(checkSelectedPackage(FRESH, '5.5', dist)).toBe(false)
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('pnpm plugin:build --engine 5.5')
      )
    })

    /** 分发包目录整个不在，也不能算通过 */
    it('分发包目录不存在 —— 拦住', () => {
      expect(checkSelectedPackage(FRESH, '5.5', join(root, '压根没有这个目录'))).toBe(false)
    })

    it('选中的版本混进 .pdb —— 拦住', () => {
      putZip('UnrealAgentLink55.zip', FRESH, ['Binaries/Win64/UnrealEditor-UnrealAgentLink.pdb'])
      expect(checkSelectedPackage(FRESH, '5.5', dist)).toBe(false)
    })
  })

  describe('发版门禁 —— 每个版本都要新鲜', () => {
    it('只有 5.5 的真实形状包，也必须报告缺少其余版本', () => {
      putZip('UnrealAgentLink55.zip', FRESH)
      expect(checkReleasePackages(FRESH, dist)).toBe(false)
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('UnrealAgentLink58.zip'))
    })

    it('包名与构建标记中的引擎版本不一致时拒绝发版', () => {
      putAll(FRESH)
      rewriteStamp('UnrealAgentLink58.zip', { fingerprint: FRESH, engine: '5.5' })
      expect(checkReleasePackages(FRESH, dist)).toBe(false)
    })

    it('九个包全新鲜 —— 放行', () => {
      putAll(FRESH)
      expect(checkReleasePackages(FRESH, dist)).toBe(true)
    })

    /** 这正是日常门禁会放过、而发版绝不能放过的那种状态 */
    it('只有 5.5 新鲜、其余过期 —— 拦住', () => {
      putAll(OLD, { 'UnrealAgentLink55.zip': FRESH })
      expect(checkReleasePackages(FRESH, dist)).toBe(false)
    })

    it('随便哪一个版本过期都拦得住', () => {
      putAll(FRESH, { 'UnrealAgentLink52.zip': OLD })
      expect(checkReleasePackages(FRESH, dist)).toBe(false)
    })

    it('有一个包没有构建标记 —— 判不了新旧，拦住', () => {
      putAll(FRESH, { 'UnrealAgentLink57.zip': null })
      expect(checkReleasePackages(FRESH, dist)).toBe(false)
    })

    it('全套之外的额外包过期也拦住', () => {
      putAll(FRESH)
      putZip('UnrealAgentLink510.zip', OLD)
      expect(checkReleasePackages(FRESH, dist)).toBe(false)
    })

    /** 一个包都没有不是「没发现问题」，是没东西可发 */
    it('一个分发包都没有 —— 拦住', () => {
      expect(checkReleasePackages(FRESH, dist)).toBe(false)
    })
  })

  it.each([
    ['5.5', 'UnrealAgentLink55.zip'],
    ['5.8', 'UnrealAgentLink58.zip'],
    ['5.10', 'UnrealAgentLink510.zip']
  ])('引擎 %s 对应包名 %s', (engine, name) => {
    expect(zipNameForEngine(engine)).toBe(name)
  })
})
