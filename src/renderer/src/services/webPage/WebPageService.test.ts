import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamedChatParams } from '@renderer/api/ai'
import { getNotebookTaskService } from '../notebook/NotebookTaskService'
import { WebPageService } from './WebPageService'

const aiMocks = vi.hoisted(() => ({
  chatText: vi.fn()
}))

vi.mock('@renderer/api/ai', () => ({
  aiAPI: { chatText: aiMocks.chatText }
}))

vi.mock('@renderer/i18n', () => ({
  getLocale: () => 'zh-CN'
}))

const SOURCES = [{ id: 's1', title: '光照笔记', content: '关于 Lumen 的记录。' }] as never

/**
 * 等到配方真的把请求发出去。
 *
 * 不能用一句 `await Promise.resolve()` 顶替：配方在发请求之前还要读一次模型窗口
 * 和自定义提示词（都是异步），微任务数量会随实现变，写死几个就是在赌。
 */
async function waitForModelCall(): Promise<void> {
  for (let i = 0; i < 200 && aiMocks.chatText.mock.calls.length === 0; i++) {
    await Promise.resolve()
  }
}

describe('WebPageService', () => {
  beforeEach(() => {
    // 用花括号：箭头直接返回 mockReset() 的返回值（mock 本身），vitest 会把它
    // 当成 teardown 回调，在用例结束后不带参数再调一次
    aiMocks.chatText.mockReset()
  })

  /**
   * `reset()` 曾经调的是**全局**取消（`cancelNotebookTask`），而面板每次生成网页
   * 前都会先 reset —— 于是「思维导图跑到一半时点网页」会把思维导图一起掐掉。
   */
  it('reset 不会掐掉其它正在跑的产出', async () => {
    // 一个永远跑不完的思维导图任务：被中止时才结束
    aiMocks.chatText.mockImplementation(
      (params: StreamedChatParams) =>
        new Promise((_resolve, reject) => {
          params.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )

    let mindmapSettled = false
    const mindmap = getNotebookTaskService()
      .executeTask('mindmap', SOURCES, [], { notebookId: 'nb1' })
      .catch(() => undefined)
      .finally(() => {
        mindmapSettled = true
      })

    new WebPageService().reset()
    await Promise.resolve()
    await Promise.resolve()

    expect(mindmapSettled).toBe(false)

    // 收尾：把它掐掉，别把一个永远 pending 的任务留给下一个用例
    getNotebookTaskService().cancel('nb1:mindmap')
    await mindmap
  })

  it('生成网页时把模型给的 HTML 修一遍结构再交出去', async () => {
    aiMocks.chatText
      .mockResolvedValueOnce('{"title":"Lumen 入门"}')
      .mockResolvedValueOnce('<!DOCTYPE html><html><body><p>页面</p></html>')

    const service = new WebPageService()
    const html = await service.generateAsync(SOURCES, [], 'nb2')

    expect(html?.startsWith('<!DOCTYPE html>')).toBe(true)
    // DOMParser 会把漏掉的 </body> 补回来
    expect(html).toContain('</body>')
    expect(service.state.value.status).toBe('completed')
  })

  it('用户取消时回到 idle，不留一个红色报错', async () => {
    const service = new WebPageService()

    aiMocks.chatText.mockImplementation(
      (params: StreamedChatParams) =>
        new Promise((_resolve, reject) => {
          params.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )

    const pending = service.generateAsync(SOURCES, [], 'nb3')
    await waitForModelCall()
    getNotebookTaskService().cancel('nb3:webpage')

    expect(await pending).toBeNull()
    expect(service.state.value.status).toBe('idle')
    expect(service.state.value.error).toBeUndefined()
  })
})
