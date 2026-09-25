import { describe, expect, it } from 'vitest'
import { labelToolResultImages } from './toolImageLabels'

const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
const tool = (images: number): { role: string; content: unknown[] } => ({
  role: 'toolResult',
  content: [{ type: 'text', text: 'Read image file' }, ...Array(images).fill(image)]
})
const labelOf = (message: unknown): string =>
  (message as { content: { text: string }[] }).content[0].text

describe('给工具结果里的图标序号', () => {
  it('一串连续工具结果按 pi 摘图的顺序累加，图数不同也对得上', () => {
    const out = labelToolResultImages([tool(1), tool(0), tool(2), tool(1)])
    expect(labelOf(out[0])).toContain('第 1 张')
    expect(labelOf(out[1])).toBe('Read image file')
    expect(labelOf(out[2])).toContain('第 2–3 张')
    expect(labelOf(out[3])).toContain('第 4 张')
  })

  it('中间隔了别的消息就重新从 1 数 —— 那是另一条附图消息', () => {
    const out = labelToolResultImages([tool(1), { role: 'assistant', content: [] }, tool(1)])
    expect(labelOf(out[2])).toContain('第 1 张')
  })

  it('没有图就原样返回同一个数组', () => {
    const messages = [tool(0), { role: 'user', content: [] }]
    expect(labelToolResultImages(messages)).toBe(messages)
  })
})
