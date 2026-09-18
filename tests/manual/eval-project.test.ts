/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { sep } from 'node:path'

// @ts-expect-error —— 评测脚手架是 .mjs，没有类型声明
import {
  EVAL_COPY_MARKER,
  fingerprintOf,
  normalizeProjectPath,
  planRestore,
  sameProject
} from './eval-project.mjs'

/**
 * 这道守卫下面挂着一条 `rm -rf`。
 *
 * 评审用模拟文件系统复现过：模板和副本填成同一路径时，脚本先删模板、再复制失败。
 * UE 工程大多不在版本控制里，删了没有任何东西能还原 —— 所以每一条拒绝的理由
 * 都要有测试钉住，尤其是"什么情况下**必须**拒绝"。
 */

const R = (...parts: string[]): string => ['D:', ...parts].join(sep)

/** 造一套模拟文件系统 */
const fsOf = (
  dirs: Record<string, { marker?: boolean }>
): {
  resolve: (p: string) => string
  exists: (p: string) => boolean
  hasMarker: (p: string) => boolean
} => ({
  resolve: (p: string) => p,
  exists: (p: string) => p in dirs,
  hasMarker: (p: string) => dirs[p]?.marker === true
})

describe('planRestore：必须拒绝的情况', () => {
  it('模板和副本是同一个路径 —— 会先删掉模板', () => {
    const same = R('eval', 'Template')
    const r = planRestore({
      template: same,
      project: same,
      ...fsOf({ [same]: { marker: true } })
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('同一个路径')
  })

  it('副本在模板里面', () => {
    const t = R('eval')
    const p = R('eval', 'Run')
    const r = planRestore({ template: t, project: p, ...fsOf({ [t]: {}, [p]: { marker: true } }) })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('副本在模板里面')
  })

  it('模板在副本里面 —— 删副本会连模板一起删', () => {
    const p = R('eval')
    const t = R('eval', 'Template')
    const r = planRestore({ template: t, project: p, ...fsOf({ [t]: {}, [p]: { marker: true } }) })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('模板在副本里面')
  })

  it('同前缀但不同目录不算包含（evalX 不是 eval 的子目录）', () => {
    const t = R('eval')
    const p = R('evalX')
    const r = planRestore({ template: t, project: p, ...fsOf({ [t]: {} }) })
    expect(r.ok).toBe(true)
  })

  it('副本路径太浅（盘符根目录）', () => {
    const r = planRestore({
      template: R('eval', 'Template'),
      project: `D:${sep}`,
      ...fsOf({ [R('eval', 'Template')]: {} })
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('太浅')
  })

  it('模板不存在 —— 删完副本就没得复制了', () => {
    const r = planRestore({
      template: R('eval', 'Template'),
      project: R('eval', 'Run'),
      ...fsOf({})
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('模板不存在')
  })

  it('副本已存在但没有标记 —— 可能是用户真实工程，必须拒', () => {
    const t = R('eval', 'Template')
    const p = R('Projects', 'MyRealGame')
    const r = planRestore({ template: t, project: p, ...fsOf({ [t]: {}, [p]: {} }) })
    expect(r.ok).toBe(false)
    expect(r.error).toContain(EVAL_COPY_MARKER)
  })

  it('少填一个环境变量就拒', () => {
    expect(planRestore({ template: '', project: R('eval', 'Run'), ...fsOf({}) }).ok).toBe(false)
    expect(planRestore({ template: R('eval', 'T'), project: '', ...fsOf({}) }).ok).toBe(false)
  })
})

describe('planRestore：可以放行的情况', () => {
  it('副本不存在 —— 第一次跑，直接建', () => {
    const t = R('eval', 'Template')
    const p = R('eval', 'Run')
    const r = planRestore({ template: t, project: p, ...fsOf({ [t]: {} }) })
    expect(r).toMatchObject({ ok: true, template: t, project: p, willDelete: false })
  })

  it('副本存在且带标记 —— 是我们自己造的，可以整个丢弃', () => {
    const t = R('eval', 'Template')
    const p = R('eval', 'Run')
    const r = planRestore({
      template: t,
      project: p,
      ...fsOf({ [t]: {}, [p]: { marker: true } })
    })
    expect(r).toMatchObject({ ok: true, willDelete: true })
  })

  it('先解析再比较 —— 相对路径写法绕不过同路径检查', () => {
    const abs = R('eval', 'Run')
    const r = planRestore({
      template: 'Run',
      project: abs,
      resolve: (p: string) => (p === 'Run' ? abs : p),
      exists: () => true,
      hasMarker: () => true
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('同一个路径')
  })
})

describe('normalizeProjectPath / sameProject：判「连着的是不是那个一次性副本」', () => {
  const opts = {
    resolve: (p: string) => p,
    dirname: (p: string) => p.slice(0, p.lastIndexOf(sep)),
    isWindows: true
  }

  it('斜杠方向不影响判定', () => {
    expect(normalizeProjectPath(`D:${sep}eval${sep}Run`, opts)).toBe(
      normalizeProjectPath('D:/eval/Run', opts)
    )
  })

  it('给 .uproject 文件时取它所在目录 —— 工程的身份是目录', () => {
    expect(normalizeProjectPath(`D:${sep}eval${sep}Run${sep}Run.uproject`, opts)).toBe(
      normalizeProjectPath(`D:${sep}eval${sep}Run`, opts)
    )
  })

  it('Windows 上大小写不敏感，尾斜杠也不算差异', () => {
    expect(sameProject(`D:${sep}EVAL${sep}Run${sep}`, `D:${sep}eval${sep}Run`, opts)).toBe(true)
  })

  it('引擎给引号包着的路径也认', () => {
    expect(sameProject(`"D:${sep}eval${sep}Run"`, `D:${sep}eval${sep}Run`, opts)).toBe(true)
  })

  it('不同工程必须判 false —— 这条判错等于把守卫拆了', () => {
    expect(sameProject(`D:${sep}eval${sep}RunX`, `D:${sep}eval${sep}Run`, opts)).toBe(false)
    expect(sameProject(`D:${sep}Projects${sep}MyRealGame`, `D:${sep}eval${sep}Run`, opts)).toBe(
      false
    )
  })

  it('拿不到路径时判 false，不当成"是副本"', () => {
    expect(sameProject(null, `D:${sep}eval${sep}Run`, opts)).toBe(false)
    expect(sameProject('', `D:${sep}eval${sep}Run`, opts)).toBe(false)
    expect(sameProject('   ', `D:${sep}eval${sep}Run`, opts)).toBe(false)
    expect(normalizeProjectPath(undefined, opts)).toBeNull()
  })
})

describe('fingerprintOf：「起点一致」怎么算数', () => {
  const e = (relPath: string, sha256: string): { relPath: string; sha256: string } => ({
    relPath,
    sha256
  })

  it('文件顺序不影响指纹', () => {
    const a = fingerprintOf([e('Content/A.uasset', 'h1'), e('Content/B.uasset', 'h2')])
    const b = fingerprintOf([e('Content/B.uasset', 'h2'), e('Content/A.uasset', 'h1')])
    expect(a).toBe(b)
  })

  it('内容变了指纹就变 —— 上一条用例写过东西必须被认出来', () => {
    const base = fingerprintOf([e('Content/A.uasset', 'h1')])
    expect(fingerprintOf([e('Content/A.uasset', 'CHANGED')])).not.toBe(base)
    expect(fingerprintOf([e('Content/A.uasset', 'h1'), e('Content/New.uasset', 'h9')])).not.toBe(
      base
    )
  })

  it('斜杠方向不影响指纹', () => {
    expect(fingerprintOf([e('Content\\Sub\\A.uasset', 'h1')])).toBe(
      fingerprintOf([e('Content/Sub/A.uasset', 'h1')])
    )
  })

  it('Saved / Intermediate / Binaries 不进指纹 —— 开一次编辑器就会变，不属于"起点"', () => {
    const base = fingerprintOf([e('Content/A.uasset', 'h1')])
    expect(
      fingerprintOf([
        e('Content/A.uasset', 'h1'),
        e('Saved/Autosaves/x.uasset', 'zzz'),
        e('Intermediate/Build/y.obj', 'zzz'),
        e('DerivedDataCache/z.udd', 'zzz'),
        e('Binaries/Win64/p.dll', 'zzz')
      ])
    ).toBe(base)
  })

  it('Content 下同名但不同层级的文件不会互相抵消', () => {
    expect(fingerprintOf([e('Content/A.uasset', 'h1')])).not.toBe(
      fingerprintOf([e('Content/Sub/A.uasset', 'h1')])
    )
  })
})

describe('planRestore：Windows 大小写不能绕过守卫', () => {
  const win = { isWindows: true }

  it('大小写不同但同一个目录 —— 必须拒（否则先删模板）', () => {
    const t = `D:${sep}eval${sep}Template`
    const p = `d:${sep}EVAL${sep}template`
    const r = planRestore({
      template: t,
      project: p,
      ...fsOf({ [t]: {}, [p]: { marker: true } }),
      ...win
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('同一个路径')
  })

  it('大小写不同的包含关系 —— 必须拒', () => {
    const t = `D:${sep}eval`
    const p = `d:${sep}EVAL${sep}Run`
    const r = planRestore({
      template: t,
      project: p,
      ...fsOf({ [t]: {}, [p]: { marker: true } }),
      ...win
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('副本在模板里面')
  })

  it('反向包含也一样', () => {
    const p = `D:${sep}eval`
    const t = `d:${sep}EVAL${sep}Template`
    const r = planRestore({
      template: t,
      project: p,
      ...fsOf({ [t]: {}, [p]: { marker: true } }),
      ...win
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('模板在副本里面')
  })

  it('非 Windows 上大小写是有意义的，不该误拒', () => {
    const t = `D:${sep}eval${sep}Template`
    const p = `D:${sep}eval${sep}template`
    const r = planRestore({
      template: t,
      project: p,
      ...fsOf({ [t]: {} }),
      isWindows: false
    })
    expect(r.ok).toBe(true)
  })

  it('放行时给的仍是原样路径，不是折叠过大小写的那份', () => {
    const t = `D:${sep}eval${sep}Template`
    const p = `D:${sep}eval${sep}Run`
    const r = planRestore({ template: t, project: p, ...fsOf({ [t]: {} }), ...win })
    expect(r).toMatchObject({ ok: true, template: t, project: p })
  })
})

describe('fingerprintOf：脚手架自己的痕迹不能进指纹', () => {
  const e = (relPath: string, sha256: string): { relPath: string; sha256: string } => ({
    relPath,
    sha256
  })

  it('标记文件带创建时间，每轮都不同 —— 必须排除', () => {
    // 真机上就是它把「两轮起点是否一致」判成了不一致
    const base = fingerprintOf([e('Content/A.uasset', 'h1')])
    expect(fingerprintOf([e('Content/A.uasset', 'h1'), e(EVAL_COPY_MARKER, 'time-1')])).toBe(base)
    expect(fingerprintOf([e('Content/A.uasset', 'h1'), e(EVAL_COPY_MARKER, 'time-2')])).toBe(base)
  })

  it('同名文件在子目录里仍然被排除（它不该出现在那儿，但也不该影响指纹）', () => {
    const base = fingerprintOf([e('Content/A.uasset', 'h1')])
    expect(
      fingerprintOf([e('Content/A.uasset', 'h1'), e(`Content/${EVAL_COPY_MARKER}`, 'x')])
    ).toBe(base)
  })
})
