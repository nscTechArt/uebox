import { describe, expect, it, vi } from 'vitest'
import {
  describeUpdateFeed,
  pickFastestFeed,
  resolveUpdateFeed,
  resolveUpdateFeeds,
  type UpdateFeed
} from './updateFeed'

describe('updateFeed', () => {
  /**
   * 这条是这个文件里最重要的一条。
   *
   * 公开核心声称「完全离线运行，不依赖官方服务器」。以前这里有个硬编码的
   * `https://ue5box.com` 兜底，于是任何打出来的包开机就往官方域名发请求 ——
   * 那句话在打包版里是假的。现在没配置就没有更新源，一次请求都不发。
   */
  it('什么都没配时没有更新源', () => {
    expect(resolveUpdateFeed({})).toBeNull()
  })

  it('给了 owner/repo 就走 GitHub Releases', () => {
    expect(
      resolveUpdateFeed({ env: { UEBOX_UPDATE_GITHUB_REPO: 'ueboxai/unreal-box-core' } })
    ).toEqual({ provider: 'github', owner: 'ueboxai', repo: 'unreal-box-core' })
  })

  /** 写错格式不能去猜，猜错等于往一个陌生域名发请求 */
  it('owner/repo 格式不对就当没配', () => {
    expect(
      resolveUpdateFeed({ env: { UEBOX_UPDATE_GITHUB_REPO: 'https://github.com/a/b' } })
    ).toBeNull()
  })

  /** package.json 里留着空字段是「等着填」，不是「配好了」 */
  it('元数据里的空字符串当没配', () => {
    expect(resolveUpdateFeed({ appMetadata: { updateGithubRepo: '' } })).toBeNull()
  })

  it('GitHub 优先于 generic 源', () => {
    expect(
      resolveUpdateFeed({
        env: {
          UEBOX_UPDATE_GITHUB_REPO: 'ueboxai/unreal-box-core',
          UEBOX_UPDATE_FEED_URL: 'https://updates.example.com/acme'
        }
      })
    ).toEqual({ provider: 'github', owner: 'ueboxai', repo: 'unreal-box-core' })
  })

  it('自架静态源原样使用，只去掉尾斜杠', () => {
    expect(
      resolveUpdateFeed({ appMetadata: { updateFeedUrl: 'https://updates.example.com/acme/' } })
    ).toEqual({ provider: 'generic', url: 'https://updates.example.com/acme' })
  })

  it('环境变量盖过打包进去的元数据，便于本机验证', () => {
    expect(
      resolveUpdateFeed({
        env: { UEBOX_UPDATE_GITHUB_REPO: 'someone/fork' },
        appMetadata: { updateGithubRepo: 'ueboxai/unreal-box-core' }
      })
    ).toEqual({ provider: 'github', owner: 'someone', repo: 'fork' })
  })

  it('日志里只留来源，不留完整地址', () => {
    expect(
      describeUpdateFeed({ provider: 'generic', url: 'https://a.example.com/private/x' })
    ).toBe('https://a.example.com/...')
    expect(describeUpdateFeed({ provider: 'github', owner: 'o', repo: 'r' })).toBe('github:o/r')
    expect(describeUpdateFeed(null)).toBe('[not configured]')
  })

  describe('镜像', () => {
    it('主源排第一，镜像跟在后面，重复的去掉', () => {
      expect(
        resolveUpdateFeeds({
          appMetadata: {
            updateGithubRepo: 'ueboxai/uebox',
            updateMirrors: ['https://dl.example.cn/dl/', 'https://dl.example.cn/dl', 'ftp://x']
          }
        })
      ).toEqual([
        { provider: 'github', owner: 'ueboxai', repo: 'uebox' },
        { provider: 'generic', url: 'https://dl.example.cn/dl' }
      ])
    })

    it('环境变量逗号分隔，整体盖过元数据', () => {
      expect(
        resolveUpdateFeeds({
          env: { UEBOX_UPDATE_MIRRORS: 'https://a.example/dl, https://b.example/dl' },
          appMetadata: { updateMirrors: ['https://c.example/dl'] }
        })
      ).toEqual([
        { provider: 'generic', url: 'https://a.example/dl' },
        { provider: 'generic', url: 'https://b.example/dl' }
      ])
    })

    it('什么都没配时是空的', () => {
      expect(resolveUpdateFeeds({})).toEqual([])
    })
  })

  describe('pickFastestFeed', () => {
    const github: UpdateFeed = { provider: 'github', owner: 'o', repo: 'r' }
    const mirror: UpdateFeed = { provider: 'generic', url: 'https://cn.example/dl' }

    /** 一个源没得选，探测请求纯属浪费 */
    it('只有一个源时不发请求', async () => {
      const fetchFn = vi.fn()
      expect(await pickFastestFeed([github], 'latest.yml', fetchFn)).toBe(github)
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('谁先答用谁，输家的请求被掐掉', async () => {
      const signals: AbortSignal[] = []
      const fetchFn = vi.fn((url: string, init: { signal: AbortSignal }) => {
        signals.push(init.signal)
        const delay = url.startsWith('https://github.com/') ? 50 : 1
        return new Promise<{ ok: boolean }>((r) => setTimeout(() => r({ ok: true }), delay))
      })
      expect(await pickFastestFeed([github, mirror], 'latest.yml', fetchFn)).toBe(mirror)
      expect(fetchFn).toHaveBeenCalledWith(
        'https://github.com/o/r/releases/latest/download/latest.yml',
        expect.anything()
      )
      expect(fetchFn).toHaveBeenCalledWith('https://cn.example/dl/latest.yml', expect.anything())
      expect(signals.every((s) => s.aborted)).toBe(true)
    })

    /** 镜像还没传完（404）先答了也不能用 */
    it('先答但不是 200 的不算', async () => {
      const fetchFn = vi.fn((url: string) =>
        url.startsWith('https://cn.')
          ? Promise.resolve({ ok: false })
          : new Promise<{ ok: boolean }>((r) => setTimeout(() => r({ ok: true }), 20))
      )
      expect(await pickFastestFeed([github, mirror], 'latest.yml', fetchFn)).toBe(github)
    })

    /** 全挂了退回主源，让 electron-updater 报出真实的错 */
    it('全都失败时退回主源', async () => {
      const fetchFn = vi.fn(() => Promise.reject(new Error('down')))
      expect(await pickFastestFeed([github, mirror], 'latest.yml', fetchFn)).toBe(github)
    })
  })
})
