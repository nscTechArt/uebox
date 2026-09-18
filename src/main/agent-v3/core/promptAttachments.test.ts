/** @vitest-environment node */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * 真机上的缺口：用户贴了图说「照着这张图生成 3D 模型」，模型看得见图，
 * 却回了一句「我这边拿不到它的本地文件路径」，然后退回文生 3D 用文字硬凑 ——
 * 而图生 3D 稳得多，用户要的正是那张图。
 *
 * 这一组守的就是那个句柄：图落盘、路径进提示词、措辞挡住「用文字描述代替」。
 */

const root = join(tmpdir(), `ub-attach-test-${process.pid}`)

vi.mock('electron', () => ({ app: { getPath: () => root } }))

const { savePromptAttachments, formatAttachmentBlock, stripAttachmentBlock } = await import(
  './promptAttachments'
)

const png = (content: string): { type: 'image'; data: string; mimeType: string } => ({
  type: 'image',
  data: Buffer.from(content).toString('base64'),
  mimeType: 'image/png'
})

beforeEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('落盘', () => {
  it('把贴的图写到盘上并回出真实存在的路径', async () => {
    const saved = await savePromptAttachments([png('fake-image-bytes')])

    expect(saved).toHaveLength(1)
    await expect(fs.readFile(saved[0].path, 'utf-8')).resolves.toBe('fake-image-bytes')
  })

  it('按媒体类型给扩展名 —— 下游按扩展名判类型，不能留空', async () => {
    const saved = await savePromptAttachments([
      { type: 'image', data: Buffer.from('a').toString('base64'), mimeType: 'image/jpeg' },
      { type: 'image', data: Buffer.from('b').toString('base64'), mimeType: 'image/webp' },
      { type: 'image', data: Buffer.from('c').toString('base64'), mimeType: '天知道' }
    ])

    // 文件名是内容哈希，只能断言扩展名
    const extensions = saved.map((item) => item.path.slice(item.path.lastIndexOf('.')))
    expect(extensions).toEqual(['.jpg', '.webp', '.png'])
  })

  /** 改一句话重发是常态，同一张图不该在磁盘上堆出一堆副本 */
  it('同一张图重复贴只落一份，路径也是同一个', async () => {
    const first = await savePromptAttachments([png('same')])
    const second = await savePromptAttachments([png('same')])

    expect(second[0].path).toBe(first[0].path)
    expect(await fs.readdir(join(root, 'unreal-box-attachments'))).toHaveLength(1)
  })

  it('没有图时不建目录也不做任何事', async () => {
    expect(await savePromptAttachments(undefined)).toEqual([])
    expect(await savePromptAttachments([])).toEqual([])
    await expect(fs.access(join(root, 'unreal-box-attachments'))).rejects.toThrow()
  })

  /**
   * 落盘只是「顺带的便利」—— 图照常进模型上下文，模型仍然看得见。
   * 为它把整轮对话打断，代价不成比例。
   */
  it('单张坏数据跳过，其余照存，不抛异常', async () => {
    const saved = await savePromptAttachments([
      { type: 'image', data: '', mimeType: 'image/png' },
      png('good')
    ])

    expect(saved).toHaveLength(1)
    await expect(fs.readFile(saved[0].path, 'utf-8')).resolves.toBe('good')
  })
})

describe('给模型看的那段话', () => {
  it('列出每个路径，并要求把路径交给工具', async () => {
    const block = formatAttachmentBlock([{ path: 'C:/tmp/a.png', mimeType: 'image/png' }])

    expect(block).toContain('C:/tmp/a.png')
    expect(block).toContain('pass the PATH')
  })

  /** 这一句是真机那次的直接教训：没路径时模型会退而用文字描述去做文生 */
  it('明确挡住「用文字描述代替图片」', async () => {
    const block = formatAttachmentBlock([{ path: 'C:/tmp/a.png', mimeType: 'image/png' }])

    expect(block).toMatch(/Do not describe the image in words as a substitute/)
  })

  it('没有附件时是空串，不往提示词里塞一个空块', () => {
    expect(formatAttachmentBlock([])).toBe('')
  })
})

/**
 * 剥回原话。
 *
 * 插话的生效回执按**文本相等**匹配：界面上存着用户打的那句，模型收到的是
 * 「附件块 + 原话」。剥不干净的话，带图的插话会一直显示「未生效」，
 * 而它其实早就进上下文了。
 */
describe('剥掉附件块', () => {
  it('拼上去再剥回来，等于原话', () => {
    const block = formatAttachmentBlock([{ path: 'C:/tmp/a.png', mimeType: 'image/png' }])

    expect(stripAttachmentBlock(`${block}\n\n照着这张改`)).toBe('照着这张改')
  })

  it('没有块的照原样返回', () => {
    expect(stripAttachmentBlock('照着这张改')).toBe('照着这张改')
  })

  /** 只认开头那一处：正文里出现同名标签是用户自己打的字，动它就是改用户的话 */
  it('不动正文中间出现的同名标签', () => {
    const text = '帮我解释一下 <attachments> 这个标签</attachments>'

    expect(stripAttachmentBlock(text)).toBe(text)
  })
})
