/**
 * 文档加载器门禁。
 *
 * 这里**不 mock anydoc**：夹具是当场生成的真 docx / xlsx / pdf，跑的是真解析。
 * 换掉四个解析库的意义就在于「一个真相源」，而只有端到端跑一遍才能证明它真的
 * 通了 —— mock 掉之后测的就只剩 if/else 了。
 *
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import AdmZip from 'adm-zip'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => os.tmpdir()) }
}))

import { ANYDOC_EXTENSIONS, TEXT_EXTENSIONS, loadDocument } from './documentLoader'

let fixtureDir = ''
const fixture = (name: string): string => path.join(fixtureDir, name)

/** 最小可用的 .docx：一个 OPC 包只需要内容类型、根关系、正文三个部件 */
function writeDocx(target: string, bodyXml: string): void {
  const zip = new AdmZip()
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>'
    )
  )
  zip.addFile(
    '_rels/.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>'
    )
  )
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${bodyXml}</w:body></w:document>`,
      'utf8'
    )
  )
  zip.writeZip(target)
}

/** 最小可用的多页 PDF，xref 偏移量按实际字节数算出来 */
function writePdf(target: string, pageTexts: string[]): void {
  const objects: string[] = ['', '']
  const kids: string[] = []
  const fontId = 2 + pageTexts.length * 2 + 1

  pageTexts.forEach((text, index) => {
    const pageId = 3 + index * 2
    const contentId = pageId + 1
    kids.push(`${pageId} 0 R`)
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`
    objects[contentId - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageTexts.length} >>`
  objects[fontId - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets[index] = out.length
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.forEach((offset) => {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`
  })
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`

  fs.writeFileSync(target, Buffer.from(out, 'latin1'))
}

beforeAll(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-loader-'))

  writeDocx(
    fixture('note.docx'),
    '<w:p><w:r><w:t>虚幻引擎笔记：</w:t></w:r>' +
      '<w:r><w:rPr><w:b/></w:rPr><w:t>材质库</w:t></w:r>' +
      '<w:r><w:t>已完成。</w:t></w:r></w:p>'
  )
  writePdf(fixture('manual.pdf'), ['First Page Text', 'Second Page Text'])

  const XLSX = await import('xlsx')
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['项目', '状态'],
      ['蓝图库', '完成']
    ]),
    '进度'
  )
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([['备注'], ['第二张表']]),
    '备注表'
  )
  // 用 write + 自己落盘：XLSX.writeFile 走的是它内部的 fs 垫片，打包环境下拿不到
  fs.writeFileSync(
    fixture('plan.xlsx'),
    XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  )

  fs.writeFileSync(fixture('readme.md'), '# 标题\n\n正文一行。\n', 'utf8')
  // 扩展名说自己是 Word，内容其实是随机字节
  fs.writeFileSync(fixture('broken.docx'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]))
  fs.writeFileSync(fixture('mystery.bin'), Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02, 0x03]))
})

afterAll(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true })
})

describe('格式名单', () => {
  it('ANYDOC_EXTENSIONS 里的每一项 anydoc 都真的认识', async () => {
    const { formatFromExtension } = await import('@firecrawl/anydoc')
    const unrecognized = [...ANYDOC_EXTENSIONS].filter((ext) => !formatFromExtension(ext))

    expect(
      unrecognized,
      `这些扩展名 anydoc 已经不认了，名单该跟着改：${unrecognized.join(', ')}`
    ).toEqual([])
  })

  it('两份名单不重叠——同一个扩展名不能既是文本又是文档', () => {
    const overlap = [...ANYDOC_EXTENSIONS].filter((ext) => TEXT_EXTENSIONS.has(ext))
    expect(overlap).toEqual([])
  })

  it('rtf 归 anydoc，不再被当纯文本读', () => {
    // 回归守卫：以前 rtf 走 loadText，存进知识库的是 \rtf1\ansi 这类控制字
    expect(ANYDOC_EXTENSIONS.has('rtf')).toBe(true)
    expect(TEXT_EXTENSIONS.has('rtf')).toBe(false)
  })

  it('覆盖了此前四个库分别负责的全部格式', () => {
    for (const ext of ['doc', 'docx', 'pdf', 'xls', 'xlsx']) {
      expect(ANYDOC_EXTENSIONS.has(ext), `${ext} 不该在换库后掉队`).toBe(true)
    }
  })

  it('新增了此前完全不支持的演示文稿与电子书格式', () => {
    for (const ext of ['ppt', 'pptx', 'odt', 'ods', 'odp', 'epub']) {
      expect(ANYDOC_EXTENSIONS.has(ext), `${ext} 应当已被支持`).toBe(true)
    }
  })
})

describe('loadDocument 真实解析', () => {
  it('DOCX：正文与加粗都转成 Markdown', async () => {
    const result = await loadDocument(fixture('note.docx'))

    expect(result.success).toBe(true)
    expect(result.content).toContain('虚幻引擎笔记')
    expect(result.content).toContain('**材质库**')
    expect(result.metadata?.title).toBe('note')
  })

  it('PDF：多页文字全部提取', async () => {
    const result = await loadDocument(fixture('manual.pdf'))

    expect(result.success).toBe(true)
    expect(result.content).toContain('First Page Text')
    expect(result.content).toContain('Second Page Text')
  })

  it('XLSX：每张工作表各起一节，转成 Markdown 表格', async () => {
    const result = await loadDocument(fixture('plan.xlsx'))

    expect(result.success).toBe(true)
    expect(result.content).toContain('## 进度')
    expect(result.content).toContain('| 项目 | 状态 |')
    expect(result.content).toContain('| 蓝图库 | 完成 |')
    // 第二张表不能被丢掉——以前那版 loadExcel 就是靠手写循环拼的
    expect(result.content).toContain('## 备注表')
    expect(result.content).toContain('| 第二张表 |')
  })

  it('纯文本：原样读出，不绕解析器', async () => {
    const result = await loadDocument(fixture('readme.md'))

    expect(result.success).toBe(true)
    expect(result.content).toBe('# 标题\n\n正文一行。\n')
  })
})

describe('loadDocument 失败时说人话', () => {
  it('损坏的 Word 文件，给的是中文原因而不是英文异常', async () => {
    // 换库前这里会冒出 mammoth 的 "Can't find end of central directory"
    const result = await loadDocument(fixture('broken.docx'))

    expect(result.success).toBe(false)
    expect(result.error).toBe('文件已损坏，无法解析出内容')
  })

  it('文件不存在', async () => {
    const result = await loadDocument(fixture('nothing-here.pdf'))

    expect(result.success).toBe(false)
    expect(result.error).toBe('文件不存在')
  })

  it('认不出的二进制，明确报不支持', async () => {
    const result = await loadDocument(fixture('mystery.bin'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('暂不支持的文件类型')
  })

  it('音频交给 AI 分析，不当文档解析', async () => {
    const audioPath = fixture('voice.mp3')
    fs.writeFileSync(audioPath, Buffer.from([0x49, 0x44, 0x33, 0x04]))

    const result = await loadDocument(audioPath)

    expect(result.success).toBe(false)
    expect(result.metadata?.isAudio).toBe(true)
  })
})
