/**
 * 知识库产出（思维导图、报告、知识网页、知识图谱、模拟面试、头脑风暴）的落盘。
 *
 * ## 为什么必须挪出 localStorage
 *
 * 这些东西原来整包存在浏览器的 localStorage 里（`studio-outputs` 这个键）。三个问题：
 *
 * 1. **会静默丢。** localStorage 的配额只有几 MB，而一张信息图的 base64、一个知识
 *    网页的 HTML 动辄几百 KB。写满之后 `setItem` 抛 QuotaExceededError，新产出
 *    就再也存不上了 —— 用户不会看到任何提示。
 * 2. **带不走。** 用户花钱让模型生成的报告是他的资产，却躺在一个跟着应用走、
 *    拷不出来也备份不到的地方。仓库的硬规则第 10 条说的正是这件事。
 * 3. **删知识库时一起没。** 那本来是对的，但前提是它得先存在某个地方。
 *
 * 所以改成落在**保管库**里：`<保管库>/Notebook/<知识库 id>/outputs.json`。
 * 跟着保管库走，拷得走、备份得到、换台机器还在。
 *
 * ## 为什么一个知识库一个文件
 *
 * 整份一个大 JSON 的话，任何一次写入都要把所有知识库的产出重新序列化一遍；
 * 而知识库之间本来就没有关系。按知识库分文件，写的时候只碰这一个。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { ipcMain } from 'electron'

import { writeSessionFile as writeFileAtomic } from '../../agent-v3/core/atomicSessionFile'
import { PathManager } from '../../utils/PathManager'

/** 产出文件名。放在这个知识库自己的目录下，跟信息图那些文件做邻居 */
const OUTPUTS_FILE = 'outputs.json'

/**
 * 每个知识库一条写入队列。
 *
 * 渲染层是 `void persistNotebook(...)` 发过来的，一次生成会连着改好几次；
 * 不排队的话两次写入会同时落在同一个文件上，后写的那次带着更旧的数组，
 * 把先写的那份产出顶掉。
 */
const writeQueues = new Map<string, Promise<unknown>>()

/**
 * 知识库 id → 它的产出文件路径。
 *
 * id 是渲染层传来的，必须挡住路径穿越：只允许字母数字和 `-_`，
 * 其余一律拒绝（而不是「清洗成看起来安全的样子」—— 清洗过的 id 会对不上原来的目录）。
 */
function outputsPathFor(notebookId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(notebookId)) {
    throw new Error(`不合法的知识库 id: ${notebookId}`)
  }
  const vaultPath = PathManager.getInstance().getCurrentVaultPath()
  return join(vaultPath, 'Notebook', notebookId, OUTPUTS_FILE)
}

export const registerNotebookOutputsIPC = (): void => {
  /** 读一个知识库的产出。文件不存在就是「还没生成过」，不是错误 */
  ipcMain.handle('notebook:outputs:read', async (_e, notebookId: string) => {
    try {
      const text = await fs.readFile(outputsPathFor(notebookId), 'utf8')
      return { success: true, data: text }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { success: true, data: null }
      }
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 写一个知识库的产出。
   *
   * 临时文件 + rename：写到一半断电时，磁盘上要么是完整的旧版本、要么是完整的新版本，
   * 不会是半份读不出来的 JSON —— 那等于把用户此前所有的产出一起弄丢。
   *
   * 临时文件名必须带随机串、写入必须按知识库排队：两次并发写用同一个 `.tmp`
   * 会各写各的偏移，rename 出去的就是一份交错的半成品 —— 恰好是上面要防的事。
   */
  ipcMain.handle('notebook:outputs:write', async (_e, notebookId: string, value: string) => {
    try {
      const target = outputsPathFor(notebookId)
      const next = (writeQueues.get(notebookId) ?? Promise.resolve()).then(() =>
        writeFileAtomic(target, value)
      )
      // 队列里不能留着 rejected 状态，否则一次写失败会把后面每一次都拖挂
      writeQueues.set(
        notebookId,
        next.catch(() => undefined)
      )
      await next
      return { success: true, data: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /** 删知识库时把它的产出一起删掉 */
  ipcMain.handle('notebook:outputs:remove', async (_e, notebookId: string) => {
    try {
      await fs.rm(outputsPathFor(notebookId), { force: true })
      return { success: true, data: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })
}
