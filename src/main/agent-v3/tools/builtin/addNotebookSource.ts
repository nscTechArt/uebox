import type { WebContents } from 'electron'
import { z } from 'zod'

import { getPublicDatabase } from '../../../sqliteDataBase'
import { createNotebook, createNotebookSource } from '../../../sqliteDataBase/models/notebook'
import { indexNotebookRag } from '../../../sqliteDataBase/services/notebookRagService'
import { readWebPageLocally } from '../../../services/webReader'
import { checkNavigationUrl } from '../../../services/agentBrowser/urlPolicy'
import { defineTool, type UnrealAgentTool } from '../defineTool'

/**
 * 把查到的东西存进当前知识库。
 *
 * ## 为什么是一个工具，而不是界面上的一个按钮
 *
 * 知识库原来有两个搜索页签：「网页」（搜一次 → 勾选 → 加进来）和「深度搜索」
 * （一整套研究流水线）。两个都删了，理由是同一条：**它们是 Agent 已经会做的事的
 * 一个更弱的复刻**。模型手上本来就有 `web_search` / `web_read` / `search_notebook_sources`，
 * 缺的只是最后一步「把它存下来」—— 补上这一个工具，用户就可以直接说
 * 「查一下 X，有用的存进来」，而拆几个子问题、读哪几篇、要不要再查一轮，
 * 交给它自己判断，比写死在界面里灵活得多。
 *
 * ## 用户仍然是拍板的那个
 *
 * 这个工具标 `mutating`：它往用户的知识库里放东西。助手默认的审批档是「每个写操作
 * 都问」，所以每存一条都会弹确认，用户看得见要存什么、从哪来。原来那个勾选列表
 * 提供的控制力没有丢，只是从「先勾再加」变成「它提议、你点头」。
 */

const input = z
  .object({
    url: z
      .string()
      .optional()
      .describe('要存进来的网页地址。工具会自己抓正文，不用你先 web_read 一遍'),
    title: z.string().optional().describe('来源标题。给 content 时必填'),
    content: z.string().optional().describe('直接存一段你整理好的内容（Markdown）。和 url 二选一'),
    notebookTitle: z
      .string()
      .optional()
      .describe('未绑定知识库时新建的知识库标题。不填就使用来源标题')
  })
  .describe('要么给 url，要么给 title + content')

interface AddedSource {
  sourceId: string
  notebookId: string
  notebookTitle: string
  createdNotebook: boolean
  title: string
  url: string | null
  chars: number
}

/**
 * 给模型整理稿加一行抬头。
 *
 * 这一行是**我们写的**，不是模型写的 —— 那正是它的意义：知识库里躺半年之后，
 * 没有任何东西能让人分清「一份原始网页」和「一份 AI 综述」，而它们的可信度
 * 差着一个量级。两次真机验收里，出问题的都是综述那一类：
 *
 *   · 2026-09-07 第一次：把官网划掉的旧建议当成现行结论（读取失真，已修）；
 *   · 同日复验：把论坛提问者的代码分析记到核心开发者名下（归因错误，机器判不了）。
 *
 * 两次的网址都是真的、原文都读过。所以这行抬头不承诺内容正确 —— 它只保证
 * **读的人知道自己在读什么**，以及回哪儿去核对。
 *
 * 只加给整理稿。用 url 存进来的是抓回来的真页面，加这行反而是在污染原文。
 */
function withSynthesisHeader(content: string): string {
  const now = new Date().toLocaleString('zh-CN')
  return (
    `> **这是 AI 整理的稿子，不是原始网页。**（${now}）\n` +
    '> 结论以正文里的链接为准；尤其是「谁说的」「哪个版本」这两件事，回原页面核对一遍再引用。\n\n' +
    content
  )
}

