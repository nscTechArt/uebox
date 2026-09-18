/**
 * 扫描器怎么给一个目录归类，决定了包会被当成「一条内容」还是「一层结构」。
 * 判错了就是把一个蓝图拆成 cover.png + blueprint.json + 一堆贴图，
 * 在资产库里散成一片碎片。
 */
import { describe, expect, it } from 'vitest'
import { classifyScanEntry } from './fsHandlers'

describe('classifyScanEntry', () => {
  it('普通文件就是文件', () => {
    expect(classifyScanEntry('rock_basecolor.png', false)).toEqual({ type: 'file' })
  })

  it('普通目录就是目录 —— 它是结构，扫描器要往里走', () => {
    expect(classifyScanEntry('Textures', true)).toEqual({ type: 'folder' })
  })

  it('包目录是内容，不是结构，并带上它属于哪个库', () => {
    expect(classifyScanEntry('跳跃逻辑.ueblueprint', true)).toEqual({
      type: 'package',
      library: 'blueprint'
    })
    expect(classifyScanEntry('苔藓石头.uematerial', true)).toEqual({
      type: 'package',
      library: 'material'
    })
  })

  it('名字像包但其实是文件的，仍然是文件 —— 别被压缩包之类的骗了', () => {
    expect(classifyScanEntry('跳跃逻辑.ueblueprint', false)).toEqual({ type: 'file' })
  })

  it('扩展名大小写不敏感', () => {
    expect(classifyScanEntry('跳跃逻辑.UEBlueprint', true)).toEqual({
      type: 'package',
      library: 'blueprint'
    })
  })

  it('只是名字里带扩展名、后面还有东西的不算包', () => {
    expect(classifyScanEntry('跳跃逻辑.ueblueprint.bak', true)).toEqual({ type: 'folder' })
  })
})
