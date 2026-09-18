import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import type { CommunityTemplate } from '@core/shared/projectTemplate'
import { projectTemplateAPI } from './projectTemplate'

const TEMPLATE: CommunityTemplate = {
  id: 'tpl-fps',
  name: '第一人称',
  description: '官方第一人称模板',
  category: 'game',
  engineVersion: '5.3',
  packageUrl: 'packages/fps.zip',
  size: 1024,
  sha256: 'a'.repeat(64),
  version: '1.0.0',
  author: 'community',
  license: 'MIT'
}

function installDownload(): ReturnType<typeof vi.fn> {
  const downloadCommunity = vi.fn(async () => ({
    success: true,
    templatePath: 'C:/userData/templates/fps.zip'
  }))
  window.api = { projectTemplate: { downloadCommunity } } as unknown as typeof window.api
  return downloadCommunity
}

describe('projectTemplateAPI.downloadCommunity', () => {
  beforeEach(() => {
    window.api = undefined as unknown as typeof window.api
  })

  /**
   * 列表行的 `template` 是从 ref 里取出来的深响应式代理。代理过不了
   * Electron IPC 的结构化克隆，`ipcRenderer.invoke` 直接 reject ——
   * 用户点「下载模板」弹的就是 `An object could not be cloned`。
   * 这里用 `structuredClone` 模拟 IPC 边界：原始代理必须抛错（证明模拟
   * 忠实），而 API 层真正发出去的对象必须过得去。
   */
  it('响应式代理拍成纯对象后再过 IPC', async () => {
    const downloadCommunity = installDownload()
    const proxied = reactive(TEMPLATE)

    // 忠实性检查：不拍平就直接 structuredClone，和 Electron 一样会炸
    expect(() => structuredClone(proxied)).toThrow()

    await projectTemplateAPI.downloadCommunity('github', proxied)

    expect(downloadCommunity).toHaveBeenCalledTimes(1)
    const arg = downloadCommunity.mock.calls[0][0]
    expect(() => structuredClone(arg.template)).not.toThrow()
    expect(arg.sourceId).toBe('github')
    expect(arg.template).toEqual(TEMPLATE)
  })

  it('普通对象入参保持原样，内容不丢', async () => {
    const downloadCommunity = installDownload()

    await projectTemplateAPI.downloadCommunity('github', { ...TEMPLATE })

    const arg = downloadCommunity.mock.calls[0][0]
    expect(arg.template).toEqual(TEMPLATE)
  })

  it('主进程报错时转成异常抛出', async () => {
    window.api = {
      projectTemplate: {
        downloadCommunity: vi.fn(async () => ({ success: false, error: '模板源不存在' }))
      }
    } as unknown as typeof window.api

    await expect(projectTemplateAPI.downloadCommunity('github', TEMPLATE)).rejects.toThrow(
      '模板源不存在'
    )
  })
})
