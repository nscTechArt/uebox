/**
 * 「这个路径在不在那个目录里」。
 *
 * 红灯用例是同前缀兄弟目录那条：仓库里原本到处是裸 `target.startsWith(root)`，
 * 少了分隔符这一步，`assetData` 与同级的 `assetDataXXX` 前缀相同，
 * 于是兄弟目录里的文件也会被当成「库内文件」删掉。
 */
import { resolve } from 'path'

import { describe, expect, it } from 'vitest'

import { isInsideAnyDirectory, isInsideDirectory } from './pathContainment'

const ROOT = resolve('/vault/assetData')

describe('isInsideDirectory', () => {
  it('目录下的文件算在里面', () => {
    expect(isInsideDirectory(resolve('/vault/assetData/Mesh/a.uasset'), ROOT)).toBe(true)
  })

  it('目录自身算在里面', () => {
    expect(isInsideDirectory(ROOT, ROOT)).toBe(true)
  })

  it('同前缀的兄弟目录不算 —— 这是裸 startsWith 的坑', () => {
    expect(isInsideDirectory(resolve('/vault/assetDataXXX/a.uasset'), ROOT)).toBe(false)
    expect(isInsideDirectory(resolve('/vault/assetData_backup/a.uasset'), ROOT)).toBe(false)
  })

  it('用 .. 爬出去的路径不算', () => {
    expect(isInsideDirectory(resolve('/vault/assetData/../../etc/passwd'), ROOT)).toBe(false)
    expect(isInsideDirectory('/vault/assetData/../vault-data.db', ROOT)).toBe(false)
  })

  it('上级目录不算', () => {
    expect(isInsideDirectory(resolve('/vault'), ROOT)).toBe(false)
  })

  it('空值一律判否，不误放行', () => {
    expect(isInsideDirectory('', ROOT)).toBe(false)
    expect(isInsideDirectory(ROOT, '')).toBe(false)
  })
})

describe('isInsideAnyDirectory', () => {
  it('命中任意一个根即可', () => {
    expect(
      isInsideAnyDirectory(resolve('/vault/thumbnails/a.jpg'), [
        resolve('/other'),
        resolve('/vault/thumbnails')
      ])
    ).toBe(true)
  })

  it('undefined 的根被跳过，不会当成「匹配一切」', () => {
    expect(isInsideAnyDirectory(resolve('/anywhere/a.jpg'), [undefined, undefined])).toBe(false)
  })
})
