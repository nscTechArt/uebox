import { describe, expect, it } from 'vitest'
import { applyRolePatch, sanitizeRolePatch, unsavedRoles } from './aiProvider'

/** 改角色的补丁：洗干净、合并、找出没留住的 */
describe('角色补丁', () => {
  const a = { providerId: 'p', modelId: 'a' }
  const b = { providerId: 'p', modelId: 'b' }

  it('合并：补丁里的覆盖，null 删除，别的不动', () => {
    expect(applyRolePatch({ chat: a, agent: a, summary: a }, { agent: b, summary: null })).toEqual({
      chat: a,
      agent: b
    })
  })

  it('洗补丁：只认已知角色，绑定只留两个字符串字段，形状不对的整条丢掉', () => {
    expect(
      sanitizeRolePatch({
        chat: { ...a, source: 'plan', extra: 1 },
        agent: null,
        vision: { providerId: 1, modelId: 'x' },
        nonsense: a
      })
    ).toEqual({ chat: a, agent: null })
    expect(sanitizeRolePatch(null)).toEqual({})
    expect(sanitizeRolePatch('chat')).toEqual({})
  })

  it('没留住的：要设的角色落盘后不是这个绑定；清空的不算', () => {
    expect(unsavedRoles({ chat: a }, { chat: a, agent: b, summary: null })).toEqual(['agent'])
  })
})
