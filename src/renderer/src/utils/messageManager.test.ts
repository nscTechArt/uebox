/**
 * 全局提示的封装。
 *
 * 两个历史坑：
 * - 带 key 的消息 key 被丢掉 —— 「先 loading 再用同一个 key 改状态」全部变成新开一条，
 *   网络库同步的进度提示堆成三条永不消失。
 * - 交给 antd 的 maxCount 管同屏条数：满了之后 antd 会借用最早那条的 key，带 key 的更新
 *   就找不到自己那条，照样一条条往上堆。所以上限改成封装自己管，只管不带 key 的。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const antd = vi.hoisted(() => {
  const destroyFns: Array<ReturnType<typeof vi.fn>> = []
  const make = (): ReturnType<typeof vi.fn> =>
    vi.fn(() => {
      const destroy = vi.fn()
      destroyFns.push(destroy)
      return destroy
    })
  return {
    destroyFns,
    message: {
      success: make(),
      error: make(),
      warning: make(),
      info: make(),
      loading: make(),
      destroy: vi.fn(),
      config: vi.fn()
    }
  }
})

vi.mock('ant-design-vue', () => ({ message: antd.message }))

import { message } from './messageManager'

beforeEach(() => {
  message.destroyAll()
  vi.clearAllMocks()
  antd.destroyFns.length = 0
})

describe('messageManager', () => {
  it('带 key 的消息把 key 原样交给 antd（同一条原地更新）', () => {
    message.loading({ content: '正在同步 10%', key: 'sync', duration: 0 })
    message.loading({ content: '正在同步 20%', key: 'sync', duration: 0 })
    expect(antd.message.loading).toHaveBeenNthCalledWith(1, {
      content: '正在同步 10%',
      key: 'sync',
      duration: 0,
      onClose: undefined
    })
    expect(antd.message.loading).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ key: 'sync', content: '正在同步 20%' })
    )
    message.success({ content: '完成', key: 'sync' })
    expect(antd.message.success).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'sync', content: '完成', duration: 3 })
    )
  })

  it('不交给 antd 的 maxCount 管（那样带 key 的更新会找不到自己那条）', async () => {
    vi.resetModules()
    await import('./messageManager')
    expect(antd.message.config).toHaveBeenCalledWith(
      expect.not.objectContaining({ maxCount: expect.anything() })
    )
  })

  it('不带 key 的消息同屏最多三条，第四条把最早那条收掉', () => {
    message.error('一')
    message.error('二')
    message.error('三')
    expect(antd.destroyFns[0]).not.toHaveBeenCalled()
    message.error('四')
    expect(antd.destroyFns[0]).toHaveBeenCalledTimes(1)
  })

  it('带 key 的消息不占不带 key 的名额，也不会被收掉', () => {
    const closeProgress = message.loading({ content: '正在同步', key: 'sync', duration: 0 })
    message.error('一')
    message.error('二')
    message.error('三')
    message.error('四')
    expect(closeProgress).not.toHaveBeenCalled()
  })

  it('空内容带 key 时不让整个配置对象被当成内容渲染', () => {
    message.error({ content: '', key: 'k' })
    expect(antd.message.error).toHaveBeenCalledWith(
      expect.objectContaining({ content: ' ', key: 'k' })
    )
  })
})
