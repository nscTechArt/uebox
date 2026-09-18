// @vitest-environment node
/**
 * 社区模板全链路测试：起一个本地源 → 抓清单 → 下包 → 校验 → 落地 → 解压。
 *
 * 单元测试各管一段（清单解析、文件名净化、路径越界），但「这条链真的能跑通」
 * 只有把它们串起来才测得到 —— 相对 packageUrl 有没有正确解析、边车 json 写没写对、
 * sha256 对不上时临时文件有没有清干净，任何一处断了用户看到的都是"下载失败"。
 *
 * 环境必须是 node：默认的浏览器环境会对 fetch 做 CORS 检查，而主进程没有这回事。
 */
import { createServer, type Server } from 'http'
import { promises as fs } from 'fs'
import { createHash } from 'crypto'
import path from 'path'
import os from 'os'
import AdmZip from 'adm-zip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { downloadTemplate, fetchSource } from './templateDownload'
import { extractZipSafely } from './safeExtract'
import type { TemplateSource } from '../../../shared/projectTemplate'

/** 造一个最小但完整的模板包：任意层级下有一个 .uproject 就算数 */
function buildTemplateZip(): Buffer {
  const zip = new AdmZip()
  zip.addFile('Demo/Demo.uproject', Buffer.from('{"FileVersion":3}'))
  zip.addFile('Demo/Config/DefaultEngine.ini', Buffer.from('[/Script/Engine]\n'))
  return zip.toBuffer()
}

let server: Server
let port = 0
let packageBytes: Buffer
let packageSha = ''
let workDir = ''

beforeAll(async () => {
  packageBytes = buildTemplateZip()
  packageSha = createHash('sha256').update(packageBytes).digest('hex')

  const manifest = {
    formatVersion: 1,
    templates: [
      {
        id: 'demo',
        name: 'Demo 模板',
        description: '测试用',
        category: 'game',
        engineVersion: '5.4',
        // 相对路径：真实清单基本都这么写，解析错了整条链就断在这里
        packageUrl: 'packages/demo.zip',
        size: packageBytes.length,
        sha256: packageSha,
        version: '1.0.0',
        author: '测试',
        license: 'Apache-2.0'
      }
    ]
  }

  server = createServer((req, res) => {
    const url = (req.url || '').split('?')[0]
    if (url === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(manifest))
      return
    }
    if (url === '/packages/demo.zip') {
      res.writeHead(200, { 'content-type': 'application/zip' }).end(packageBytes)
      return
    }
    res.writeHead(404).end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uebox-template-'))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(workDir, { recursive: true, force: true })
})

function localSource(): TemplateSource {
  return {
    id: 'local',
    name: '本地测试源',
    url: `http://127.0.0.1:${port}/manifest.json`,
    enabled: true,
    builtin: false
  }
}

describe('社区模板全链路', () => {
  it('抓清单时把相对 packageUrl 解析成绝对地址', async () => {
    const result = await fetchSource(localSource())
    expect(result.error).toBeUndefined()
    expect(result.skipped).toBe(0)
    expect(result.templates).toHaveLength(1)
    expect(result.templates[0].packageUrl).toBe(`http://127.0.0.1:${port}/packages/demo.zip`)
  })

  it('下载 → 校验 → 落地 zip 与边车，解压后能找到 .uproject', async () => {
    const source = localSource()
    const { templates } = await fetchSource(source)
    const targetDir = path.join(workDir, 'ok')
    await fs.mkdir(targetDir, { recursive: true })

    const progress: number[] = []
    const result = await downloadTemplate({
      source,
      template: templates[0],
      targetDir,
      onProgress: (p) => progress.push(p.percent)
    })

    expect(progress.length).toBeGreaterThan(0)
    expect(progress.at(-1)).toBe(100)

    // 边车带着 origin 和来源标识，list 靠它把社区模板与自制模板分开
    const meta = JSON.parse(await fs.readFile(result.metaPath, 'utf-8'))
    expect(meta.origin).toBe('community')
    expect(meta.sourceId).toBe('local')
    expect(meta.templateId).toBe('demo')
    // 文件名被净化过，显示名要从边车里取回原名
    expect(meta.name).toBe('Demo 模板')

    const extractDir = path.join(targetDir, 'extracted')
    await extractZipSafely(new AdmZip(result.templatePath), extractDir)
    const uproject = await fs.stat(path.join(extractDir, 'Demo', 'Demo.uproject'))
    expect(uproject.isFile()).toBe(true)
  })

  /**
   * 校验失败必须**不留残骸**：留下半截 .part，下次进来的人会以为是个坏包，
   * 而真正的问题（清单里的 sha256 写错了）反而看不出来。
   */
  it('sha256 对不上时报错并清掉临时文件', async () => {
    const source = localSource()
    const { templates } = await fetchSource(source)
    const targetDir = path.join(workDir, 'bad')
    await fs.mkdir(targetDir, { recursive: true })

    await expect(
      downloadTemplate({
        source,
        template: { ...templates[0], sha256: 'f'.repeat(64) },
        targetDir
      })
    ).rejects.toThrow(/校验失败/)

    expect(await fs.readdir(path.join(targetDir, '.download'))).toEqual([])
    // 坏包不该落进模板目录
    expect(await fs.readdir(targetDir)).toEqual(['.download'])
  })

  it('源地址不通时把原因带回来，而不是抛异常', async () => {
    const result = await fetchSource({
      ...localSource(),
      url: `http://127.0.0.1:${port}/not-there.json`
    })
    expect(result.error).toBe('HTTP 404')
    expect(result.templates).toEqual([])
  })
})
