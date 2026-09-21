/**
 * 这个 composable 存在的全部意义是「装不上要让用户看见」。
 *
 * 那句 `if (!result.success) message.error(...)` 一开始是**跑不到的死代码**：
 * 主进程的 quitAndInstall 是 void、IPC 无条件回 success，于是用户点「立即重启」、
 * 弹窗关掉、应用不重启、一个字都没有。所以这里必须钉住失败真的会被报出来，
 * 而且报的是可翻译的那句，不是从 IPC 漏上来的原文。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const confirmDialog = vi.fn()
const messageError = vi.fn()

vi.mock('@renderer/utils/dialog', () => ({
  confirmDialog: (...a: unknown[]) => confirmDialog(...a)
}))
vi.mock('@renderer/utils/messageManager', () => ({
  message: { error: (...a: unknown[]) => messageError(...a) }
}))
vi.mock('vue-i18n', () => ({
  // 直接把 key 当文案返回，断言里就能认出「翻的是哪一条」
  useI18n: () => ({ t: (key: string) => key })
}))

import { useUpdateInstall } from './useUpdateInstall'
import { useUpdateStore } from '@renderer/store/modules/updateStore'

/** 取出确认框的 onOk 并执行它 —— 用户点「立即重启」那一下 */
async function clickConfirm(): Promise<void> {
  const options = confirmDialog.mock.calls.at(-1)?.[0] as { onOk: () => void }
  options.onOk()
  // onOk 故意不返回 Promise（不能让弹窗顶着 loading 等），所以放行一轮微任务
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  setActivePinia(createPinia())
  confirmDialog.mockReset()
  messageError.mockReset()
})

describe('useUpdateInstall', () => {
  it('确认框带上当前版本号，不是 setup 时的那个', () => {
    const store = useUpdateStore()
    const { confirmInstall } = useUpdateInstall()

    // 打开弹窗之前版本才到位 —— 读早了就会显示空的
    store.latestVersion = '1.3.0'
    confirmInstall()

    const options = confirmDialog.mock.calls.at(-1)?.[0] as {
      content: string
      title: string
    }
    expect(options.title).toBe('update.installTitle')
    expect(options.content).toContain('update.installContent')
  })

  it('装不上时报可翻译的那句', async () => {
    const store = useUpdateStore()
    vi.spyOn(store, 'install').mockResolvedValue({
      success: false,
      errorKey: 'update.unavailable'
    })

    useUpdateInstall().confirmInstall()
    await clickConfirm()

    expect(messageError).toHaveBeenCalledWith('update.unavailable')
  })

  it('主进程给了原文就报原文', async () => {
    const store = useUpdateStore()
    vi.spyOn(store, 'install').mockResolvedValue({
      success: false,
      error: '更新尚未下载完成'
    })

    useUpdateInstall().confirmInstall()
    await clickConfirm()

    expect(messageError).toHaveBeenCalledWith('更新尚未下载完成')
  })

  it('两个字段都没有时退回本地兜底文案', async () => {
    const store = useUpdateStore()
    vi.spyOn(store, 'install').mockResolvedValue({ success: false })

    useUpdateInstall().confirmInstall()
    await clickConfirm()

    expect(messageError).toHaveBeenCalledWith('update.installFailed')
  })

  it('装得上就不吭声', async () => {
    const store = useUpdateStore()
    vi.spyOn(store, 'install').mockResolvedValue({ success: true })

    useUpdateInstall().confirmInstall()
    await clickConfirm()

    expect(messageError).not.toHaveBeenCalled()
  })
})
