/** @vitest-environment node */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: () => userData }
}))

import {
  MIRROR_CN_SOURCE_ID,
  OFFICIAL_SOURCE_ID,
  addSource,
  isValidSourceUrl,
  listSources,
  removeSource,
  setSourceEnabled
} from './templateSource'

/** 内置源，按代码里声明的顺序 */
const BUILTIN_IDS = [OFFICIAL_SOURCE_ID, MIRROR_CN_SOURCE_ID]

const configFile = (): string => join(userData, 'template-sources.json')

function writeConfig(value: unknown): void {
  writeFileSync(configFile(), JSON.stringify(value), 'utf-8')
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'uebox-sources-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('模板源配置', () => {
  /**
   * 这一条是整个功能对用户的承诺：装好之后不点「启用」就一个请求都不发。
   * 谁要是哪天把内置源改成默认开启，这里会红。
   */
  it('没有配置文件时，内置源都在，且**全部**默认关闭', async () => {
    const sources = await listSources()
    expect(sources.map((s) => s.id)).toEqual(BUILTIN_IDS)
    expect(sources.every((s) => s.builtin)).toBe(true)
    expect(sources.every((s) => !s.enabled)).toBe(true)
  })

  /**
   * GitHub 在国内经常连不上，只给一个源等于让一半用户点了没反应。
   * 两个源装的是同一份内容，Gitee 那个是镜像。
   */
  it('内置了 GitHub 和国内镜像两个官方源', async () => {
    const sources = await listSources()
    expect(sources.find((s) => s.id === OFFICIAL_SOURCE_ID)?.url).toContain(
      'raw.githubusercontent.com'
    )
    expect(sources.find((s) => s.id === MIRROR_CN_SOURCE_ID)?.url).toContain('gitee.com')
  })

  /** 老用户的配置里只有 official，升级后镜像源要自动补上（同样默认关闭） */
  it('旧配置里缺的内置源会补进来，且不会被自动打开', async () => {
    writeConfig([
      {
        id: OFFICIAL_SOURCE_ID,
        name: '官方社区库',
        url: 'https://raw.githubusercontent.com/ueboxai/community-templates/main/manifest.json',
        enabled: true,
        builtin: true
      }
    ])

    const sources = await listSources()
    expect(sources.map((s) => s.id)).toEqual(BUILTIN_IDS)
    expect(sources.find((s) => s.id === OFFICIAL_SOURCE_ID)?.enabled).toBe(true)
    expect(sources.find((s) => s.id === MIRROR_CN_SOURCE_ID)?.enabled).toBe(false)
  })

  /**
   * 真实踩过：占位地址被写进用户的 template-sources.json，之后代码里换了正式地址，
   * 用户那边还在打旧地址、报 404。内置源的地址必须以代码为准，不能被一份旧存档钉死。
   */
  it('内置源的地址以代码为准，覆盖存档里的旧地址', async () => {
    writeConfig([
      {
        id: OFFICIAL_SOURCE_ID,
        name: '旧名字',
        url: 'https://raw.githubusercontent.com/old-owner/community-templates/main/manifest.json',
        enabled: true,
        builtin: true
      }
    ])

    const sources = await listSources()
    const official = sources.find((s) => s.id === OFFICIAL_SOURCE_ID)
    expect(official?.url).toContain('/ueboxai/community-templates/')
    expect(official?.name).not.toBe('旧名字')
    // 但用户自己开过的开关要保留下来
    expect(official?.enabled).toBe(true)
  })

  it('自定义源原样保留，内置源排在最前', async () => {
    writeConfig([
      {
        id: 'custom-1',
        name: '内网源',
        url: 'http://nas.local/manifest.json',
        enabled: true,
        builtin: false
      }
    ])

    const sources = await listSources()
    expect(sources.map((s) => s.id)).toEqual([...BUILTIN_IDS, 'custom-1'])
    expect(sources[BUILTIN_IDS.length].url).toBe('http://nas.local/manifest.json')
  })

  it('丢掉配置文件里的非法条目，不让一条脏数据废掉整份配置', async () => {
    writeConfig([
      { id: '', url: 'https://a.example/m.json' },
      { id: 'no-url' },
      { id: 'bad-protocol', url: 'file:///C:/m.json' },
      { id: 'good', name: '好的', url: 'https://good.example/m.json', enabled: true },
      'not-an-object'
    ])

    const sources = await listSources()
    expect(sources.map((s) => s.id)).toEqual([...BUILTIN_IDS, 'good'])
  })

  it('切换启用状态会落盘', async () => {
    await setSourceEnabled(OFFICIAL_SOURCE_ID, true)
    const saved = JSON.parse(readFileSync(configFile(), 'utf-8'))
    expect(saved.find((s: { id: string }) => s.id === OFFICIAL_SOURCE_ID).enabled).toBe(true)
    expect((await listSources())[0].enabled).toBe(true)
  })

  it('添加自定义源后直接是启用状态', async () => {
    const sources = await addSource('我的源', 'https://mine.example/manifest.json')
    const added = sources.find((s) => s.url === 'https://mine.example/manifest.json')
    expect(added?.enabled).toBe(true)
    expect(added?.builtin).toBe(false)
  })

  it('拒绝非法地址和重复地址', async () => {
    await expect(addSource('坏的', 'file:///C:/m.json')).rejects.toThrow()
    await expect(addSource('坏的', '随便写的')).rejects.toThrow()
    await addSource('第一次', 'https://dup.example/manifest.json')
    await expect(addSource('第二次', 'https://dup.example/manifest.json')).rejects.toThrow()
  })

  /** 内置源只能禁用，不能删 —— 删掉之后用户就再也找不回官方源了 */
  it('内置源不能删除，自定义源可以', async () => {
    await expect(removeSource(OFFICIAL_SOURCE_ID)).rejects.toThrow()
    await expect(removeSource(MIRROR_CN_SOURCE_ID)).rejects.toThrow()

    const added = await addSource('临时', 'https://tmp.example/manifest.json')
    const id = added.find((s) => s.url === 'https://tmp.example/manifest.json')!.id
    const after = await removeSource(id)
    expect(after.map((s) => s.id)).not.toContain(id)
  })

  it('只认 http/https 的源地址', () => {
    expect(isValidSourceUrl('https://a.example/m.json')).toBe(true)
    expect(isValidSourceUrl('http://a.example/m.json')).toBe(true)
    expect(isValidSourceUrl('file:///C:/m.json')).toBe(false)
    expect(isValidSourceUrl('ftp://a.example/m.json')).toBe(false)
    expect(isValidSourceUrl('随便写的')).toBe(false)
  })
})
