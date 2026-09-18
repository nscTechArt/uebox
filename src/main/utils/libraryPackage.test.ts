/**
 * 包目录名是用户磁盘上真实存在的东西：洗错一个字符，写进去的名字和磁盘上的名字
 * 就对不上，删的时候找不着、改名时改错目录。清单解析同理 —— 放行一份坏清单，
 * 错误会在很远的地方才炸。所以这两块的边界情况在这里逐条钉死。
 */
import { describe, expect, it } from 'vitest'
import {
  MANIFEST_FORMAT_VERSION,
  buildPackageDirName,
  getFormatTag,
  isPackageDirName,
  isSafeInPackagePath,
  parseManifest,
  parsePackageDirName,
  sanitizeBaseName,
  serializeManifest,
  uniquePackageDirName,
  type LibraryPackageManifest
} from './libraryPackage'

describe('sanitizeBaseName', () => {
  it('中文原样保留', () => {
    expect(sanitizeBaseName('跳跃逻辑')).toBe('跳跃逻辑')
  })

  it('挡掉 Windows 非法字符', () => {
    expect(sanitizeBaseName('a<b>c:d"e/f\\g|h?i*j')).toBe('a b c d e f g h i j')
  })

  it('挡掉控制字符 —— 带换行的目录名会让每一处日志和路径拼接都变成惊喜', () => {
    expect(sanitizeBaseName('foo\nbar')).toBe('foo bar')
    expect(sanitizeBaseName('foo\u0000bar')).toBe('foo bar')
  })

  it('去掉结尾的点和空格 —— Windows 会默默吃掉它们，导致名字对不上', () => {
    expect(sanitizeBaseName('foo.')).toBe('foo')
    expect(sanitizeBaseName('foo   ')).toBe('foo')
    expect(sanitizeBaseName('foo. . ')).toBe('foo')
  })

  it('把连续的点压成一个 —— `..` 是路径语义，不是名字', () => {
    expect(sanitizeBaseName('a..b')).toBe('a.b')
    expect(sanitizeBaseName('..')).toBe('untitled')
  })

  it('保留名字中间的单个点', () => {
    expect(sanitizeBaseName('v1.5 跳跃')).toBe('v1.5 跳跃')
  })

  it('洗空了就兜底', () => {
    expect(sanitizeBaseName('')).toBe('untitled')
    expect(sanitizeBaseName('   ')).toBe('untitled')
    expect(sanitizeBaseName('///')).toBe('untitled')
    expect(sanitizeBaseName(null as unknown as string)).toBe('untitled')
  })

  it('避开 Windows 保留设备名 —— 叫 CON 的目录建不出来，报的错还跟名字无关', () => {
    expect(sanitizeBaseName('CON')).toBe('CON_')
    expect(sanitizeBaseName('con')).toBe('con_')
    expect(sanitizeBaseName('COM1')).toBe('COM1_')
    expect(sanitizeBaseName('LPT9')).toBe('LPT9_')
    // 只是以保留名开头，不算
    expect(sanitizeBaseName('CONFIG')).toBe('CONFIG')
  })

  it('超长截断，且截断后不留结尾的点', () => {
    const name = sanitizeBaseName(`${'长'.repeat(200)}.`)
    expect(name.length).toBeLessThanOrEqual(80)
    expect(name.endsWith('.')).toBe(false)
  })
})

describe('buildPackageDirName / parsePackageDirName', () => {
  it('拼出来的能原样解回去', () => {
    const dirName = buildPackageDirName('blueprint', '跳跃逻辑')
    expect(dirName).toBe('跳跃逻辑.ueblueprint')
    expect(parsePackageDirName(dirName)).toEqual({ library: 'blueprint', baseName: '跳跃逻辑' })
  })

  it('两个库各认各的扩展名', () => {
    expect(buildPackageDirName('material', '苔藓石头')).toBe('苔藓石头.uematerial')
    expect(parsePackageDirName('苔藓石头.uematerial')).toEqual({
      library: 'material',
      baseName: '苔藓石头'
    })
  })

  it('扩展名大小写不敏感 —— 手动改名、从 macOS 拷过来都可能变大小写', () => {
    expect(parsePackageDirName('跳跃逻辑.UEBlueprint')).toEqual({
      library: 'blueprint',
      baseName: '跳跃逻辑'
    })
  })

  it('普通目录不是包', () => {
    expect(parsePackageDirName('Textures')).toBeNull()
    expect(parsePackageDirName('')).toBeNull()
    expect(parsePackageDirName('foo.ueblueprint.bak')).toBeNull()
  })

  it('只有扩展名没有名字的不算包', () => {
    expect(parsePackageDirName('.ueblueprint')).toBeNull()
    expect(parsePackageDirName('   .ueblueprint')).toBeNull()
  })

  it('isPackageDirName 跟 parse 保持一致', () => {
    expect(isPackageDirName('a.uematerial')).toBe(true)
    expect(isPackageDirName('a.uematerials')).toBe(false)
  })
})

