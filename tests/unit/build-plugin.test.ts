/** @vitest-environment node */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// @ts-expect-error —— 出包脚本是 .mjs，没有类型声明；这里只测它的纯函数
import { findMissingHostLink, findStaleBinary } from '../../scripts/build-plugin.mjs'
// @ts-expect-error —— 同上
import { writeSourceStamp } from '../../scripts/build-plugin.mjs'

const root = mkdtempSync(join(tmpdir(), 'ual-pack-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/**
 * 「编了但没编插件」这个失败模式。
 *
 * ## 为什么值得单独一组测试
 *
 * 宿主工程的 `Plugins/` 下没有联接时，UBT 只编宿主工程自己的模块，**退出码是 0**。
 * 脚本原先就此往下走，把当前源码的指纹盖到一个装着旧 DLL 的 zip 上 ——
 * 比单纯的构建失败更糟：`plugin:check` 那道新鲜度门禁从此认为包和源码一致，
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
