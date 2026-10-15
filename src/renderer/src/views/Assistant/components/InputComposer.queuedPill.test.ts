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
describe('InputComposer 排队条', () => {
  // 它是「已经交出去、还没发生」的东西，不能和框里还在手上的字挤在一个框里
  it('排队条在输入框外面，贴在它上方', () => {
    const tray = source.indexOf('class="queued-tray"')
    const composer = source.indexOf('class="input-composer"')
    expect(tray).toBeGreaterThan(-1)
    expect(tray).toBeLessThan(composer)
  })

  it('正文吃掉剩下的宽度，不被压成几个字', () => {
    expect(source).toMatch(/\.queued-text \{[\s\S]*?flex: 1;/)
  })

  // 关闭类按钮按习惯在最右端；夹在中间容易点错
  it('按钮顺序：现在插话、撤回重新编辑、删除', () => {
    const steer = source.indexOf('class="queued-steer"')
    const edit = source.indexOf('handleEditQueued(item.id')
    const remove = source.indexOf('handleCancelQueued(item.id)')
    expect(steer).toBeGreaterThan(-1)
    expect(edit).toBeGreaterThan(steer)
    expect(remove).toBeGreaterThan(edit)
  })

  it('不再显示「这一轮跑完就发」那句单独的提示行', () => {
    expect(source).not.toContain('queueHint')
    expect(source).not.toContain('queued-hint')
  })
})
