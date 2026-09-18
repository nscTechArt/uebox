import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  contentTypeFor,
  parseRangeHeader,
  resolveLocalResourcePath,
  serveLocalFile
} from './localResourceServer'

describe('resolveLocalResourcePath', () => {
  it('还原 Windows 盘符（Chromium 把 C: 当 host + 空端口，冒号会被吃掉）', () => {
    expect(resolveLocalResourcePath('local-resource://c/Users/me/a.png', 'win32')).toBe(
      'c:/Users/me/a.png'
    )
  })

  it('盘符原样保留时也能解析', () => {
    expect(resolveLocalResourcePath('local-resource://C:/Users/me/a.png', 'win32')).toBe(
      'C:/Users/me/a.png'
    )
  })

  it('多余的前导斜杠不影响盘符', () => {
    expect(resolveLocalResourcePath('local-resource:///C:/db/a.png', 'win32')).toBe('C:/db/a.png')
  })

  it('解码中文等百分号转义', () => {
    const url = `local-resource://H:/${encodeURIComponent('资产库')}/${encodeURIComponent('封面 1.png')}`
    expect(resolveLocalResourcePath(url, 'win32')).toBe('H:/资产库/封面 1.png')
  })

  it('剥掉 query 和 hash，避免被当成文件名的一部分', () => {
    expect(resolveLocalResourcePath('local-resource://c/a/b.png?v=2#top', 'win32')).toBe(
      'c:/a/b.png'
    )
  })

  it('裸 % 不会让整条路径解析失败', () => {
    expect(resolveLocalResourcePath('local-resource://c/a/100%bad/b.png', 'win32')).toBe(
      'c:/a/100%bad/b.png'
    )
  })

  it('POSIX 平台补回绝对路径的前导斜杠', () => {
    expect(resolveLocalResourcePath('local-resource://home/me/a.png', 'darwin')).toBe(
      '/home/me/a.png'
    )
    expect(resolveLocalResourcePath('local-resource:///home/me/a.png', 'linux')).toBe(
      '/home/me/a.png'
    )
  })
})

describe('contentTypeFor', () => {
  it('按扩展名给出常见类型', () => {
    expect(contentTypeFor('a/b/c.png')).toBe('image/png')
    expect(contentTypeFor('a.MP4')).toBe('video/mp4')
    expect(contentTypeFor('a.glb')).toBe('model/gltf-binary')
  })

  it('认不出来的扩展名回落到 octet-stream', () => {
    expect(contentTypeFor('a.uasset')).toBe('application/octet-stream')
    expect(contentTypeFor('noext')).toBe('application/octet-stream')
  })
})

describe('parseRangeHeader', () => {
  it('没有 Range 时返回 null', () => {
    expect(parseRangeHeader(null, 100)).toBeNull()
    expect(parseRangeHeader('', 100)).toBeNull()
    expect(parseRangeHeader('bytes=-', 100)).toBeNull()
  })

  it('解析闭区间', () => {
    expect(parseRangeHeader('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
  })

  it('省略结尾时读到文件末尾', () => {
    expect(parseRangeHeader('bytes=10-', 100)).toEqual({ start: 10, end: 99 })
  })

  it('后缀区间取最后 N 字节', () => {
    expect(parseRangeHeader('bytes=-20', 100)).toEqual({ start: 80, end: 99 })
  })

  it('结尾越界时截到文件末尾', () => {
    expect(parseRangeHeader('bytes=90-999', 100)).toEqual({ start: 90, end: 99 })
  })

  it('起点越界或区间倒置时判定为不可满足', () => {
    expect(parseRangeHeader('bytes=100-200', 100)).toBe('unsatisfiable')
    expect(parseRangeHeader('bytes=50-10', 100)).toBe('unsatisfiable')
    expect(parseRangeHeader('bytes=-0', 100)).toBe('unsatisfiable')
  })

  it('多区间不支持，按无 Range 处理', () => {
    expect(parseRangeHeader('bytes=0-9,20-29', 100)).toBeNull()
  })
})

describe('serveLocalFile', () => {
  let dir: string
  let filePath: string
  const content = Buffer.from('0123456789abcdefghij')

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'local-resource-'))
    filePath = join(dir, 'clip.mp4')
    writeFileSync(filePath, content)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('无 Range 时返回 200 + 完整内容，并声明支持 Range', async () => {
    const res = await serveLocalFile(filePath)
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('content-length')).toBe(String(content.length))
    expect(Buffer.from(await res.arrayBuffer())).toEqual(content)
  })

  it('带 Range 时返回 206 + Content-Range（Chromium 靠这个才能拖进度条）', async () => {
    const res = await serveLocalFile(filePath, 'bytes=5-9')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 5-9/${content.length}`)
    expect(res.headers.get('content-length')).toBe('5')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('56789')
  })

  it('区间越界返回 416', async () => {
    const res = await serveLocalFile(filePath, 'bytes=999-')
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${content.length}`)
  })

  it('文件不存在返回 404', async () => {
    const res = await serveLocalFile(join(dir, 'missing.png'))
    expect(res.status).toBe(404)
  })

  it('目录返回 404，而不是抛异常', async () => {
    const res = await serveLocalFile(dir)
    expect(res.status).toBe(404)
  })
})
