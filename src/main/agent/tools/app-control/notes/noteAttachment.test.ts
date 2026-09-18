import { describe, expect, it } from 'vitest'

import { alreadyAttachedError, resolveAttachTarget, targetNotFoundError } from './noteAttachment'

describe('resolveAttachTarget', () => {
  it('给了 assetKey 就挂资产', () => {
    expect(resolveAttachTarget({ assetKey: 'a-1' })).toEqual({
      ok: true,
      target: { kind: 'asset', key: 'a-1' }
    })
  })

  it('给了 folderKey 就挂文件夹', () => {
    expect(resolveAttachTarget({ folderKey: 'f-1' })).toEqual({
      ok: true,
      target: { kind: 'folder', key: 'f-1' }
    })
  })

  it('两个都不给要拒绝 —— 没有挂载的笔记用户看不到', () => {
    const result = resolveAttachTarget({})
    expect(result.ok).toBe(false)
  })

  it('两个都给也拒绝，让模型自己说清楚挂哪儿', () => {
    const result = resolveAttachTarget({ assetKey: 'a-1', folderKey: 'f-1' })
    expect(result.ok).toBe(false)
  })

  it('空串和纯空白等于没给', () => {
    expect(resolveAttachTarget({ assetKey: '' }).ok).toBe(false)
    expect(resolveAttachTarget({ assetKey: '   ' }).ok).toBe(false)
    expect(resolveAttachTarget({ folderKey: '\t' }).ok).toBe(false)
  })

  it('key 两头的空白会被去掉', () => {
    expect(resolveAttachTarget({ assetKey: '  a-1  ' })).toEqual({
      ok: true,
      target: { kind: 'asset', key: 'a-1' }
    })
  })

  it('错误话术要告诉模型下一步怎么做，不能只说「你错了」', () => {
    const result = resolveAttachTarget({})
    if (result.ok) throw new Error('应该拒绝')
    expect(result.error).toContain('assetKey')
    expect(result.error).toContain('folderKey')
    // 光说缺参数，模型不知道去哪儿找 key
    expect(result.error).toContain('search_assets')
  })
})

describe('alreadyAttachedError', () => {
  it('带上已有笔记的 id，并指向 update_note 而不是新建', () => {
    const message = alreadyAttachedError({ kind: 'asset', key: 'a-1' }, 42)
    expect(message).toContain('42')
    expect(message).toContain('update_note')
    expect(message).toContain('get_note')
  })

  it('分得清资产和文件夹', () => {
    expect(alreadyAttachedError({ kind: 'asset', key: 'a' }, 1)).toContain('资产')
    expect(alreadyAttachedError({ kind: 'folder', key: 'f' }, 1)).toContain('文件夹')
  })
})

describe('targetNotFoundError', () => {
  it('把找不到的那个 key 回显出来，模型才知道是自己传错了', () => {
    expect(targetNotFoundError({ kind: 'asset', key: 'a-404' })).toContain('a-404')
    expect(targetNotFoundError({ kind: 'folder', key: 'f-404' })).toContain('f-404')
  })
})
