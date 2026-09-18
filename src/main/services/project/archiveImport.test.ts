import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractArchiveToProjectContent, pickExtractDirName } from './archiveImport'

describe('pickExtractDirName', () => {
  it('素材包只有一个顶层目录时不多包一层 —— 多一层就是满屏丢失引用', () => {
    expect(
      pickExtractDirName('KAWAII ANIMATIONS 100 v5.0+ (Update).zip', [
        'KawaiiAnimations/',
        'KawaiiAnimations/Meshes/SK_Girl.uasset',
        'KawaiiAnimations/Anims/A_Idle.uasset'
      ])
    ).toBeNull()
  })

  it('多个顶层目录时用压缩包名兜住', () => {
    expect(pickExtractDirName('Pack.zip', ['A/one.uasset', 'B/two.uasset'])).toBe('Pack')
  })

  it('顶层躺着散文件时也要兜住，别糊在 Content 根目录上', () => {
    expect(pickExtractDirName('Pack.zip', ['readme.txt', 'Mesh/one.uasset'])).toBe('Pack')
  })

  it('包名里的空格、加号和括号都洗掉', () => {
    expect(pickExtractDirName('KAWAII ANIMATIONS 100 v5.0+ (Update).zip', ['a.txt', 'b.txt'])).toBe(
      'KAWAII_ANIMATIONS_100_v5_0_Update'
    )
  })

  it('包名洗完什么都不剩时有兜底名', () => {
    expect(pickExtractDirName('+++.zip', ['a.txt', 'b.txt'])).toBe('ImportedArchive')
  })
})

describe('extractArchiveToProjectContent', () => {
  let workDir = ''
  let projectDir = ''

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'archive-import-'))
    projectDir = join(workDir, 'MyProject')
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  const writeZip = (name: string, files: Record<string, string>): string => {
    const zip = new AdmZip()
    for (const [entry, content] of Object.entries(files)) {
      zip.addFile(entry, Buffer.from(content, 'utf-8'))
    }
    const zipPath = join(workDir, name)
    zip.writeZip(zipPath)
    return zipPath
  }

  it('单顶层目录的包直接解进 Content', async () => {
    const zipPath = writeZip('Pack.zip', {
      'KawaiiAnimations/Anims/A_Idle.uasset': 'idle',
      'KawaiiAnimations/Meshes/SK_Girl.uasset': 'girl'
    })

    const result = await extractArchiveToProjectContent({ zipPath, projectPath: projectDir })

    expect(result.success).toBe(true)
    expect(result.destDir).toBe(join(projectDir, 'Content'))
    expect(result.fileCount).toBe(2)
    expect(
      readFileSync(
        join(projectDir, 'Content', 'KawaiiAnimations', 'Anims', 'A_Idle.uasset'),
        'utf-8'
      )
    ).toBe('idle')
  })

  it('散装包解进以包名命名的子目录', async () => {
    const zipPath = writeZip('Loose Pack.zip', { 'a.uasset': 'a', 'b.uasset': 'b' })

    const result = await extractArchiveToProjectContent({ zipPath, projectPath: projectDir })

    expect(result.success).toBe(true)
    expect(result.destDir).toBe(join(projectDir, 'Content', 'Loose_Pack'))
    expect(existsSync(join(projectDir, 'Content', 'Loose_Pack', 'a.uasset'))).toBe(true)
  })

  it('越界条目整包拒收，一个字节都不落盘', async () => {
    // adm-zip 的 addFile 会把 `../` 洗掉，正常调用造不出恶意包 —— 所以先写一个
    // 等长的合法名字，再在字节层面把它改成越界名。长度一致，中央目录的偏移不用重算。
    const zipPath = writeZip('Evil.zip', { 'aa/evil.txt': 'pwned', 'ok/one.txt': 'ok' })
    const raw = readFileSync(zipPath)
    let cursor = raw.indexOf('aa/evil.txt')
    while (cursor !== -1) {
      raw.write('../evil.txt', cursor, 'utf-8')
      cursor = raw.indexOf('aa/evil.txt', cursor + 1)
    }
    writeFileSync(zipPath, raw)

    const result = await extractArchiveToProjectContent({ zipPath, projectPath: projectDir })

    expect(result.success).toBe(false)
    expect(result.error).toContain('不安全')
    expect(existsSync(join(projectDir, 'evil.txt'))).toBe(false)
    expect(existsSync(join(projectDir, 'Content', 'ok'))).toBe(false)
  })

  it('rar/7z 直接拒绝，不假装能解', async () => {
    const result = await extractArchiveToProjectContent({
      zipPath: join(workDir, 'Pack.rar'),
      projectPath: projectDir
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('只能解 zip')
  })

  it('压缩包不存在时说清楚是哪一条路径', async () => {
    const result = await extractArchiveToProjectContent({
      zipPath: join(workDir, 'missing.zip'),
      projectPath: projectDir
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('不存在')
  })
})
