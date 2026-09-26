/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/UnrealPathManager', () => ({ default: {} }))

import { buildUatArgs, fatalLines, keyErrors, quoteForCmd, stageOf } from './projectPackage'

/**
 * 打包一次半小时，参数拼错、日志读错都要到最后才发现。这几个纯函数先钉住。
 */

describe('UAT 参数', () => {
  it('BuildCookRun 全流程：编译、烘焙、打包、归档到指定目录', () => {
    const args = buildUatArgs({
      uproject: 'I:/UE Project/TD/TD.uproject',
      configuration: 'Development',
      archiveDir: 'I:/UE Project/TD/Saved/UEBoxBuilds/x',
      platform: 'Win64'
    })
    expect(args[0]).toBe('BuildCookRun')
    for (const flag of ['-build', '-cook', '-stage', '-pak', '-archive', '-unattended', '-noP4']) {
      expect(args).toContain(flag)
    }
    expect(args).toContain('-clientconfig=Development')
    expect(args).toContain('-archivedirectory=I:/UE Project/TD/Saved/UEBoxBuilds/x')
  })

  it('路径有空格：-key=值 只包值，别的整体包', () => {
    expect(quoteForCmd('-project=I:/UE Project/TD.uproject')).toBe(
      '-project="I:/UE Project/TD.uproject"'
    )
    expect(quoteForCmd('C:/Program Files/Epic/RunUAT.bat')).toBe(
      '"C:/Program Files/Epic/RunUAT.bat"'
    )
    expect(quoteForCmd('-cook')).toBe('-cook')
  })

  it('cmd 的命令符号一律包进引号 —— R&D 目录不会被拆成两条命令', () => {
    expect(quoteForCmd('-project=D:\\R&D\\TD\\TD.uproject')).toBe(
      '-project="D:\\R&D\\TD\\TD.uproject"'
    )
    expect(quoteForCmd('-archivedirectory=C:\\tmp\\x&calc')).toBe(
      '-archivedirectory="C:\\tmp\\x&calc"'
    )
    expect(quoteForCmd('D:\\a^b|c')).toBe('"D:\\a^b|c"')
  })

  it('引号里也挡不住的 % 和 " 直接拒绝；结尾反斜杠去掉，免得吞掉收尾引号', () => {
    expect(() => quoteForCmd('-archivedirectory=C:\\%PATH%')).toThrow()
    expect(() => quoteForCmd('C:\\a"b')).toThrow()
    expect(quoteForCmd('-archivedirectory=D:\\My Builds\\')).toBe(
      '-archivedirectory="D:\\My Builds"'
    )
  })
})

describe('读 UAT 输出', () => {
  it('认得出各个阶段', () => {
    expect(stageOf('********** COOK COMMAND STARTED **********')).toBe('烘焙资源')
    expect(stageOf('BUILD SUCCESSFUL')).toBe('完成')
    expect(stageOf('LogCook: Display: Cooked packages 120')).toBeNull()
  })

  it('关键报错：去重、跳过「0 个错误」这类总结行', () => {
    const errors = keyErrors([
      'LogCook: Error: Missing asset /Game/Hero',
      '[2026.09.25-12.00.01] LogCook: Error: Missing asset /Game/Hero',
      'Success - 0 error(s), 3 warning(s)',
      'ERROR: UnrealBuildTool failed with exit code 6'
    ])
    expect(errors).toEqual([
      'LogCook: Error: Missing asset /Game/Hero',
      'ERROR: UnrealBuildTool failed with exit code 6'
    ])
  })
})

describe('读打包版游戏日志', () => {
  it('挑出致命错误那几行', () => {
    const log = [
      'LogInit: Display: Starting Game.',
      'LogWindows: Error: Fatal error: [File:Unknown] Access violation',
      'LogTemp: Warning: something minor'
    ].join('\n')
    expect(fatalLines(log)).toEqual([
      'LogWindows: Error: Fatal error: [File:Unknown] Access violation'
    ])
    expect(fatalLines('LogInit: all good')).toEqual([])
  })
})
