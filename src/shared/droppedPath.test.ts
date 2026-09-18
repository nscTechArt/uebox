import { describe, expect, it } from 'vitest'
import { classifyDroppedPath, isAbsoluteNativePath, isExtractorTempPath } from './droppedPath'

const TEMP = 'C:\\Users\\dev\\AppData\\Local\\Temp'

describe('isAbsoluteNativePath', () => {
  it('认盘符、UNC 和 POSIX 根', () => {
    expect(isAbsoluteNativePath('D:\\Assets\\Rocks')).toBe(true)
    expect(isAbsoluteNativePath('D:/Assets/Rocks')).toBe(true)
    expect(isAbsoluteNativePath('\\\\nas\\share\\Rocks')).toBe(true)
    expect(isAbsoluteNativePath('/home/dev/rocks')).toBe(true)
  })

  it('压缩包内的相对名不算 —— 这正是拖 WinRAR 报 ENOENT 的那一条', () => {
    expect(isAbsoluteNativePath('KAWAII ANIMATIONS 100 v5.0+ (Update)\\KawaiiAnimations')).toBe(
      false
    )
    expect(isAbsoluteNativePath('')).toBe(false)
  })

  it('盘符相对路径不算：C:foo 是「C 盘当前目录下的 foo」，不是我们要访问的东西', () => {
    expect(isAbsoluteNativePath('C:foo')).toBe(false)
  })
})

describe('isExtractorTempPath', () => {
  it('认出四家解压软件的临时目录', () => {
    expect(isExtractorTempPath(`${TEMP}\\Rar$DIa1234.5678\\Mesh.fbx`, TEMP)).toBe(true)
    expect(isExtractorTempPath(`${TEMP}\\7zO8C3A1B2F\\Mesh.fbx`, TEMP)).toBe(true)
    expect(isExtractorTempPath(`${TEMP}\\Temp1_素材包.zip\\Mesh.fbx`, TEMP)).toBe(true)
    expect(isExtractorTempPath(`${TEMP}\\BNZ.a1b2c3\\Mesh.fbx`, TEMP)).toBe(true)
  })

  it('临时目录里的普通文件放行 —— 盒子自己也往那儿写东西', () => {
    expect(isExtractorTempPath(`${TEMP}\\unreal-box\\thumb.png`, TEMP)).toBe(false)
  })

  it('临时目录外的同名文件夹不误伤', () => {
    expect(isExtractorTempPath('D:\\7zBackup\\Mesh.fbx', TEMP)).toBe(false)
    expect(isExtractorTempPath('D:\\Temp1_素材包.zip\\Mesh.fbx', TEMP)).toBe(false)
  })

  it('不给临时目录时只看目录名，宁严勿松', () => {
    expect(isExtractorTempPath('D:\\7zBackup\\Mesh.fbx')).toBe(true)
  })
})

describe('classifyDroppedPath', () => {
  it('真路径放行', () => {
    expect(classifyDroppedPath('D:\\Assets\\Rocks\\Mesh.fbx', TEMP)).toBe('ok')
  })

  it('压缩包内的相对名 → not-absolute', () => {
    expect(
      classifyDroppedPath('KAWAII ANIMATIONS 100 v5.0+ (Update)\\KawaiiAnimations', TEMP)
    ).toBe('not-absolute')
  })

  it('解压临时目录 → archive-temp（这条 stat 得到，放过去就是死条目）', () => {
    expect(classifyDroppedPath(`${TEMP}\\7zO8C3A1B2F\\Mesh.fbx`, TEMP)).toBe('archive-temp')
  })
})
