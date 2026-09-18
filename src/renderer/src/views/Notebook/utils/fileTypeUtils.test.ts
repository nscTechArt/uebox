/**
 * 知识库里每条来源标着的「文件类型」也得跟着界面语言走。
 *
 * 红灯用例：把界面切成 English，知识库里一条 PDF 来源下面写着「PDF 文档」，
 * 一段录音写着「MP3 音频」—— 55 条这样的标签全是写死的中文。
 *
 * 拆成「格式名 + 名词」之后，这里守的是：每个名词两侧都配了文案、
 * 拼出来的话顺、以及没有格式名的那几种别拼出个前导空格。
 */
import { describe, expect, it, beforeEach } from 'vitest'

import enUS from '@renderer/i18n/locales/en-US'
import i18n from '@renderer/i18n'
import zhCN from '@renderer/i18n/locales/zh-CN'

import { getFileTypeInfo, getFileTypeLabel, isSupportedSourceFile } from './fileTypeUtils'

describe('getFileTypeLabel', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh-CN'
  })

  it('跟着界面语言走 —— 这条用例存在的全部理由', () => {
    expect(getFileTypeLabel('合同.pdf')).toBe('PDF 文档')
    i18n.global.locale.value = 'en-US'
    expect(getFileTypeLabel('合同.pdf')).toBe('PDF document')
  })

  it.each([
    ['报表.xlsx', 'Excel 表格', 'Excel spreadsheet'],
    ['宣讲.pptx', 'PowerPoint 演示文稿', 'PowerPoint presentation'],
    ['放映.pps', 'PowerPoint 放映', 'PowerPoint slideshow'],
    ['图.svg', 'SVG 矢量图', 'SVG vector image'],
    ['录音.mp3', 'MP3 音频', 'MP3 audio'],
    ['片子.mp4', 'MP4 视频', 'MP4 video']
  ])('%s 两侧都拼得通顺', (name, zh, en) => {
    expect(getFileTypeLabel(name)).toBe(zh)
    i18n.global.locale.value = 'en-US'
    expect(getFileTypeLabel(name)).toBe(en)
  })

  /*
   * 「文本文件 / 图标文件 / 文件」这三种没有格式名可拼。模板里要是照样写
   * `{format} 文件`，拼出来就是一个前导空格加「文件」—— 界面上看着像没对齐。
   */
  it('没有格式名的那几种不留前导空格', () => {
    for (const name of ['readme.txt', 'favicon.ico', '无后缀文件.zzz']) {
      const label = getFileTypeLabel(name)
      expect(label, name).toBe(label.trim())
      expect(label, name).not.toContain('{format}')
    }
  })

  it('认不出的后缀退回通用「文件」，不返回 undefined', () => {
    expect(getFileTypeLabel('x.zzz')).toBe('文件')
    expect(getFileTypeInfo('x.zzz').category).toBe('other')
  })

  it('每个名词在中英两侧都配了文案', () => {
    const zh = Object.keys(zhCN.notebook.fileTypes).sort()
    const en = Object.keys(enUS.notebook.fileTypes).sort()
    expect(en).toEqual(zh)
  })

  /*
   * 映射表里用到的每个名词都得在语言包里 —— 漏一个的表现是界面上直接显示
   * `notebook.fileTypes.ebook` 这样的 key。
   */
  it('映射表里用到的名词全部有文案', () => {
    const known = new Set(Object.keys(zhCN.notebook.fileTypes))
    const samples = [
      'a.docx',
      'a.pdf',
      'a.xlsx',
      'a.pptx',
      'a.pps',
      'a.pot',
      'a.odt',
      'a.ods',
      'a.odp',
      'a.rtf',
      'a.epub',
      'a.txt',
      'a.md',
      'a.json',
      'a.xml',
      'a.csv',
      'a.jpg',
      'a.png',
      'a.ico',
      'a.svg',
      'a.mp3',
      'a.mp4',
      'a.zzz'
    ]
    const missing = samples.filter((name) => !known.has(getFileTypeInfo(name).noun))
    expect(missing).toEqual([])
  })

  // 这个文件还管着「知识库收不收」，改标签别把它弄坏
  it('支持判断没被改动波及', () => {
    expect(isSupportedSourceFile('a.pdf')).toBe(true)
    expect(isSupportedSourceFile('a.exe')).toBe(false)
  })
})
