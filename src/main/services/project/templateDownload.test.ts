import { describe, expect, it } from 'vitest'
import { sanitizeFileName } from './templateDownload'

/** 控制字符用码点构造，避免字面控制字节落进源码里 */
const CONTROL_CHARS = [0x00, 0x1f, 0x7f].map((code) => String.fromCharCode(code))

/**
 * 模板名来自清单，是**别人写的字符串**，会被直接拼成落盘的文件名。
 * 这里守的是「拼出来的一定是个规矩的文件名」。
 */
describe('模板文件名净化', () => {
  it('保留正常名字和空格', () => {
    expect(sanitizeFileName('Third Person')).toBe('Third Person')
    expect(sanitizeFileName('建筑可视化-5.4')).toBe('建筑可视化-5.4')
  })

  it('替换 Windows 保留字符，反斜杠也算', () => {
    expect(sanitizeFileName('a/b')).toBe('a_b')
    expect(sanitizeFileName('a\\b')).toBe('a_b')
    expect(sanitizeFileName('a:b*c?d"e<f>g|h')).toBe('a_b_c_d_e_f_g_h')
  })

  /**
   * 控制字符在文件名里没有正当用途，却能让路径在日志和界面上显示成另一个样子。
   * 这一条曾经写成一个带控制字符范围的正则，字面控制字节直接落进了源码里。
   */
  it('替换控制字符', () => {
    for (const ch of CONTROL_CHARS) {
      expect(sanitizeFileName(`a${ch}b`)).toBe('a_b')
    }
  })

  /**
   * 开头是点会生成 `.zip` 这种没有主名的隐藏文件，list 扫目录时看到的是一个
   * 名字为空的模板。
   */
  it('去掉开头的点', () => {
    expect(sanitizeFileName('...hidden')).toBe('hidden')
  })

  it('全被过滤光时兜底', () => {
    expect(sanitizeFileName('')).toBe('template')
    expect(sanitizeFileName('...')).toBe('template')
  })
})
