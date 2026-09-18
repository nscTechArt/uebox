import type { Note } from '../types/note'

// IPC响应类型
interface IPCResponse<T> {
  success: boolean
  data?: T
  error?: string
}

/**
 * 笔记API
 * 封装IPC调用，提供前端访问笔记数据的接口
 */
export const noteAPI = {
  /**
   * 创建新笔记
   * @param data 笔记数据（可选）
   * @returns 新笔记的ID
   */
  create: async (data: Partial<Note> = {}): Promise<number> => {
    const result: IPCResponse<{ id: number }> = await window.electron.ipcRenderer.invoke(
      'note:create',
      data
    )
    if (!result.success) {
      throw new Error(result.error || '创建笔记失败')
    }
    return result.data!.id
  },

  /**
   * 根据ID获取笔记
   * @param id 笔记ID
   * @returns 笔记对象
   */
  getById: async (id: number): Promise<Note | undefined> => {
    const result: IPCResponse<Note | undefined> = await window.electron.ipcRenderer.invoke(
      'note:getById',
      id
    )
    if (!result.success) {
      throw new Error(result.error || '获取笔记失败')
    }
    return result.data
  },

  /**
   * 列出所有笔记
   * @param options 查询选项
   * @returns 笔记列表
   */
  list: async (options: { limit?: number; offset?: number } = {}): Promise<Note[]> => {
    const result: IPCResponse<Note[]> = await window.electron.ipcRenderer.invoke(
      'note:list',
      options
    )
    if (!result.success) {
      throw new Error(result.error || '获取笔记列表失败')
    }
    return result.data || []
  },

  /**
   * 搜索笔记
   * @param keyword 搜索关键词
   * @param options 查询选项
   * @returns 匹配的笔记列表
   */
  search: async (
    keyword: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<Note[]> => {
    const result: IPCResponse<Note[]> = await window.electron.ipcRenderer.invoke(
      'note:search',
      keyword,
      options
    )
    if (!result.success) {
      throw new Error(result.error || '搜索笔记失败')
    }
    return result.data || []
  },

  /**
   * 更新笔记
   * @param id 笔记ID
   * @param updates 要更新的字段
   * @returns 是否更新成功
   */
  /**
   * 把贴进笔记的图片写进保管库，返回它在磁盘上的路径。
   *
   * 失败时**抛**，调用方必须接住并保留原来的 base64 —— 换成一个还不存在的
   * 文件路径，等于把用户那张图删了。
   */
  saveImage: async (bytes: Uint8Array, ext: string): Promise<string> => {
    const result: IPCResponse<{ filePath: string }> = await window.electron.ipcRenderer.invoke(
      'note:saveImage',
      { bytes, ext }
    )
    if (!result.success) {
      throw new Error(result.error || '图片保存失败')
    }
    return result.data!.filePath
  },

  /**
   * 把视频写进保管库，返回它在磁盘上的路径。
   *
   * 格式不在白名单里主进程会直接拒绝（不做「当成 mp4」的兜底），所以这里
   * 抛出来的错要原样告诉用户 —— 他需要知道是格式不行，不是存坏了。
   */
  saveVideo: async (bytes: Uint8Array, ext: string): Promise<string> => {
    const result: IPCResponse<{ filePath: string }> = await window.electron.ipcRenderer.invoke(
      'note:saveVideo',
      { bytes, ext }
    )
    if (!result.success) {
      throw new Error(result.error || '视频保存失败')
    }
    return result.data!.filePath
  },

  update: async (id: number, updates: Partial<Note>): Promise<boolean> => {
    const result: IPCResponse<{ updated: boolean }> = await window.electron.ipcRenderer.invoke(
      'note:update',
      id,
      updates
    )
    if (!result.success) {
      throw new Error(result.error || '更新笔记失败')
    }
    return result.data!.updated
  },

  /**
   * 删除笔记
   * @param id 笔记ID
   * @returns 是否删除成功
   */
  delete: async (id: number): Promise<boolean> => {
    const result: IPCResponse<{ deleted: boolean }> = await window.electron.ipcRenderer.invoke(
      'note:delete',
      id
    )
    if (!result.success) {
      throw new Error(result.error || '删除笔记失败')
    }
    return result.data!.deleted
  }
}

export default noteAPI
