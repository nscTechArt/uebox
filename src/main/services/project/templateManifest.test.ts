import { describe, expect, it } from 'vitest'
import { parseManifest, resolveAssetUrl } from './templateManifest'

const MANIFEST_URL = 'https://example.com/templates/manifest.json'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    name: 'Demo',
    description: '一个示例模板',
    category: 'game',
    engineVersion: '5.4',
    packageUrl: 'packages/demo.zip',
    size: 1024,
    sha256: SHA_A,
    version: '1.0.0',
    author: '某人',
    license: 'MIT',
    ...overrides
  }
}

/**
 * 清单是**别人写的 JSON**：字段缺、类型错、多写不认识的键都是常态，
 * 一条脏数据不该把整个源废掉。但和安全相关的两条不宽容 —— 见下面两组用例。
 */
describe('社区模板清单解析', () => {
  it('丢掉坏条目，保留其余的', () => {
    const { manifest, skipped } = parseManifest(
      {
        formatVersion: 1,
        templates: [
          entry(),
          entry({ id: '', name: '没有 id' }),
          entry({ id: 'no-name', name: '' }),
          'not-an-object',
          null
        ]
      },
      MANIFEST_URL
    )

    expect(manifest.templates.map((item) => item.id)).toEqual(['demo'])
    expect(skipped).toBe(4)
  })

  /**
   * 没有 sha256 就没法确认下载到的字节是清单作者写的那份。模板包解压出来是一个
   * UE 工程，打开就会跑里面的东西，所以这一条不能"宽容处理"。
   */
  it('丢掉没有合法 sha256 的条目', () => {
    const { manifest, skipped } = parseManifest(
      {
        formatVersion: 1,
        templates: [
          entry({ id: 'no-hash', sha256: undefined }),
          entry({ id: 'short-hash', sha256: 'abc' }),
          entry({ id: 'not-hex', sha256: 'z'.repeat(64) }),
          entry({ id: 'ok', sha256: SHA_B })
        ]
      },
      MANIFEST_URL
    )

    expect(manifest.templates.map((item) => item.id)).toEqual(['ok'])
    expect(skipped).toBe(3)
  })

  it('把相对的 packageUrl 解析成绝对地址', () => {
    const { manifest } = parseManifest({ formatVersion: 1, templates: [entry()] }, MANIFEST_URL)
    expect(manifest.templates[0].packageUrl).toBe('https://example.com/templates/packages/demo.zip')
  })

  it('同一个 id 只认第一条', () => {
    const { manifest, skipped } = parseManifest(
      {
        formatVersion: 1,
        templates: [entry({ name: '第一条' }), entry({ name: '第二条' })]
      },
      MANIFEST_URL
    )
    expect(manifest.templates).toHaveLength(1)
    expect(manifest.templates[0].name).toBe('第一条')
    expect(skipped).toBe(1)
  })

  it('不认识的分类归到 other', () => {
    const { manifest } = parseManifest(
      { formatVersion: 1, templates: [entry({ category: '玄学' })] },
      MANIFEST_URL
    )
    expect(manifest.templates[0].category).toBe('other')
  })

  it('拒绝不支持的清单格式版本', () => {
    expect(() => parseManifest({ formatVersion: 2, templates: [] }, MANIFEST_URL)).toThrow()
    expect(() => parseManifest({ templates: [] }, MANIFEST_URL)).toThrow()
    expect(() => parseManifest('nope', MANIFEST_URL)).toThrow()
  })
})

/**
 * 清单走 https、包却指向 http，等于把 https 的保护绕过去了 ——
 * 中间人可以换掉包体，而用户看到的仍然是一个"https 的源"。
 */
describe('清单内地址解析', () => {
  it('拒绝把 https 清单里的包降级成 http', () => {
    expect(resolveAssetUrl('http://evil.example/x.zip', MANIFEST_URL)).toBeNull()
  })

  it('允许 http 清单里的 http 包（内网自建源）', () => {
    expect(resolveAssetUrl('x.zip', 'http://nas.local/manifest.json')).toBe(
      'http://nas.local/x.zip'
    )
  })

  it('拒绝 http/https 之外的协议', () => {
    expect(resolveAssetUrl('file:///C:/evil.zip', MANIFEST_URL)).toBeNull()
    expect(resolveAssetUrl('data:application/zip;base64,AAAA', MANIFEST_URL)).toBeNull()
  })

  it('空地址返回 null', () => {
    expect(resolveAssetUrl('', MANIFEST_URL)).toBeNull()
  })
})
