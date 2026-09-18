import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/Assistant/components/InputComposer.vue'),
  'utf8'
)

/**
 * 排队消息那一行：正文是用户刚打的一句话，得看得见。
 *
 * 缩成「记得打…」等于没显示 —— 用户分不清排着的是哪一条，也就没法判断
 * 要不要撤回。
 */
describe('InputComposer 排队标签', () => {
  /*
   * `.queued-pill` 是 `.source-pill` 的变体，两边权重一样，谁在后面谁说了算。
   * 写反过一次：`max-width: none` 被基类的 200px 顶掉，正文被压回几个字，
   * 而样式本身看起来完全正确 —— 这种回归只有顺序检查能逮住。
   */
  it('样式排在 .source-pill 后面，才盖得住那条 200px', () => {
    expect(source.indexOf('\n.queued-pill {')).toBeGreaterThan(source.indexOf('\n.source-pill {'))
  })

  it('整行铺开，正文吃掉剩下的宽度', () => {
    expect(source).toContain('flex-direction: column')
    expect(source).toMatch(/\.queued-pill \{[\s\S]*?max-width: none;/)
  })

  // 按钮挤在文字旁边会把正文压没，所以它在整行最右端
  it('「立即发送」排在删除按钮之后', () => {
    expect(source.indexOf('class="pill-action"')).toBeGreaterThan(
      source.indexOf('class="pill-remove"')
    )
  })

  it('不再显示「这一轮跑完就发」那句提示', () => {
    expect(source).not.toContain('queueHint')
    expect(source).not.toContain('queued-hint')
  })
})
