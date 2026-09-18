/**
 * 黑名单的成败全押在路径规范化上：比不上就等于「移除 UnrealAgentLink」没生效，
 * 插件下次打开项目又被装回去 —— 那正是这个功能要修的投诉本身。
 */
import * as path from 'path'
import { realpathSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { normalizeProjectPath, projectComparisonKey, toNativeProjectPath } from './projectPath'

describe('projectComparisonKey', () => {
  it('Windows 保留大小写和分隔符兼容', () => {
    expect(projectComparisonKey('D:\\Games\\Demo\\', 'win32')).toBe(
      projectComparisonKey('d:/games/demo', 'win32')
    )
  })

  it('Mac 上不存在或离线的路径也不能折叠大小写', () => {
    expect(projectComparisonKey('/Volumes/OfflineUE/Game', 'darwin')).not.toBe(
      projectComparisonKey('/Volumes/OfflineUE/game', 'darwin')
    )
    expect(projectComparisonKey('/Volumes/OfflineUE/Game/', 'darwin')).toBe(
      projectComparisonKey('/Volumes/OfflineUE/Game', 'darwin')
    )
  })

  it('Mac 路径中的反斜杠是文件名的一部分', () => {
    expect(projectComparisonKey('/Volumes/OfflineUE/Game\\Demo', 'darwin')).not.toBe(
      projectComparisonKey('/Volumes/OfflineUE/Game/Demo', 'darwin')
    )
  })

  it('按文件系统返回的实际路径统一符号链接和大小写别名', () => {
    const realpath = vi.spyOn(realpathSync, 'native').mockReturnValue('/Volumes/UE/Game')
    try {
      expect(projectComparisonKey('/Volumes/UE/Alias', 'darwin')).toBe('/Volumes/UE/Game')
      expect(realpath).toHaveBeenCalledWith('/Volumes/UE/Alias')
      expect(projectComparisonKey('/Volumes/UE/game', 'darwin')).toBe('/Volumes/UE/Game')
      expect(realpath).toHaveBeenCalledWith('/Volumes/UE/game')
    } finally {
      realpath.mockRestore()
    }
  })

  it('空路径不会命中当前目录，根目录仍然有效', () => {
    expect(projectComparisonKey('   ', 'darwin')).toBe('')
    expect(projectComparisonKey('/', 'darwin')).toBe(realpathSync.native('/'))
  })
})

describe('normalizeProjectPath', () => {
  it('大小写不敏感', () => {
    expect(normalizeProjectPath('D:\\Games\\My.uproject')).toBe(
      normalizeProjectPath('d:\\games\\my.uproject')
    )
  })

  it('反斜杠和正斜杠等价', () => {
    expect(normalizeProjectPath('D:\\Games\\My.uproject')).toBe(
      normalizeProjectPath('D:/Games/My.uproject')
    )
  })

  it('忽略首尾空白', () => {
    expect(normalizeProjectPath('  D:/Games/My.uproject  ')).toBe('d:/games/my.uproject')
  })

  it('忽略结尾多余的分隔符', () => {
    expect(normalizeProjectPath('D:/Games/')).toBe('d:/games')
  })

  it('不同项目不会撞车', () => {
    expect(normalizeProjectPath('D:/Games/A.uproject')).not.toBe(
      normalizeProjectPath('D:/Games/B.uproject')
    )
  })
})

describe('toNativeProjectPath', () => {
  it('两种分隔符写法归到同一个字符串 —— 这正是首页出现两张同名卡片的成因', () => {
    expect(toNativeProjectPath(path.join('D:', 'Games', 'My'))).toBe(
      toNativeProjectPath('D:/Games/My')
    )
  })

  it('多余的分隔符会被收掉', () => {
    expect(toNativeProjectPath('D:/Games//My')).toBe(toNativeProjectPath('D:/Games/My'))
  })

  it('忽略首尾空白', () => {
    expect(toNativeProjectPath('  D:/Games/My  ')).toBe(toNativeProjectPath('D:/Games/My'))
  })

  it('保留原始大小写 —— 存库要的是人打得开的路径，不是压扁了给机器比的', () => {
    expect(toNativeProjectPath('D:/UE Project/MyGame')).toContain('MyGame')
    expect(toNativeProjectPath('D:/UE Project/MyGame')).toContain('UE Project')
  })

  it('空值不会变成当前工作目录', () => {
    expect(toNativeProjectPath('')).toBe('')
    expect(toNativeProjectPath('   ')).toBe('')
  })
})
