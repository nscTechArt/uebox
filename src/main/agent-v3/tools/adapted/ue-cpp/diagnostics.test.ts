/**
 * @vitest-environment node
 *
 * 解析器是纯函数，也是 cpp_compile 唯一能在 CI 里验的部分 —— 别的都要真机。
 * 喂的是真实形状的 MSVC / UBT 输出。
 */

import { describe, expect, it } from 'vitest'

import { formatDiagnostic, parseDiagnostics } from './diagnostics'

describe('parseDiagnostics', () => {
  it('带行号的编译错误', () => {
    const [d] = parseDiagnostics(
      `D:\\Proj\\Source\\MyGame\\TurretActor.cpp(42): error C2039: "Tick": 不是 "AActor" 的成员`
    )

    expect(d).toMatchObject({
      severity: 'error',
      code: 'C2039',
      file: 'D:\\Proj\\Source\\MyGame\\TurretActor.cpp',
      line: 42
    })
    expect(d.message).toContain('AActor')
  })

  it('带列号的形式', () => {
    const [d] = parseDiagnostics(`D:\\a\\b.cpp(42, 17): warning C4996: 'X': deprecated`)

    expect(d).toMatchObject({ severity: 'warning', code: 'C4996', line: 42, column: 17 })
  })

  /**
   * Windows 路径里有 `C:`。任何「按第一个冒号切」的实现都会在这里把文件名切成 `C`，
   * 所以这条是这个解析器的核心用例，不是边角。
   */
  it('盘符里的冒号不能把文件名切断', () => {
    const [d] = parseDiagnostics(`C:\\UE\\Engine\\Source\\Foo.h(7): error C2065: undeclared`)

    expect(d.file).toBe('C:\\UE\\Engine\\Source\\Foo.h')
    expect(d.line).toBe(7)
  })

  it('链接错误没有文件位置，记工具名', () => {
    const ds = parseDiagnostics(
      [
        `LINK : fatal error LNK1104: cannot open file 'UnrealEditor-MyGame.lib'`,
        `MyGame.obj : error LNK2019: unresolved external symbol "public: void __cdecl AFoo::Bar(void)"`
      ].join('\n')
    )

    expect(ds).toHaveLength(2)
    expect(ds[0]).toMatchObject({ code: 'LNK1104', tool: 'LINK' })
    expect(ds[0].file).toBeUndefined()
    expect(ds[1]).toMatchObject({ code: 'LNK2019', tool: 'MyGame.obj' })
  })

  it('普通构建日志不会被误判成错误', () => {
    const ds = parseDiagnostics(
      [
        '------ Building 6 action(s) started ------',
        '[1/6] Compile [x64] Module.MyGame.cpp',
        'Total execution time: 29.86 seconds'
      ].join('\n')
    )

    expect(ds).toEqual([])
  })

  it('超过 50 条就截断，不把上下文撑爆', () => {
    const flood = Array.from(
      { length: 200 },
      (_, i) => `D:\\a.cpp(${i + 1}): error C2065: undeclared`
    ).join('\n')

    expect(parseDiagnostics(flood)).toHaveLength(50)
  })

  /**
   * 这一行是**真的从 UBT 输出里抄下来的**（2026-09-03，UE 5.5，故意在
   * UALinkDev55.cpp 里塞了一句 static_assert(false) 之后编出来的）。
   * 上面那些用例是我照着 UBT 的正则造的，这一条是真货 —— 两者形状一致，
   * 说明抄对了。
   */
  it('真实 UBT 输出（UE 5.5 实测）', () => {
    const [d] = parseDiagnostics(
      String.raw`I:\UnrealAgent\UALinkDev55\Source\UALinkDev55\UALinkDev55.cpp(13): error C2338: static_assert failed: 'UALINK_CPP_COMPILE_PROBE'`
    )

    expect(d).toMatchObject({
      severity: 'error',
      code: 'C2338',
      file: String.raw`I:\UnrealAgent\UALinkDev55\Source\UALinkDev55\UALinkDev55.cpp`,
      line: 13
    })
    expect(d.message).toContain('UALINK_CPP_COMPILE_PROBE')
  })

  it('formatDiagnostic 把文件和行号放在最前面', () => {
    const [d] = parseDiagnostics(`D:\\a\\b.cpp(42, 17): error C2039: nope`)

    expect(formatDiagnostic(d)).toBe('✗ D:\\a\\b.cpp:42:17  C2039: nope')
  })
})
