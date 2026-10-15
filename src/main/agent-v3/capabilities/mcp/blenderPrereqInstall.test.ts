import { describe, expect, it } from 'vitest'

import {
  WINGET_PACKAGES,
  describeWingetFailure,
  normalizeExitCode,
  wingetArgs
} from './blenderPrereqInstall'

describe('wingetArgs', () => {
  // 少了这两个 accept，第一次用 winget 的机器会停在协议确认上，进程挂到超时
  it('不交互、自动同意协议', () => {
    const args = wingetArgs(WINGET_PACKAGES.git)
    expect(args).toEqual(
      expect.arrayContaining([
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity'
      ])
    )
    expect(args).not.toContain('--override')
  })

  // python.org 安装器默认不加 PATH，装完盒子照样找不到
  it('Python 显式打开 PATH', () => {
    const args = wingetArgs(WINGET_PACKAGES.python)
    expect(args[args.indexOf('--override') + 1]).toContain('PrependPath=1')
  })
})

describe('describeWingetFailure', () => {
  it('Node 给的有符号退出码按 HRESULT 显示', () => {
    expect(normalizeExitCode(-1978335212)).toBe(0x8a150014)
    const outcome = describeWingetFailure(WINGET_PACKAGES.git, {
      code: -1978335212,
      stdout: '  \r  -\r正在搜索…\r\nNo package found matching input criteria.\r\n'
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toBe('安装 Git 未完成（winget 退出码 0x8A150014）。')
    expect(outcome.detail).toContain('No package found matching input criteria.')
  })

  it('没有 winget 的机器说清楚', () => {
    const outcome = describeWingetFailure(WINGET_PACKAGES.python, { code: 'ENOENT' })
    expect(outcome.message).toContain('没有 winget')
  })

  it('超时单独说', () => {
    const outcome = describeWingetFailure(WINGET_PACKAGES.git, { killed: true, code: null })
    expect(outcome.message).toContain('已中止')
  })
})