describe('uniquePackageDirName', () => {
  it('不撞名时原样用', () => {
    expect(uniquePackageDirName('blueprint', '跳跃', [])).toBe('跳跃.ueblueprint')
  })

  it('撞名时按 Windows 的脾气加序号', () => {
    expect(uniquePackageDirName('blueprint', '跳跃', ['跳跃.ueblueprint'])).toBe(
      '跳跃 (2).ueblueprint'
    )
    expect(
      uniquePackageDirName('blueprint', '跳跃', ['跳跃.ueblueprint', '跳跃 (2).ueblueprint'])
    ).toBe('跳跃 (3).ueblueprint')
  })

  it('比较大小写不敏感 —— Windows 上 Foo 和 foo 是同一个目录', () => {
    expect(uniquePackageDirName('blueprint', 'Foo', ['foo.UEBLUEPRINT'])).toBe(
      'Foo (2).ueblueprint'
    )
  })

  it('先洗名字再判重', () => {
    expect(uniquePackageDirName('blueprint', 'a/b', ['a b.ueblueprint'])).toBe(
      'a b (2).ueblueprint'
    )
  })
})

describe('parseManifest', () => {
  const valid = {
    format: getFormatTag('blueprint'),
    formatVersion: MANIFEST_FORMAT_VERSION,
    id: 'bp-1',
    name: '跳跃逻辑',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    cover: 'cover.png',
    payload: { nodes: [] }
  }

  it('读得出正常清单', () => {
    const parsed = parseManifest(JSON.stringify(valid), 'blueprint')
    expect(parsed).toMatchObject({ id: 'bp-1', name: '跳跃逻辑', cover: 'cover.png' })
    expect(parsed?.payload).toEqual({ nodes: [] })
  })

  it('坏 JSON 返回 null 而不是抛', () => {
    expect(parseManifest('{ 不是 JSON', 'blueprint')).toBeNull()
    expect(parseManifest('', 'blueprint')).toBeNull()
    expect(parseManifest('[]', 'blueprint')).toBeNull()
    expect(parseManifest('null', 'blueprint')).toBeNull()
  })

  it('format 对不上就拒 —— 扩展名对不代表内容对', () => {
    const material = { ...valid, format: getFormatTag('material') }
    expect(parseManifest(JSON.stringify(material), 'blueprint')).toBeNull()
  })

  it('缺 id 或 name 就拒', () => {
    expect(parseManifest(JSON.stringify({ ...valid, id: '' }), 'blueprint')).toBeNull()
    expect(parseManifest(JSON.stringify({ ...valid, name: '  ' }), 'blueprint')).toBeNull()
  })

  it('未来版本的包读不了 —— 硬读会在存回去时把不认识的字段抹掉', () => {
    const future = { ...valid, formatVersion: MANIFEST_FORMAT_VERSION + 1 }
    expect(parseManifest(JSON.stringify(future), 'blueprint')).toBeNull()
  })

  it('版本号不是正整数就拒', () => {
    expect(parseManifest(JSON.stringify({ ...valid, formatVersion: 0 }), 'blueprint')).toBeNull()
    expect(parseManifest(JSON.stringify({ ...valid, formatVersion: 1.5 }), 'blueprint')).toBeNull()
  })

  it('时间戳坏了归零，不影响整体可读', () => {
    const parsed = parseManifest(
      JSON.stringify({ ...valid, createdAt: 'oops', updatedAt: -1 }),
      'blueprint'
    )
    expect(parsed?.createdAt).toBe(0)
    expect(parsed?.updatedAt).toBe(0)
  })

  it('序列化后能原样读回来', () => {
    const manifest = parseManifest(JSON.stringify(valid), 'blueprint') as LibraryPackageManifest
    const roundTrip = parseManifest(serializeManifest(manifest), 'blueprint')
    expect(roundTrip).toEqual(manifest)
  })

  it('写盘的文本是给人看的：带缩进、以换行结尾', () => {
    const manifest = parseManifest(JSON.stringify(valid), 'blueprint') as LibraryPackageManifest
    const text = serializeManifest(manifest)
    expect(text).toContain('\n  "id"')
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('isSafeInPackagePath', () => {
  it('放行包内的正常相对路径', () => {
    expect(isSafeInPackagePath('cover.png')).toBe(true)
    expect(isSafeInPackagePath('textures/moss_basecolor.png')).toBe(true)
  })

  it('拦住往上爬 —— 清单是数据，手改过的包可能写成 ../../etc/passwd', () => {
    expect(isSafeInPackagePath('../cover.png')).toBe(false)
    expect(isSafeInPackagePath('textures/../../x.png')).toBe(false)
    expect(isSafeInPackagePath('./cover.png')).toBe(false)
  })

  it('拦住绝对路径和反斜杠', () => {
    expect(isSafeInPackagePath('/etc/passwd')).toBe(false)
    expect(isSafeInPackagePath('C:/Windows/x.png')).toBe(false)
    expect(isSafeInPackagePath('textures\\x.png')).toBe(false)
  })

  it('拦住空值和空段', () => {
    expect(isSafeInPackagePath('')).toBe(false)
    expect(isSafeInPackagePath('a//b.png')).toBe(false)
    expect(isSafeInPackagePath('cover\u0000.png')).toBe(false)
  })
})
