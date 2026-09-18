import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Modal } from 'ant-design-vue'

import { confirmDialog, errorDialog, infoDialog, successDialog, warningDialog } from './dialog'

/**
 * 这一层存在的意义是「换掉 ant-design-vue 时只改一个文件」。
 * 所以测的是接缝本身：每个入口转调到对的底层方法，且我们自己的选项名
 * 被正确翻译成 antd 的形状。
 */
describe('dialog 对 antd Modal 的封装', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('五个入口各自转调对应的 Modal 方法', () => {
    const spies = {
      confirm: vi.spyOn(Modal, 'confirm').mockReturnValue({ destroy: vi.fn() } as never),
      error: vi.spyOn(Modal, 'error').mockReturnValue({ destroy: vi.fn() } as never),
      warning: vi.spyOn(Modal, 'warning').mockReturnValue({ destroy: vi.fn() } as never),
      info: vi.spyOn(Modal, 'info').mockReturnValue({ destroy: vi.fn() } as never),
      success: vi.spyOn(Modal, 'success').mockReturnValue({ destroy: vi.fn() } as never)
    }

    confirmDialog({ title: '确认' })
    errorDialog({ title: '出错' })
    warningDialog({ title: '警告' })
    infoDialog({ title: '提示' })
    successDialog({ title: '成功' })

    expect(spies.confirm).toHaveBeenCalledOnce()
    expect(spies.error).toHaveBeenCalledOnce()
    expect(spies.warning).toHaveBeenCalledOnce()
    expect(spies.info).toHaveBeenCalledOnce()
    expect(spies.success).toHaveBeenCalledOnce()
  })

  // antd 里同一件事有 okType 和 okButtonProps 两种写法，对外统一成 danger
  it('danger: true 翻译成 antd 的 okType: danger', () => {
    const spy = vi.spyOn(Modal, 'confirm').mockReturnValue({ destroy: vi.fn() } as never)

    confirmDialog({ title: '删除', danger: true })

    expect(spy.mock.calls[0][0]).toMatchObject({ title: '删除', okType: 'danger' })
    // danger 是我们自己的名字，不该原样漏给 antd
    expect(spy.mock.calls[0][0]).not.toHaveProperty('danger')
  })

  it('不传 danger 时不加 okType，保持 antd 默认按钮', () => {
    const spy = vi.spyOn(Modal, 'confirm').mockReturnValue({ destroy: vi.fn() } as never)

    confirmDialog({ title: '归档' })

    expect(spy.mock.calls[0][0]).not.toHaveProperty('okType')
  })

  it('其余选项原样透传，onOk 也不被包一层', () => {
    const spy = vi.spyOn(Modal, 'confirm').mockReturnValue({ destroy: vi.fn() } as never)
    const onOk = vi.fn()

    confirmDialog({ title: '标题', content: '正文', okText: '好', centered: true, onOk })

    expect(spy.mock.calls[0][0]).toMatchObject({
      title: '标题',
      content: '正文',
      okText: '好',
      centered: true,
      onOk
    })
  })

  // 自定义 footer 的弹窗要靠这个句柄关掉自己
  it('把 antd 的句柄交回去，自定义 footer 才关得掉弹窗', () => {
    const destroy = vi.fn()
    vi.spyOn(Modal, 'confirm').mockReturnValue({ destroy } as never)

    confirmDialog({ title: '选择导入方式' }).destroy()

    expect(destroy).toHaveBeenCalledOnce()
  })
})
