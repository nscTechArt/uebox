import { describe, expect, it } from 'vitest'
import { finalReplyText } from './finalReplyText'
import type { AgentProcessItem } from '../components/AgentProcessLog.types'

const items: AgentProcessItem[] = [
  { type: 'text', data: { text: '先查看路径。\n\n' }, timestamp: 1 },
  { type: 'tool-call', data: { name: 'list_local_dir' }, timestamp: 2 },
  { type: 'tool-result', data: { result: '工具内部记录' }, timestamp: 3 },
  { type: 'text', data: { text: '找到了旧记录。' }, timestamp: 4 }
]

describe('最终答复那一段', () => {
  it('只取最后一次工具调用之后说的话，前面的解说和工具记录都不要', () => {
    expect(finalReplyText('先查看路径。\n\n找到了旧记录。', items)).toBe('找到了旧记录。')
  })

  it('content 里超出时间线的那截照样算数（最终结论、老消息都长在那儿）', () => {
    expect(finalReplyText('最终结论。', items)).toBe('找到了旧记录。\n\n最终结论。')
    expect(finalReplyText('普通回复')).toBe('普通回复')
  })

  it('那一轮停在工具调用上就退回上一段解说，而不是交出一片静默', () => {
    expect(finalReplyText('先查看路径。', items.slice(0, 3))).toBe('先查看路径。')
  })

  it('崩了的那一轮念崩之前说到哪了，不念末尾那句错误', () => {
    expect(finalReplyText('错误: This operation was aborted', items, true)).toBe('找到了旧记录。')
    expect(finalReplyText('错误: aborted', [], true)).toBe('')
  })

  it('正常回复里谈到错误不算崩了', () => {
    expect(finalReplyText('Error: means an error in this example.')).toBe(
      'Error: means an error in this example.'
    )
  })
})
