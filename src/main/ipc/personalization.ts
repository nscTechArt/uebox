/**
 * 「个性化」那一页的后端：用户写给 agent 的那段常驻说明。**只有这一件事。**
 *
 * 技能（列出来、删掉）原来也在这个文件里，因为当时的想法是「说明和技能都是
 * 『这个 agent 有多懂我』的一半」。那个归类是错的：技能是一份可以浏览、搜索、
 * 按来源筛的清单，它自己就该是一页；把删除留在个性化，等于同一个东西有两个
 * 入口。现在列和删都在 `ipc/agentV3.ts`，和 `agent-v3:list-skills` 挨着。
 */

import { ipcMain } from 'electron'

import {
  readUserInstructions,
  USER_INSTRUCTIONS_LIMIT,
  userInstructionsPath,
  writeUserInstructions
} from '../agent-v3/capabilities/userInstructions'

export function registerPersonalizationIPC(): void {
  /**
   * 读那段说明，连同上限和它在盘上的位置一起给出去。
   *
   * 路径也给：这段话是用户自己的文件，他有权知道它在哪、能不能拿别的编辑器改。
   * 藏起来的话，「我的东西存在哪」就只能靠猜。
   */
  ipcMain.handle('personalization:getInstructions', async () => ({
    text: await readUserInstructions(),
    limit: USER_INSTRUCTIONS_LIMIT,
    path: userInstructionsPath()
  }))

  ipcMain.handle('personalization:setInstructions', async (_event, text: unknown) => {
    if (typeof text !== 'string') return { success: false, error: '说明必须是文本' }
    try {
      await writeUserInstructions(text)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
