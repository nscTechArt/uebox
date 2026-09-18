/**
 * 切换当前活跃保管库。
 *
 * ## 为什么这件事要单独做成一个工具
 *
 * 边界是：**读跨库，写不跨库**（见 `vaultScope.ts`）。搜索和统计看遍所有库，
 * 而移动/删除/改备注/导入工程一律只在当前活跃库里发生。
 *
 * 于是必然会撞上这一幕：用户站在 AIGC 库上说「把 SoStylized 导入项目」，
 * 而 SoStylized 在默认保管库里。工具能**看见**它，但不能在那儿动手。
 *
 * 出路只有一条 —— 换库。而换库是**用户的决定**，不是 agent 的：
 * 应用的整个界面会跟着换一个库，他正在看的东西会变。所以这个工具的风险
 * 定成 `mutating`，走审批门：用户看到「要切到『默认保管库』吗？」，
 * 可以放行一次，也可以点「本会话都允许」让它以后自己切。
 * 那个按钮就是「要不要自动帮我切过去」这个选项本身，不必再造一个设置。
 *
 * ## 切完不切回来
 *
 * 用户要的是「把 SoStylized 导进去」，事情做完他人就该在那个库里。
 * 偷偷切回原来的库是第二次意外 —— 他会发现自己刚操作过的东西又不见了。
 */

import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { getDatabaseManager } from '../../../../sqliteDataBase'

export function createSwitchVaultTool(): V2Tool {
  return defineV2Tool({
    description: `切换当前活跃的保管库（资产库）。

【什么时候用】search_assets / library_overview 告诉你东西在**另一个保管库**里，
  而你要对它做改动（导入工程、移动、删除、改备注、打标签）时。
  那些操作只能在活跃库里进行，所以得先切过去。
【要用户点头】这一步会弹确认框 —— 应用整个界面会跟着换库，是用户的决定。
  他可以选「本会话都允许」，之后你就能自己切。被拒绝就**如实告诉他
  需要手动切换**，不要绕路，也不要说成「这个素材不存在」。
【切完不用切回来】事情做完就留在那个库里，别自作主张切回去。
【只读的搜索和统计不需要它】search_assets 和 library_overview 默认就搜遍所有库。`,
    inputSchema: z.object({
      vault: z.string().describe('要切到哪个保管库：库名（如「默认保管库」）或保管库 id'),
      reason: z
        .string()
        .optional()
        .describe('为什么要切。会显示在确认框里给用户看，写清楚要去那个库做什么')
    }),
    execute: async (input) => {
      const vaultManager = getDatabaseManager().getVaultManager()
      const raw = String(input.vault ?? '').trim()
      const all = vaultManager.getAllVaults()

      const target = all.find((v) => v.name.toLowerCase() === raw.toLowerCase() || v.id === raw)
      if (!target) {
        return {
          success: false,
          error: `没有叫「${raw}」的保管库。现在有这几个：${all.map((v) => v.name).join('、')}。`
        }
      }

      const current = vaultManager.getCurrentVault()
      if (current?.id === target.id) {
        return {
          success: true,
          vault: target.name,
          already_active: true,
          message: `已经在「${target.name}」上了，不用切。`
        }
      }

      const result = await vaultManager.switchToVault(target.id)
      if (!result.success) {
        return { success: false, error: `切换到「${target.name}」失败：${result.error}` }
      }

      // 回读校验：切完再问一次当前库是谁。对不上就不许报成功 ——
      // 否则后面每一个写操作都会打在用户以为已经离开的那个库上。
      const after = vaultManager.getCurrentVault()
      if (after?.id !== target.id) {
        return {
          success: false,
          error:
            `切换命令跑完了，但回读时活跃库还是「${after?.name ?? '查不到'}」—— ` +
            '没有确认切过去。别在这个状态下继续做改动，请让用户在界面上手动切一次。'
        }
      }

      return {
        success: true,
        vault: target.name,
        previous_vault: current?.name,
        ...(result.networkError ? { network_warning: result.networkError } : {}),
        message:
          `已经切到「${target.name}」（原来是「${current?.name ?? '无'}」）。` +
          '接下来的改动都会落在这个库里。事情做完就留在这儿，不用切回去。'
      }
    }
  })
}
