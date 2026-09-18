/**
 * 建工程只能走 `project_manage` 这道边界。
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
 * 提示词里写「优先用 project_manage」是软的，模型不一定每次都听。这道边界
 * 是硬的：认出「正在用通用工具建工程」这件事，当场拦下来并指路。
 *
 * ## 它不是沙箱
 *
 * 和 `pathBoundary` 一样，这是在**字符串里找特征**。写个脚本再执行、变量拼接、
 * 先拷到别处再改名 —— 都能绕过去。但绕过它需要动机，而模型在这里没有动机：
 * 它拷模板只是因为不知道有更好的路，被拦一次并读到「用 project_manage」之后，
 * 正路比歪路省事得多。
 *
 * 这也是为什么第 1 步（让 `create_project` 真的能用引擎自带模板）必须先做完：
 * 规则要先有能力兜着，否则这道墙只是把一次成功换成一次失败。
 */

import { normalizeCommand } from './pathBoundary'

/**
 * 引擎模板目录的特征。
 *
 * `Templates/TP_` 是 UE 自带工程模板的固定命名（TP_BlankBP、TP_ThirdPersonBP…），
 * `Templates/TemplateResources` 是共享内容包的家。命中其中之一，基本就是在
 * 拿引擎模板拼工程。
 *
 * 特意**不按动词判**（cp / copy / xcopy / robocopy / Copy-Item / rsync / tar …）：
 * 那份清单永远列不全，而换一个拷贝命令是模型最自然的下一步。按目标路径判，
 * 换什么命令都一样会被拦。
 */
const TEMPLATE_FRAGMENTS = ['/templates/tp_', '/templates/templateresources/']

const WRITE_UPROJECT_MESSAGE =
  '不要自己写 .uproject 文件来建工程 —— 这样建出来的工程不会进用户的「我的项目」、' +
  '不会装 UnrealAgentLink、EngineAssociation 也是空的，用户在盒子里根本看不到它。\n' +
  '请改用 project_manage 的 create_project：' +
  '{ "action": "create_project", "templateName": "TP_BlankBP", "projectName": "MyGame", ' +
  '"targetDir": "D:/Projects", "engineVersion": "5.5" }。' +
  '先用 project_list 的 list_templates 看有哪些模板（引擎自带的都在里面）。\n' +
  '要修改一个**已有**工程的 .uproject（比如启用插件），用 edit_local_file，那个不受这条限制。'

const COPY_TEMPLATE_MESSAGE =
  '这条命令在动引擎的工程模板目录。建工程不要自己拷模板 —— ' +
  '拷出来的工程不会进用户的「我的项目」、不会装 UnrealAgentLink、' +
  'EngineAssociation 是空的，依赖共享内容包的模板（第三人称、载具…）还会一打开就是丢失引用。\n' +
  '请改用 project_manage 的 create_project，它会把这些全办好：' +
  '{ "action": "create_project", "templateName": "TP_BlankBP", "projectName": "MyGame", ' +
  '"targetDir": "D:/Projects", "engineVersion": "5.5" }。\n' +
  '换一条拷贝命令（xcopy / robocopy / Copy-Item / tar）一样会被挡，不要试。' +
  '只是想看看模板里有什么，用 list_local_dir 和 read_local_file。'

/** 这个路径是不是在写一个 .uproject */
function isUprojectPath(target: string): boolean {
  return /\.uproject\s*$/i.test(target.trim())
}

/**
 * `write_local_file` 的路径检查。
 *
 * 只管 `write`（整份新建/覆盖），不管 `edit` —— 改已有工程的 .uproject 是正当需求
 * （启用插件、调 EngineAssociation），而那件事只可能用 edit 做。
 */
export function assertNotWritingUproject(target: string): string | undefined {
  return isUprojectPath(target) ? WRITE_UPROJECT_MESSAGE : undefined
}

/** 一条命令里有没有在动引擎模板目录 */
export function assertNotCopyingEngineTemplate(command: string): string | undefined {
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
