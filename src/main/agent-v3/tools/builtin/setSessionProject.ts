/**
 * `set_session_project` —— 把这条对话改挂到另一个工程下。
 *
 * ## 为什么模型需要这个能力
 *
 * 会话的工程归属决定两件事：侧边栏里它归在哪一组，以及**引擎命令只许发给
 * 那个工程**（「项目对项目」，见 `core/sessionScope.ts`）。第二条是条硬边界，
 * 它挡住的是真实事故：一条挂在 A 下面的对话，模型顺手把 B 的关卡改了。
 *
 * 但它也挡住了一件完全合理的事。真机上的那一幕：用户在一条挂在旧工程下的对话里
 * 说「建个新工程做荷塘」，模型把工程建好、打开、连上 —— 然后停下来，因为
 * 这条会话归属的还是旧工程。它只能请用户去界面上改归属，或者另开一条对话。
 * 用户什么信息都补不了，那一步纯粹是盒子把自己锁住了。
 *
 * 所以边界保留，但**给模型一把明确的钥匙**：要换工程就说出来，说了就换。
 * 差别不在于能不能换，而在于换这件事是不是显式的、留了痕的 —— 静默改发到别的
 * 工程上仍然禁止，那才是当初要挡的东西。
 *
 * ## 换完为什么当场就能干活
 *
 * 三处一起改，缺一处模型就会「改了归属却动不了新工程」：
 *
 *   1. **归属表**（`setSessionBinding`）—— 唯一的主人。紧接着的 `retargetToProject()`
 *      去表里比对，不改的话模型刚点名的工程会被当成越界挡掉。
 *   2. **这一轮的目标连接**（`retargetToProject`）—— 新工程已经连着时当场切过去，
 *      不用再等下一轮。
 *   3. **渲染层那份归属**（`onChange` → IPC）—— 侧边栏分组和顶栏胶囊跟着变，
 *      而且下一轮渲染层传下来的戳就是新的了。不发这一条的话，换只在这一轮算数。
 */

import { z } from 'zod'
import path from 'path'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import { SET_SESSION_PROJECT_RISK, SET_SESSION_PROJECT_TOOL_NAME } from '../toolNames'
import { retargetToProject } from '../../core/projectTargetContext'
import { projectPathKey } from '../../core/projectPathKey'
import { setSessionBinding } from '../../core/sessionBinding'

/** 一个工程在盒子眼里的样子。项目库里的记录和已连接的工程都能凑出这几样 */
export interface SessionProjectCandidate {
  projectName: string
  projectPath?: string
  engineVersion?: string
  /** 此刻有交互式编辑器连着 */
  connected?: boolean
}

export interface SetSessionProjectDeps {
  sessionId: string
  /** 盒子知道的所有工程：项目库里登记过的 + 此刻连着的 */
  listProjects: () => SessionProjectCandidate[]
  /** 把新归属送到渲染层。`null` = 解除归属 */
  onChange: (project: SessionProjectCandidate | null) => void
}

const input = z.object({
  projectName: z
    .string()
    .optional()
    .describe(
      '要挂到哪个工程下。工程名或工程路径都认（用 project_list 的 list_projects 查）。' +
        '省略并且 clear 为 true 时解除归属'
    ),
  clear: z
    .boolean()
    .optional()
    .describe('解除归属，让这条对话变回不属于任何工程（跟着当前打开的工程走）'),
  reason: z
    .string()
    .describe(
      '为什么要换。一句话，会显示给用户看 —— 改归属会动侧边栏的分组，' +
        '用户有权知道是谁、为什么动的'
    )
})

const DESCRIPTION = `把**当前这条对话**改挂到另一个 UE 工程下。

【什么时候该用】
- 你在这条对话里新建了一个工程，接下来的活都在新工程里干 —— 直接换过去，
  不要请用户去界面上改
- 用户明说「接下来在 XXX 工程里做」，而这条对话现在挂在别的工程下
- open_project 回了 session-scoped（会话归属挡住了切换），而用户要的确实是新工程

【什么时候不该用】
- 只是想读一眼别的工程 —— 那不需要换归属，也换不来：引擎命令本来就只发给归属工程
- 用户没表达过要换。归属会改变侧边栏里这条对话的位置，那是用户的组织方式，
  换之前得有依据。拿不准就用 ask_user 问一句，别自己替他决定

【换完会怎样】
- 侧边栏分组、顶栏工程胶囊当场就变
- 新工程已经开着的话，这一轮剩下的引擎命令立刻改发给它，不用等下一条消息
- 新工程没开着的话，这条对话这一轮就没有引擎能力了（引擎工具是按归属工程给的）——
  所以要在新工程里干活，先 open_project 把它打开`

