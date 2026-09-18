/**
 * 「个性化」那一页的渲染层 API。
 *
 * 渲染层不直接碰 `ipcRenderer`（AGENTS.md 硬规则 5），一律走 `window.api.*`，
 * 再在这里把「成功/失败」那层信封拆掉 —— 拆在一处，组件里就不用每个调用点
 * 都写一遍 `if (!result.success) ...`，也不会有人忘了写。
 */

export interface UserInstructions {
  text: string
  /** 字数上限。界面实时显示已用多少，不等用户写完了才拒绝 */
  limit: number
  /** 它在盘上的位置。这是用户自己的文件，他有权知道在哪、能不能用别的编辑器改 */
  path: string
}

export const personalizationAPI = {
  getInstructions(): Promise<UserInstructions> {
    return window.api.personalization.getInstructions()
  },

  async setInstructions(text: string): Promise<void> {
    const result = await window.api.personalization.setInstructions(text)
    if (!result.success) throw new Error(result.error || '保存说明失败')
  }
}
