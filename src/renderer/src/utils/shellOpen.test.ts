import { describe, expect, it } from 'vitest'
import { describeShellOpenFailure } from './shellOpen'

/**
 * 用户报的是「点了没反应」。根因是 `shell:*` 失败时 return `{success:false}` 而不抛，
 * 渲染层却只写了 catch —— 这几条守住「失败一定判得出来，而且带着目标」。
 */
describe('describeShellOpenFailure', () => {
  const target = 'D:\\projects\\Foo.uproject'

  it('成功就没有要说的', () => {
    expect(describeShellOpenFailure({ success: true }, target)).toBeNull()
  })

  it('路径不存在算 warning —— 用户自己能修', () => {
    expect(
      describeShellOpenFailure({ success: false, error: '路径不存在', pathNotFound: true }, target)
    ).toEqual({ level: 'warning', target, error: '路径不存在', pathNotFound: true })
  })

  it('其他失败算 error，并带上系统给的原因', () => {
    expect(describeShellOpenFailure({ success: false, error: 'Access is denied' }, target)).toEqual(
      {
        level: 'error',
        target,
        error: 'Access is denied',
        pathNotFound: false
      }
    )
  })

  it('主进程回了个空也算失败 —— 绝不能当成功放过去', () => {
    expect(describeShellOpenFailure(undefined, target)).toEqual({
      level: 'error',
      target,
      error: '',
      pathNotFound: false
    })
    expect(describeShellOpenFailure(null, target)).not.toBeNull()
  })

  it('success 缺字段时按失败处理', () => {
    expect(describeShellOpenFailure({} as { success: boolean }, target)).not.toBeNull()
  })
})
