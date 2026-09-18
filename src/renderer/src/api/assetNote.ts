/**
 * 资产/文件夹「详细说明」的前端接口。
 *
 * 和 `api/note.ts` 的分工：那一套操作公共库的 note 表，现在只剩知识库的文本
 * 来源在用；这一套操作保管库的 assetNote 表 —— 说明跟着资产走，保管库换机器、
 * 做备份、整个拷走，它必须一起走。
 */

export interface AssetNote {
  id?: number
  title: string
  content: string
  created_at?: string
  updated_at?: string
}

interface IPCResponse<T> {
  success: boolean
  data?: T
  error?: string
}

function unwrap<T>(result: IPCResponse<T>, defaultError: string): T {
  if (!result?.success) throw new Error(result?.error || defaultError)
  return result.data as T
}

export const assetNoteAPI = {
  async create(data: Partial<AssetNote> = {}): Promise<number> {
    const result: IPCResponse<{ id: number }> = await window.electron.ipcRenderer.invoke(
      'assetNote:create',
      data
    )
    return unwrap(result, '创建说明失败').id
  },

  async getById(id: number): Promise<AssetNote | undefined> {
    const result: IPCResponse<AssetNote | undefined> = await window.electron.ipcRenderer.invoke(
      'assetNote:getById',
      id
    )
    return unwrap(result, '读取说明失败')
  },

  async search(keyword: string, options: { limit?: number } = {}): Promise<AssetNote[]> {
    const result: IPCResponse<AssetNote[]> = await window.electron.ipcRenderer.invoke(
      'assetNote:search',
      keyword,
      options
    )
    return unwrap(result, '搜索说明失败') || []
  },

  async update(id: number, updates: Partial<AssetNote>): Promise<boolean> {
    const result: IPCResponse<{ updated: boolean }> = await window.electron.ipcRenderer.invoke(
      'assetNote:update',
      id,
      updates
    )
    return unwrap(result, '保存说明失败').updated
  },

  async remove(id: number): Promise<boolean> {
    const result: IPCResponse<{ deleted: boolean }> = await window.electron.ipcRenderer.invoke(
      'assetNote:delete',
      id
    )
    return unwrap(result, '删除说明失败').deleted
  },

  /**
   * 把贴进正文的图片写进保管库，返回磁盘路径。
   *
   * 失败时**抛**，调用方必须接住并保留原来的 base64 —— 换成一个还不存在的
   * 文件路径，等于把用户那张图删了。
   */
  async saveImage(bytes: Uint8Array, ext: string): Promise<string> {
    const result: IPCResponse<{ filePath: string }> = await window.electron.ipcRenderer.invoke(
      'assetNote:saveImage',
      { bytes, ext }
    )
    return unwrap(result, '图片保存失败').filePath
  },

  /**
   * 把视频写进保管库。格式不在白名单里主进程会直接拒绝（不做兜底），
   * 抛出来的错要原样告诉用户 —— 他需要知道是格式不行，不是存坏了。
   */
  async saveVideo(bytes: Uint8Array, ext: string): Promise<string> {
    const result: IPCResponse<{ filePath: string }> = await window.electron.ipcRenderer.invoke(
      'assetNote:saveVideo',
      { bytes, ext }
    )
    return unwrap(result, '视频保存失败').filePath
  }
}

export default assetNoteAPI
