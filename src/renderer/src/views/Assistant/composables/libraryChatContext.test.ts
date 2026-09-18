import { describe, expect, it } from 'vitest'
import { buildLibraryContextMessage, type LibraryChatContext } from './libraryChatContext'

function contextOf(overrides: Partial<LibraryChatContext> = {}): LibraryChatContext {
  return {
    library: 'blueprint',
    entryId: 'entry-1',
    entryName: '受击闪红',
    ...overrides
  }
}

describe('buildLibraryContextMessage', () => {
  it('没有条目就不注入 —— 宁可不带上下文，也别带一条空的', () => {
    expect(buildLibraryContextMessage(null)).toBeNull()
    expect(buildLibraryContextMessage(undefined)).toBeNull()
    expect(buildLibraryContextMessage(contextOf({ entryId: '' }))).toBeNull()
  })

  it('带上条目名、id 和所属库', () => {
    const message = buildLibraryContextMessage(contextOf())!
    expect(message.role).toBe('user')
    expect(message.content).toContain('受击闪红')
    expect(message.content).toContain('entry-1')
    expect(message.content).toContain('蓝图库')
  })

  it('材质库说材质库', () => {
    const message = buildLibraryContextMessage(contextOf({ library: 'material' }))!
    expect(message.content).toContain('材质库')
  })

  it('领域概况原样带进去', () => {
    const message = buildLibraryContextMessage(contextOf({ overview: '节点 5 / 连线 4' }))!
    expect(message.content).toContain('节点 5 / 连线 4')
  })

  it('选中节点带名字和节点文本', () => {
    const message = buildLibraryContextMessage(
      contextOf({
        selectedNodes: [
          { label: '打印字符串', code: 'Begin Object ...' },
          { label: '分支' } // 没有文本的只报名字
        ]
      })
    )!

    expect(message.content).toContain('选中了 2 个节点')
    expect(message.content).toContain('打印字符串')
    expect(message.content).toContain('Begin Object ...')
    expect(message.content).toContain('分支')
  })

  it('没选节点就不提选中这回事 —— 别让模型以为有个空选区', () => {
    const message = buildLibraryContextMessage(contextOf({ selectedNodes: [] }))!
    expect(message.content).not.toContain('选中')
  })

  it('选中太多只列前 8 个，并说明被截了', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ label: `节点${index}` }))
    const message = buildLibraryContextMessage(contextOf({ selectedNodes: many }))!

    expect(message.content).toContain('选中了 12 个节点')
    expect(message.content).toContain('只列出前 8 个')
    expect(message.content).toContain('节点7')
    expect(message.content).not.toContain('节点8')
  })

  it('说清楚库里的条目是离线文本，动工程要用工具', () => {
    /*
     * 旧的库内聊天框没有工具，它的提示词里写着「不要假设可以直接连接
     * Unreal Editor」。换成主助手之后那句话是反的 —— 不纠正的话，模型会
     * 守着旧习惯对着一段文本猜，而它明明能去工程里查。
     */
    const message = buildLibraryContextMessage(contextOf())!
    expect(message.content).toContain('离线文本')
    expect(message.content).toContain('工具')
  })
})
