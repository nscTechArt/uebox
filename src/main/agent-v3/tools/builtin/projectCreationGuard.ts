/**
 * 建工程该走 `project_manage` —— 发现在用通用工具建工程时，在结果后面提醒。
 *
 * ## 为什么需要它
 *
 * 真机上发生过：用户让 agent 建一个 UE5.5 空白工程，模型直接把引擎的
 * `Templates/TP_BlankBP` 整个拷到了目标目录。工程确实建出来了，用户也看到了
 * 「建好了」，但**这条路绕过了所有该走的东西**：
 *
 *   - 没走风险确认（`project_manage` 是写工具，会问；拷目录用的 shell 虽然也问，
 *     但用户看到的是一条 `cp -r`，看不出这是在建工程）
 *   - 没登记进「我的项目」 —— 用户回到首页，什么都没多出来
 *   - 没装 UnrealAgentLink —— 建完的工程连不上盒子
 *   - `.uproject` 里的 `EngineAssociation` 还是模板里那个空字符串，
 *     双击会弹「选择引擎版本」，首页卡片上也没有版本角标
 *   - 第三人称之类的模板还依赖共享内容包，光拷模板目录一打开就是丢失引用
 *
 * 提示词里写「优先用 project_manage」是软的，模型不一定每次都听。这里在工具结果
 * 后面追加一段提醒：认出「正在用通用工具建工程」这件事，指出正路和理由。
 *
 * ## 为什么是提醒而不是拦截
 *
 * 一度是硬拦：命令里出现模板目录就拒绝执行，写任何 .uproject 都拒绝。它同时
 * 拦掉了正当操作 —— `ls` / `cat` 看一眼模板里有什么、对照模板修一个
 * 损坏的 .uproject、用户明确要求的手工搭建。拦截之后模型只会换个写法再试，
 * 用户看到的是一串失败。提醒能达到同样的目的：模型拷模板只是因为不知道有
 * 更好的路，读到理由之后正路比歪路省事得多。
 *
 * 和 `pathBoundary` 一样，这是在**字符串里找特征**，不是沙箱。
 */

import { normalizeCommand } from './pathBoundary'

/**
 * 引擎模板目录的特征。
 *
 * `Templates/TP_` 是 UE 自带工程模板的固定命名（TP_BlankBP、TP_ThirdPersonBP…），
 * `Templates/TemplateResources` 是共享内容包的家。
 *
 * **不按动词判**（cp / xcopy / robocopy / Copy-Item / rsync / tar …）：那份清单列不全。
 * 按路径判的代价是只读命令（`ls`、`cat`）也会带上提醒 —— 提醒不拦路，多一句无妨。
 */
const TEMPLATE_FRAGMENTS = ['/templates/tp_', '/templates/templateresources/']

const CREATE_PROJECT_REASON =
  'project_manage 的 create_project 会把工程登记进用户的「我的项目」、装好 UnrealAgentLink、' +
  '填好 EngineAssociation，并带上模板依赖的共享内容包；手工拷模板或写 .uproject 建出来的工程这些都没有。'

const WRITE_UPROJECT_MESSAGE =
  '提醒：如果这是在新建工程，请改用 project_manage 的 create_project（先用 project_list 的 ' +
  'list_templates 看模板）。' +
  CREATE_PROJECT_REASON

const COPY_TEMPLATE_MESSAGE =
  '提醒：这条命令涉及引擎的工程模板目录。如果是在新建工程，请改用 project_manage 的 ' +
  'create_project。' +
  CREATE_PROJECT_REASON

/** 这个路径是不是在写一个 .uproject */
function isUprojectPath(target: string): boolean {
  return /\.uproject\s*$/i.test(target.trim())
}

/**
 * `write_local_file` 写 .uproject 时追加的提醒。写照常进行。
 *
 * 只管 `write`（整份新建/覆盖），不管 `edit` —— 改已有工程的 .uproject（启用插件、
 * 调 EngineAssociation）是常见的正当需求，那件事用 edit 做，不需要提醒。
 */
export function uprojectWriteAdvice(target: string): string | undefined {
  return isUprojectPath(target) ? WRITE_UPROJECT_MESSAGE : undefined
}

/** 命令涉及引擎模板目录时追加的提醒。命令照常执行 */
export function engineTemplateAdvice(command: string): string | undefined {
  const normalized = normalizeCommand(command)
  return TEMPLATE_FRAGMENTS.some((fragment) => normalized.includes(fragment))
    ? COPY_TEMPLATE_MESSAGE
    : undefined
}

export const __testing = {
  TEMPLATE_FRAGMENTS,
  WRITE_UPROJECT_MESSAGE,
  COPY_TEMPLATE_MESSAGE
}