export function createSetSessionProjectTool(
  deps: SetSessionProjectDeps
): UnrealAgentTool<{ projectName?: string; connected?: boolean; switchedTarget?: boolean }> {
  return defineTool({
    // 名字从 `toolNames.ts` 来：注册表要拿同一份去补 `allToolNames()` 和风险表，
    // 两边各写一个字符串迟早写岔
    name: SET_SESSION_PROJECT_TOOL_NAME,
    namespace: 'host',
    description: DESCRIPTION,
    input,
    /*
     * 不是 safe。
     *
     * 它不碰引擎、不碰磁盘，但它改的是**用户的组织方式**（侧边栏里这条对话在哪
     * 一组），而且顺带改掉后续引擎命令的去向。默认的 auto-edit 档位会放行，
     * 「每步都问」的档位会弹一次确认 —— 那正合适：想细看的人看得见，
     * 把档位放开的人不会被打扰。
     */
    risk: SET_SESSION_PROJECT_RISK,
    concurrency: 'sequential',
    execute: async (args) => {
      const wanted = String(args.projectName ?? '').trim()

      // 先看解除。判据用**修剪过**的 wanted，不是原始字段：
      // `{ clear: true, projectName: '  ' }` 按原始字段判会掉进下面的报错分支，
      // 回一句「要给 clear: true」—— 而调用方给的正是 clear: true
      if (!wanted) {
        if (!args.clear) {
          return {
            text: '要么给 projectName 点名一个工程，要么给 clear: true 解除归属。',
            isError: true
          }
        }
        setSessionBinding(deps.sessionId, null)
        deps.onChange(null)
        return {
          text: `已解除这条对话的工程归属（${args.reason}）。之后它跟着当前打开的工程走。`,
          details: {}
        }
      }

      const projects = deps.listProjects()
      const match = matchProject(projects, wanted)
      if (!match) {
        const known = projects.map((item) => item.projectName).filter(Boolean)
        return {
          text:
            `盒子里没有叫 "${wanted}" 的工程。` +
            (known.length > 0
              ? `已知的有：${known.slice(0, 12).join('、')}${known.length > 12 ? ' 等' : ''}。`
              : '项目库是空的 —— 先用 project_manage 的 create_project 建一个，或让用户在首页导入。') +
            '用 project_list 的 list_projects 拿准确的名字。',
          isError: true
        }
      }

      /*
       * 路径说不出来就不许改。
       *
       * 以前这里把 `match.projectPath` 直接往下传，而下游把
       * `undefined` 读成「解除归属」—— 于是「挂到一个库里没记路径的工程」被执行成
       * 「把跨工程那道闸关掉」，这一轮剩下的时间里模型开哪个工程都不再被拦，
       * 而它刚刚还告诉用户对话已经挂到那个工程下了。宁可让模型拿一句错。
       */
      if (!match.projectPath) {
        return {
          text:
            `项目库里「${match.projectName}」这条记录没有工程路径，改不了归属 ——` +
            '没有路径就没法保证后面的引擎命令只落在这个工程上。' +
            '让用户在首页重新导入一次这个工程，或者用 projectPath 直接点名它的目录。',
          isError: true
        }
      }

      /*
       * **先写表，再通知。**
       *
       * 归属只有一个主人（`core/sessionBinding.ts`）。写完表，紧接着的
       * `retargetToProject()` 才不会拿旧归属把模型刚点名的工程当成越界挡掉；
       * `onChange` 只是让渲染层和执行记录跟上，不是第二个权威。
       */
      // `engineVersion` 一起写进去：`onChange` 把它发给渲染层、胶囊上渲出来了，
      // 表里丢掉的话 `<environment>` 里没有引擎版本而界面上写着 5.5，模型只能猜
      setSessionBinding(deps.sessionId, {
        projectName: match.projectName,
        projectPath: match.projectPath,
        ...(match.engineVersion ? { engineVersion: match.engineVersion } : {})
      })
      deps.onChange(match)

      // 新工程已经连着就当场切过去 —— 不切的话模型改完归属还得再等一轮才能动手
      const switchedTarget = retargetToProject(match.projectPath).ok === true

      return {
        text: [
          `已把这条对话改挂到「${match.projectName}」下（${args.reason}）。`,
          switchedTarget
            ? '这一轮剩下的引擎命令已经改发给它，直接接着干。'
            : match.connected
              ? '它已经连着，下一步就能用引擎工具。'
              : '它现在没开着 —— 要在里面干活，先用 project_manage 的 open_project 打开它。',
          '侧边栏分组和顶栏的工程胶囊已经跟着变了。'
        ].join(''),
        details: {
          projectName: match.projectName,
          ...(match.connected === undefined ? {} : { connected: match.connected }),
          switchedTarget
        }
      }
    }
  }) as unknown as UnrealAgentTool<{
    projectName?: string
    connected?: boolean
    switchedTarget?: boolean
  }>
}

/**
 * 把模型给的一个说法对到具体某个工程上。
 *
 * 名字和路径都认：模型手里不一定有哪一样。**路径优先**，因为同名工程很常见
 * （复制一份改改就是另一个），而路径是唯一的 —— 认错工程比认不出来糟糕得多。
 */
export function matchProject(
  projects: SessionProjectCandidate[],
  wanted: string
): SessionProjectCandidate | undefined {
  const needle = wanted.trim()
  if (!needle) return undefined

  const wantedPath = projectPathKey(needle)
  const byPath = projects.find(
    (item) => wantedPath !== '' && projectPathKey(item.projectPath) === wantedPath
  )
  if (byPath) return byPath

  const name = needle.toLowerCase()
  return (
    projects.find((item) => item.projectName?.trim().toLowerCase() === name) ??
    // 目录名当工程名用是常见写法（`D:/Projects/MyGame` → `MyGame`）
    projects.find((item) => path.basename(item.projectPath || '').toLowerCase() === name)
  )
}
