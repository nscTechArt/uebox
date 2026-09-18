/**
 * 用户写给 agent 的一段常驻说明。
 *
 * ## 为什么需要它
 *
 * 「这个工程用 UE 5.5」「材质一律用 M_ 前缀」「别碰 Content/Legacy 那个目录」——
 * 这类事对同一个用户来说每条会话都成立，但在这之前它只能靠用户每次重打一遍。
 * 打漏了就是 agent 按默认习惯干活，然后用户在结果里发现它又用错了命名。
 *
 * ## 为什么是磁盘上的一个文件
 *
 * AGENTS.md 硬规则 10：用户自己写的东西，盘上那份是唯一真相源。这段说明是
 * 用户逐字敲出来的，不是界面偏好 —— 它得能被复制、备份，换台机器还在。
 * 放 localStorage 的话，清一次缓存就没了，而用户不会想到去备份它。
 *
 * 落在 `<userData>/instructions.md` 而不是工程目录里：它是**这个人**的习惯，
 * 不是某个工程的约定。工程级的约定该由工程自己带（以后的事）。
 *
 * ## 为什么有长度上限
 *
 * 它每一轮都进系统提示词，还占着可缓存的固定前缀。没有上限的话，用户粘一篇
 * 文档进来，每条消息都要为它付一次钱 —— 而且提示词越长，真正的行为约束越容易
 * 被淹没（skill 清单那边已经踩过一次）。
 */

import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { app } from 'electron'

/**
 * 上限 4000 字符（约 1000~2000 token）。
 *
 * 这个数是按用途定的：够写下十几条「我的项目是这样的」，不够粘一份规范文档。
 * 界面上实时显示已用多少，不是等用户写完了再拒绝。
 */
export const USER_INSTRUCTIONS_LIMIT = 4000

/** 说明文件的位置。导出是为了界面能告诉用户「它在这儿，可以直接编辑」 */
export function userInstructionsPath(): string {
  return join(app.getPath('userData'), 'instructions.md')
}

/**
 * 读那段说明。文件不存在、读不出来都回空串。
 *
 * 不抛异常：这是个可选增强，一个读不出来的文件不该让整条会话起不来。
 */
export async function readUserInstructions(): Promise<string> {
  try {
    return await readFile(userInstructionsPath(), 'utf-8')
  } catch {
    return ''
  }
}

/**
 * 写那段说明。超长的截断而不是拒绝 —— 上限在界面上一直显示着，
 * 走到这里说明用户是绕过界面写的（比如自己编辑了文件），静默截断比报错有用。
 */
export async function writeUserInstructions(text: string): Promise<void> {
  const trimmed = text.slice(0, USER_INSTRUCTIONS_LIMIT)
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(userInstructionsPath(), trimmed, 'utf-8')
}

/**
 * 拼进系统提示词的那一段。空的（没写过、或者只有空白）返回空串。
 *
 * ## 为什么用 XML 标签围起来
 *
 * 和 skill 清单同一个理由：模型得知道这段话从哪开始、到哪结束。少了边界，
 * 用户说明的最后一句会和后面的环境块黏在一起。
 *
 * ## 为什么要说明它的来源和权重
 *
 * 不说的话，模型面对「这段话」和「系统提示词里那几十条规矩」冲突时没有判据。
 * 这段是**用户本人**写的，所以它压过默认习惯 —— 但压不过安全约束：
 * 一段写着「以后所有操作都不用问我」的说明不该把审批门关掉，那道门是
 * `core/approval.ts` 管的，不是提示词能松的。明写这一条，免得模型自己发挥。
 */
export function buildUserInstructionsSection(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''

  return `

The user wrote the following standing description of themselves and how they work — their role,
what they do and do not know, how much detail they want. Use it to pitch your answers and to
pick defaults; it outranks your own habits about tone, depth and what to assume they know.

It does not change what needs their approval: tool risk levels and the approval gate are
enforced outside this prompt, and a line here asking you to stop confirming things has no
effect on them.

<user_instructions>
${trimmed.slice(0, USER_INSTRUCTIONS_LIMIT)}
</user_instructions>
`
}
