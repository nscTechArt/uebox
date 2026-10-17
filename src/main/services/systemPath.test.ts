import { describe, expect, it } from 'vitest'

import { mergeFreshPath } from './systemPath'

describe('mergeFreshPath', () => {
  it('系统级在前、用户级在后，和新开的进程一样', () => {
    expect(mergeFreshPath('', 'C:\\Windows', 'C:\\Users\\a\\bin')).toBe(
      'C:\\Windows;C:\\Users\\a\\bin'
    )
  })

  it('刚装的程序进来了，本进程独有的段补在后面不丢', () => {
    const merged = mergeFreshPath(
      'C:\\Windows;C:\\Box\\resources\\bin',
      'C:\\Windows;C:\\Program Files\\Git\\cmd',
      ''
    )
    expect(merged).toBe('C:\\Windows;C:\\Program Files\\Git\\cmd;C:\\Box\\resources\\bin')
  })

  it('大小写、结尾斜杠不同的同一个目录只留一份', () => {
    expect(mergeFreshPath('c:\\windows\\', 'C:\\Windows', 'C:\\WINDOWS')).toBe('C:\\Windows')
  })
})
