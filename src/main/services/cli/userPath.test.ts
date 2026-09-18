/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { containsDir, isSameDir, splitPath, withDir, withoutDir } from './userPath'

/**
 * PATH 是用户环境里最不该被写坏的一个值 —— 写坏之后，坏的不是盒子，
 * 是他终端里的每一条命令，而且他不会想到是盒子干的。
 *
 * 所以这一层的字符串处理必须逐条钉住，尤其是「什么时候**不**改」。
 */
describe('isSameDir', () => {
  it('Windows 不区分大小写', () => {
    expect(isSameDir('C:\\Box', 'c:\\box')).toBe(true)
  })

  it('结尾的斜杠不算区别', () => {
    expect(isSameDir('C:\\Box\\', 'C:\\Box')).toBe(true)
    expect(isSameDir('C:\\Box/', 'C:\\Box')).toBe(true)
  })

  it('引号不算区别 —— PATH 里带引号的条目很常见', () => {
    expect(isSameDir('"C:\\Program Files\\Box"', 'C:\\Program Files\\Box')).toBe(true)
  })

  it('不同目录就是不同', () => {
    expect(isSameDir('C:\\Box', 'C:\\Box2')).toBe(false)
    expect(isSameDir('C:\\Box', 'C:\\Box\\bin')).toBe(false)
  })

  it('空串不和任何东西相等（含它自己）', () => {
    expect(isSameDir('', '')).toBe(false)
    expect(isSameDir('  ', 'C:\\Box')).toBe(false)
  })
})

describe('splitPath', () => {
  it('按分号拆并去掉空段', () => {
    expect(splitPath('C:\\a;;C:\\b;')).toEqual(['C:\\a', 'C:\\b'])
  })

  /** 空段在 Windows 上会被当成「当前目录」，是个实打实的安全问题，不能留 */
  it('全是分号时给空数组', () => {
    expect(splitPath(';;;')).toEqual([])
  })
})

describe('withDir', () => {
  it('加在末尾，不抢在用户自己的条目前面', () => {
    const { value, changed } = withDir('C:\\a;C:\\b', 'C:\\box')
    expect(value).toBe('C:\\a;C:\\b;C:\\box')
    expect(changed).toBe(true)
  })

  /** 点两次「加入」不该多出一条重复项 */
  it('已经在里面就原样返回，changed 为 false', () => {
    const { value, changed } = withDir('C:\\a;C:\\box', 'C:\\BOX\\')
    expect(value).toBe('C:\\a;C:\\box')
    expect(changed).toBe(false)
  })

  it('原来是空的也能加', () => {
    expect(withDir('', 'C:\\box')).toEqual({ value: 'C:\\box', changed: true })
  })

  /**
   * 未展开的 `%VAR%` 必须原样留着。
   *
   * 这是最容易毁掉 PATH 的一步：把展开后的值写回注册表，用户原来写的
   * `%USERPROFILE%\bin` 就被烧死成当时的绝对路径。这一层只做字符串拼接，
   * 保证它不动别的条目；不展开由 readUserPath 的 DoNotExpandEnvironmentNames 保证。
   */
  it('不动别的条目，包括未展开的 %VAR%', () => {
    const before = '%USERPROFILE%\\bin;C:\\a;%JAVA_HOME%\\bin'
    const { value } = withDir(before, 'C:\\box')
    expect(value).toBe(`${before};C:\\box`)
  })
})

describe('withoutDir', () => {
  it('只摘指向同一个目录的那些', () => {
    const { value, changed } = withoutDir('C:\\a;C:\\box;C:\\b', 'C:\\box')
    expect(value).toBe('C:\\a;C:\\b')
    expect(changed).toBe(true)
  })

  it('大小写和结尾斜杠不同也摘得掉', () => {
    expect(withoutDir('C:\\a;C:\\BOX\\', 'C:\\box').value).toBe('C:\\a')
  })

  it('不在里面时原样返回，不写回注册表', () => {
    const { value, changed } = withoutDir('C:\\a;C:\\b', 'C:\\box')
    expect(value).toBe('C:\\a;C:\\b')
    expect(changed).toBe(false)
  })

  /** 万一被加了两遍，一次全摘干净 */
  it('重复条目一次摘干净', () => {
    expect(withoutDir('C:\\box;C:\\a;C:\\box\\', 'C:\\box').value).toBe('C:\\a')
  })

  it('摘完之后别的条目一个不少、顺序不变', () => {
    const { value } = withoutDir('%USERPROFILE%\\bin;C:\\box;C:\\a', 'C:\\box')
    expect(value).toBe('%USERPROFILE%\\bin;C:\\a')
  })
})

describe('containsDir', () => {
  it('认得出在与不在', () => {
    expect(containsDir('C:\\a;C:\\box', 'C:\\BOX')).toBe(true)
    expect(containsDir('C:\\a;C:\\boxes', 'C:\\box')).toBe(false)
  })
})
