import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeUeText, readUeJsonFile, readUeTextFile } from './ueTextFile'

/** 引擎存 UTF-16LE 时的样子：BOM + 每个字符两字节 */
function utf16le(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

function utf16be(text: string): Buffer {
  const body = Buffer.from(text, 'utf16le')
  body.swap16()
  return Buffer.concat([Buffer.from([0xfe, 0xff]), body])
}

const tmp = mkdtempSync(join(tmpdir(), 'ue-text-'))

describe('decodeUeText', () => {
  it('按 UTF-8 读没有 BOM 的文件', () => {
    expect(decodeUeText(Buffer.from('{"A":"中文"}', 'utf8'))).toBe('{"A":"中文"}')
  })

  it('剥掉 UTF-8 BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"A":1}', 'utf8')])
    expect(decodeUeText(buf)).toBe('{"A":1}')
  })

  it('解 UTF-16LE —— 引擎保存含中文的 .uproject 时用的就是它', () => {
    expect(decodeUeText(utf16le('{"Description":"纯蓝图工程"}'))).toBe(
      '{"Description":"纯蓝图工程"}'
    )
  })

  it('解 UTF-16BE', () => {
    expect(decodeUeText(utf16be('{"Description":"纯蓝图工程"}'))).toBe(
      '{"Description":"纯蓝图工程"}'
    )
  })

  it('UTF-16BE 被截断成奇数长度时丢掉半个字符，而不是抛异常', () => {
    const truncated = utf16be('AB').subarray(0, 5)
    expect(() => decodeUeText(truncated)).not.toThrow()
    expect(decodeUeText(truncated)).toBe('A')
  })

  it('空文件返回空串', () => {
    expect(decodeUeText(Buffer.alloc(0))).toBe('')
  })
})

describe('readUeJsonFile', () => {
  /**
   * 这是真实事故的回归用例：中文工程被 UE 存成 UTF-16 之后，
   * 按 utf-8 读会得到 `��{\0...`，JSON.parse 抛 `Unexpected token '�'`，
   * 结果是 UnrealAgentLink 装不上、AI 看不见引擎。
   */
  it('读得动 UTF-16LE 的 .uproject', async () => {
    const file = join(tmp, 'ChineseProject.uproject')
    writeFileSync(
      file,
      utf16le(
        JSON.stringify({
          FileVersion: 3,
          EngineAssociation: '5.5',
          Description: '纯蓝图工程 —— 验收专用',
          Plugins: [{ Name: 'PCG', Enabled: true }]
        })
      )
    )

    const data = await readUeJsonFile<{
      EngineAssociation?: string
      Description?: string
      Plugins?: Array<{ Name: string }>
    }>(file)

    expect(data.EngineAssociation).toBe('5.5')
    expect(data.Description).toBe('纯蓝图工程 —— 验收专用')
    expect(data.Plugins?.[0].Name).toBe('PCG')
  })

  it('读得动普通 UTF-8 的 .uproject', async () => {
    const file = join(tmp, 'Plain.uproject')
    writeFileSync(file, JSON.stringify({ EngineAssociation: '5.4' }), 'utf8')
    expect(await readUeJsonFile<{ EngineAssociation?: string }>(file)).toEqual({
      EngineAssociation: '5.4'
    })
  })

  it('带 UTF-8 BOM 的也能 JSON.parse —— BOM 不是合法的 JSON 起始字符', async () => {
    const file = join(tmp, 'Bom.uproject')
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"A":1}')]))
    expect(await readUeJsonFile<{ A: number }>(file)).toEqual({ A: 1 })
  })
})

describe('readUeTextFile', () => {
  it('UTF-16 的 ini 也读得回来', async () => {
    const file = join(tmp, 'Editor.ini')
    writeFileSync(file, utf16le('[Section]\nKey=值\n'))
    expect(await readUeTextFile(file)).toBe('[Section]\nKey=值\n')
  })
})
