import { describe, expect, it } from 'vitest'
import { describeUpdateFeed, resolveUpdateFeed } from './updateFeed'

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
})
