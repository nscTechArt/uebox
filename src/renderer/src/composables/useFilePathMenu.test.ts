import { describe, expect, it } from 'vitest'

import { basenameOf, dirnameOf, shortDirOf } from './useFilePathMenu'

describe('basenameOf', () => {
  it('取最后一段，两种分隔符都认', () => {
    expect(basenameOf('I:/UE Project/a/说明.html')).toBe('说明.html')
    expect(basenameOf('C:\\Users\\me\\a.cpp')).toBe('a.cpp')
    expect(basenameOf('C:/a/b/')).toBe('b')
  })
})

describe('dirnameOf', () => {
  it('返回目录部分，末尾带分隔符', () => {
    expect(dirnameOf('I:/UE Project/a/说明.html')).toBe('I:/UE Project/a/')
    expect(dirnameOf('C:\\Users\\me\\a.cpp')).toBe('C:/Users/me/')
  })

  it('没有目录时返回空串', () => {
    expect(dirnameOf('a.txt')).toBe('')
  })
})

describe('shortDirOf', () => {
  it('层数超了就从前面砍，留最后两层', () => {
    expect(shortDirOf('I:/UE Project/SampleProject/prototype/a.html')).toBe(
      '…/SampleProject/prototype/'
    )
  })

  it('层数不超就原样给出', () => {
    expect(shortDirOf('C:/a/b.txt')).toBe('C:/a/')
    expect(shortDirOf('C:/a/b/c.txt')).toBe('…/a/b/')
  })

  it('没有目录时返回空串', () => {
    expect(shortDirOf('a.txt')).toBe('')
  })
})
