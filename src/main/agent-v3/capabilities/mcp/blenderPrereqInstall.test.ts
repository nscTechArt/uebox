import { createHash } from 'crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import {
  PYTHON_INSTALLER_ARGS,
  PYTHON_MIRROR_INSTALLERS,
  WINGET_PACKAGES,
  describeWingetFailure,
  installPrerequisite,
  installPythonFromMirror,
  normalizeExitCode,
  wingetArgs
} from './blenderPrereqInstall'

describe('Python 走国内镜像', () => {
  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

  // 镜像上的东西不可信：字节对不上锁定的哈希，就绝不运行它
  it('哈希对不上就不运行', async () => {
    const run = vi.fn()
    const outcome = await installPythonFromMirror({
      arch: 'x64',
      download: async () => Buffer.from('not python'),
      run
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('SHA-256')
    expect(run).not.toHaveBeenCalled()
  })

  it('哈希对上了按用户静默安装，不弹管理员确认', async () => {
    const bytes = Buffer.from('pretend installer')
    const pin = PYTHON_MIRROR_INSTALLERS.x64!
    const original = pin.sha256
    pin.sha256 = sha256(bytes)
    try {
      const run = vi.fn(async () => {})
      const outcome = await installPythonFromMirror({
        arch: 'x64',
        download: async () => bytes,
        run
      })
      expect(outcome.ok).toBe(true)
      expect(run).toHaveBeenCalledWith(
        expect.stringMatching(/python-.*-amd64\.exe$/),
        PYTHON_INSTALLER_ARGS
      )
      expect(PYTHON_INSTALLER_ARGS).toContain('InstallAllUsers=0')
      expect(PYTHON_INSTALLER_ARGS).toContain('InstallLauncherAllUsers=0')
    } finally {
      pin.sha256 = original
    }
  })

  it('镜像下不来就报原因，不抛', async () => {
    const outcome = await installPythonFromMirror({
      arch: 'x64',
      download: async () => {
        throw new Error('ECONNRESET')
      }
    })
    expect(outcome).toMatchObject({ ok: false, detail: 'mirror download failed: ECONNRESET' })
  })
})

describe('installPrerequisite', () => {
  it('Python 镜像失败才退回 winget，两段原因都留给 AI', async () => {
    const winget = vi.fn(async () => ({
      ok: false,
      message: 'winget 失败',
      detail: 'winget detail'
    }))
    const outcome = await installPrerequisite('python', {
      mirror: async () => ({ ok: false, detail: 'mirror detail' }),
      winget
    })
    expect(winget).toHaveBeenCalledWith('python')
    expect(outcome.message).toBe('winget 失败')
    expect(outcome.detail).toBe('mirror detail\nwinget detail')
  })

  it('Python 镜像成功就不碰 winget', async () => {
    const winget = vi.fn()
    const outcome = await installPrerequisite('python', {
      mirror: async () => ({ ok: true }),
      winget
    })
    expect(outcome.ok).toBe(true)
    expect(winget).not.toHaveBeenCalled()
  })

  it('Git 没有镜像这一步，直接 winget', async () => {
    const winget = vi.fn(async () => ({ ok: true }))
    const mirror = vi.fn()
    await installPrerequisite('git', { mirror, winget })
    expect(mirror).not.toHaveBeenCalled()
    expect(winget).toHaveBeenCalledWith('git')
  })
})

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