export function createAddNotebookSourceTool(
  notebook: { id: string; title?: string } | undefined,
  sender: WebContents
): UnrealAgentTool<AddedSource> {
  const destination = notebook?.title
    ? `知识库「${notebook.title}」`
    : notebook
      ? '当前知识库'
      : '一个新知识库'

  return defineTool({
    name: 'add_notebook_source',
    namespace: 'notebook',
    risk: 'mutating',
    description: `把一个网页或一段整理好的内容存进${destination}，成为一条可检索的来源。

【什么时候用】用户让你查资料并**留下来**的时候 —— 「查一下 X 存进来」「把这几篇加到知识库」。
查完不存等于白查：这次对话结束，那些内容就没了。

【两种用法】
- 存网页：只给 url。工具自己抓正文并提取，不需要你先 web_read（已经读过也没关系，重复抓一次不影响）。
- 存你自己写的：给 title + content，比如把几篇材料的结论综述成一篇。这种要在正文里写清楚出处。

【放到哪里】当前会话绑定了知识库就加到那里；没绑定就新建知识库，标题默认沿用来源标题，也可以传 notebookTitle。用户点名要加到某个已有知识库而当前没绑定时，先让他用 /wiki 选中，别新建一个同名副本。

【存之前】先确认这一条值得存 —— 知识库是用户长期要用的资料，不是搜索结果的垃圾桶。
存不进去的（要登录、纯前端渲染、抓不到正文）如实告诉用户，别改存一段你自己编的摘要糊过去。`,
    input,
    execute: async (args) => {
      const db = getPublicDatabase()

      let title = args.title?.trim() ?? ''
      let content = args.content ?? ''
      let sourceUrl: string | null = null

      if (args.url) {
        // 和 web_read 共用同一套地址判据：本机、内网、危险协议一律不碰。
        // 少了这一层，这个工具就是一个能把内网页面存进知识库的探测器
        const checked = checkNavigationUrl(args.url)
        if (!checked.ok) throw new Error(`[NAVIGATION_BLOCKED] ${checked.reason}`)

        const page = await readWebPageLocally(checked.url.toString())
        if (!page.success || !page.content) {
          // 同 web_read：用户那句 + 给模型的下一步，模型两句都该看到
          throw new Error(
            [page.error ?? '没有读到正文，这一条没有存进知识库。', page.agentHint]
              .filter(Boolean)
              .join(' ')
          )
        }
        title = title || page.title || checked.url.toString()
        content = page.content
        sourceUrl = page.url ?? checked.url.toString()
      }

      if (!content.trim()) {
        throw new Error('没有内容可存：给一个 url，或者给 title + content。')
      }
      if (!title) {
        throw new Error('这一条没有标题。来源列表上显示的就是它，给一个说得清是什么的标题。')
      }

      const createdNotebook = !notebook
      const notebookTitle = notebook?.title || args.notebookTitle?.trim() || title
      const notebookId =
        notebook?.id ||
        createNotebook(db, {
          title: notebookTitle
        })

      const sourceId = createNotebookSource(db, {
        sourceId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        notebookId,
        // 网页存成 link（界面按它显示来源图标），自己写的存成 text
        type: sourceUrl ? 'link' : 'text',
        title,
        content: sourceUrl ? content : withSynthesisHeader(content),
        sourceUrl,
        fileName: null,
        loading: false,
        error: null
      })

      // 建索引失败不影响这条来源：它已经在库里了，检索会退回关键词那一路
      let indexed = true
      try {
        await indexNotebookRag(db, notebookId, { sourceIds: [sourceId] })
      } catch (error) {
        indexed = false
        console.warn('[AddNotebookSource] 向量化失败，仍可按关键词检索：', error)
      }

      // 通知界面刷新来源列表 —— 不发的话用户要手动切一次页面才看得见
      if (!sender.isDestroyed()) {
        sender.send('agent:notebook:source-changed', {
          notebookId,
          sourceId,
          title
        })
      }

      return {
        text:
          `${createdNotebook ? `已新建知识库「${notebookTitle}」并存入来源` : `已存入知识库「${notebookTitle}」`}：${title}（${content.length} 字）` +
          `${sourceUrl ? `\n来源：${sourceUrl}` : ''}` +
          `${indexed ? '' : '\n注意：这一条的向量索引没建成，只能按关键词检索到。'}`,
        details: {
          sourceId,
          notebookId,
          notebookTitle,
          createdNotebook,
          title,
          url: sourceUrl,
          chars: content.length
        }
      }
    }
  })
}
