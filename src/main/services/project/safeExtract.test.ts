import path from 'path'
import { describe, expect, it } from 'vitest'
import { resolveSafeEntryPath } from './safeExtract'

/**
 * zip 条目名是**压缩包作者写的字符串**。模板包从本地文件变成"可以从社区源下载"之后，
 * 这个字符串就是一条别人可控的写文件路径 —— 这里守的是「越界条目一律解析失败」。
 */
describe('zip 条目路径解析', () => {
  const dest = path.resolve('/tmp/extract')

  it('普通条目解析到目标目录里面', () => {
    const resolved = resolveSafeEntryPath(dest, 'MyProject/MyProject.uproject')
    expect(resolved).not.toBeNull()
    expect(resolved?.startsWith(dest)).toBe(true)
  })

  it('拒绝 ../ 越界', () => {
    expect(resolveSafeEntryPath(dest, '../evil.txt')).toBeNull()
    expect(resolveSafeEntryPath(dest, 'a/b/../../../evil.txt')).toBeNull()
  })

  /**
   * 反斜杠单独测：只按 posix 分隔符解析的话，`..\..\evil` 会被当成一整个**文件名**
   * 而不是三段路径，于是越界检查直接被绕过去。
   */
  it('拒绝反斜杠形式的越界', () => {
    expect(resolveSafeEntryPath(dest, '..\\evil.txt')).toBeNull()
    expect(resolveSafeEntryPath(dest, 'a\\..\\..\\evil.txt')).toBeNull()
  })

  it('拒绝绝对路径和盘符', () => {
    expect(resolveSafeEntryPath(dest, '/etc/passwd')).toBeNull()
    expect(resolveSafeEntryPath(dest, 'C:/Windows/System32/evil.dll')).toBeNull()
    expect(resolveSafeEntryPath(dest, 'C:\\Windows\\evil.dll')).toBeNull()
  })

  /**
   * 前缀相同但不是子目录：`/tmp/extract-evil` 以 `/tmp/extract` 开头，
   * 只比较字符串前缀会把它放进来。
   */
  it('拒绝只是前缀相同的兄弟目录', () => {
    expect(resolveSafeEntryPath(dest, '../extract-evil/x.txt')).toBeNull()
  })

  it('允许目标目录本身（zip 里的根条目）', () => {
    expect(resolveSafeEntryPath(dest, '')).toBe(dest)
  })
})
