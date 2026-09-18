/**
 * 知识库产出的读写。落在保管库里，不在 localStorage。
 *
 * 为什么搬家见主进程那一侧的注释（`ipc/notebookOutputs.ts`）：一句话是
 * localStorage 会写满之后静默丢，而这些是用户花钱让模型生成的东西，得跟着保管库走。
 */

interface IPCResponse<T> {
  success: boolean
  data?: T
  error?: string
}

export const studioOutputsAPI = {
  /** 读一个知识库的产出。没有就是 null，不是错误 */
  async read(notebookId: string): Promise<string | null> {
    const result: IPCResponse<string | null> = await window.electron.ipcRenderer.invoke(
      'notebook:outputs:read',
      notebookId
    )
    if (!result.success) throw new Error(result.error || '读取知识库产出失败')
    return result.data ?? null
  },

  /** 写一个知识库的产出。失败会抛，调用方必须让用户看见 */
  async write(notebookId: string, value: string): Promise<void> {
    const result: IPCResponse<boolean> = await window.electron.ipcRenderer.invoke(
      'notebook:outputs:write',
      notebookId,
      value
    )
    if (!result.success) throw new Error(result.error || '保存知识库产出失败')
  },

  /** 删知识库时连它的产出一起删 */
  async remove(notebookId: string): Promise<void> {
    const result: IPCResponse<boolean> = await window.electron.ipcRenderer.invoke(
      'notebook:outputs:remove',
      notebookId
    )
    if (!result.success) throw new Error(result.error || '删除知识库产出失败')
  }
}

export default studioOutputsAPI
