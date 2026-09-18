/**
 * 忽略规则的写入是「安装成功之后的锦上添花」，所以这里重点验两件事：
 * 幂等（重复导入项目不该把同一行加八遍），以及保守（不是 git 仓库就别
 * 凭空造 .gitignore，.p4ignore 更是只在已存在时才碰）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  PLUGIN_IGNORE_ENTRY,
  alreadyIgnoresPlugin,
  appendIgnoreEntry,
  ensurePluginIgnored
} from './pluginVcsIgnore'

const tempDirs: string[] = []

function makeProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ualink-ignore-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('alreadyIgnoresPlugin', () => {
  it.each([
    'Plugins/UnrealAgentLink/',
    'Plugins/UnrealAgentLink',
    '/Plugins/UnrealAgentLink/',
    'Plugins\\UnrealAgentLink\\',
    '  Plugins/UnrealAgentLink/  '
  ])('认得已有的写法 %j', (line) => {
    expect(alreadyIgnoresPlugin(`Saved/\n${line}\nBinaries/\n`)).toBe(true)
  })

  it('整个 Plugins/ 都被忽略时不必再加', () => {
    expect(alreadyIgnoresPlugin('Binaries/\nPlugins/\n')).toBe(true)
  })

  it('注释掉的规则不算数', () => {
    expect(alreadyIgnoresPlugin('# Plugins/UnrealAgentLink/\n')).toBe(false)
  })

  it('否定规则是把它重新纳入版本库，不算覆盖', () => {
    expect(alreadyIgnoresPlugin('Plugins/*\n!Plugins/UnrealAgentLink/\n')).toBe(false)
  })

  it('别的插件目录不算', () => {
    expect(alreadyIgnoresPlugin('Plugins/SomeOtherPlugin/\n')).toBe(false)
  })
})

describe('appendIgnoreEntry', () => {
  it('原内容不以换行结尾时先补一个，避免和最后一行粘住', () => {
    const result = appendIgnoreEntry('Saved/')
    expect(result).toContain(`\n${PLUGIN_IGNORE_ENTRY}\n`)
    expect(result.startsWith('Saved/\n')).toBe(true)
    expect(result).not.toContain('Saved/#')
  })

  it('空文件不留多余空行', () => {
    expect(appendIgnoreEntry('')).not.toMatch(/^\n/)
  })
})

describe('ensurePluginIgnored', () => {
  it('已有 .gitignore 时追加', async () => {
    const dir = makeProjectDir()
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Binaries/\nSaved/\n', 'utf-8')

    const result = await ensurePluginIgnored(dir)

    expect(result.gitignore).toBe('updated')
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')
    expect(content).toContain(PLUGIN_IGNORE_ENTRY)
    expect(content).toContain('Binaries/')
  })

  it('重复调用不会重复写入', async () => {
    const dir = makeProjectDir()
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Saved/\n', 'utf-8')

    await ensurePluginIgnored(dir)
    const second = await ensurePluginIgnored(dir)

    expect(second.gitignore).toBe('already-ignored')
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')
    expect(content.split(PLUGIN_IGNORE_ENTRY).length - 1).toBe(1)
  })

  it('是 git 仓库但没有 .gitignore 时新建', async () => {
    const dir = makeProjectDir()
    fs.mkdirSync(path.join(dir, '.git'))

    const result = await ensurePluginIgnored(dir)

    expect(result.gitignore).toBe('created')
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toContain(PLUGIN_IGNORE_ENTRY)
  })

  it('不是 git 仓库就别凭空造 .gitignore', async () => {
    const dir = makeProjectDir()

    const result = await ensurePluginIgnored(dir)

    expect(result.gitignore).toBe('skipped')
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false)
  })

  it('.p4ignore 只在已存在时追加', async () => {
    const dir = makeProjectDir()

    const withoutFile = await ensurePluginIgnored(dir)
    expect(withoutFile.p4ignore).toBe('skipped')
    expect(fs.existsSync(path.join(dir, '.p4ignore'))).toBe(false)

    fs.writeFileSync(path.join(dir, '.p4ignore'), 'Intermediate/\n', 'utf-8')
    const withFile = await ensurePluginIgnored(dir)
    expect(withFile.p4ignore).toBe('updated')
    expect(fs.readFileSync(path.join(dir, '.p4ignore'), 'utf-8')).toContain(PLUGIN_IGNORE_ENTRY)
  })
})
