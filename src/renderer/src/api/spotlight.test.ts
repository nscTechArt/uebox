import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spotlightAPI } from './spotlight'

const search = vi.fn()
const execute = vi.fn()
const close = vi.fn()
const onShow = vi.fn()
const onHide = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { api: unknown }).api = {
    spotlight: { search, execute, close, onShow, onHide }
  }
})

describe('spotlightAPI', () => {
  it('按工程名片段返回可直接打开的工程结果', async () => {
    const project = {
      id: 'project-ualink-55',
      type: 'project' as const,
      title: 'UALinkDev55',
      icon: 'project',
      data: { projectKey: 'ualink-55' }
    }
    search.mockResolvedValue({ success: true, data: [project] })

    await expect(spotlightAPI.search('55')).resolves.toEqual([project])
    expect(search).toHaveBeenCalledWith('55')
  })

  it('搜索桥接失败时保留主进程错误', async () => {
    search.mockResolvedValue({ success: false, data: [], error: '工程数据库不可用' })

    await expect(spotlightAPI.search('55')).rejects.toThrow('工程数据库不可用')
  })

  it('通过专用桥接执行工程结果和关闭窗口', () => {
    spotlightAPI.execute('project', { projectKey: 'ualink-55' })
    spotlightAPI.close()

    expect(execute).toHaveBeenCalledWith('project', { projectKey: 'ualink-55' })
    expect(close).toHaveBeenCalledOnce()
  })
})
