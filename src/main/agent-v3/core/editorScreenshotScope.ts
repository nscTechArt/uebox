/**
 * 「允许编辑器截图」—— 用户在「设置 → AI 助手 → 隐私」里的那个开关。
 *
 * ## 它以前是个假开关
 *
 * 这一档从来只存在渲染层：store 里有字段、界面上有开关、执行参数里也带着它，
 * 但**主进程一次都没读过**（`grep -rn editorScreenshotEnabled src/main` 零命中），
 * 而 `ue_screenshot` 登记的风险是 `safe`，连审批门都不过。也就是说用户把它关掉
 * 之后，agent 照样能把他的编辑器画面拍下来送进模型上下文 —— 一个什么都不做的
 * 隐私开关比没有开关更糟：用户以为自己关上了。
 *
 * ## 两道闸，各修各的洞
 *
 * 1. **工具池**（`resolveTools` 按 `VIEWPORT_CAPTURE_TOOLS` 摘掉）。这是主闸：
 *    模型看不见的工具不会被误调，也不占 token。同一条规矩也让系统提示词换一句话
 *    （见 `createAgent.ts`）—— 只摘工具不改提示词，模型会照着「拍一张确认一下」
 *    那句话去调一个不存在的工具。
 * 2. **拍摄路径自己再判一次**（`editorScreenshotAllowed()`）。工具对象是**进程级
 *    缓存**的（`buildAllTools` 的 cache），而这一档是每条会话自己的，所以不能把
 *    判断烧进工具实例里；而且 `/api/debug/tool` 那条调试入口直接从
 *    `buildAllTools()` 取工具执行，根本不过工具池那道闸。`ue_playtest` 也一样：
 *    它不是截图工具、不该被整个摘掉，但它默认会在结束前拍一张玩家视角的画面。
 *
 * ## 为什么跟着执行流走，而不是读设置
 *
 * 和 `agentFileAccessScope` 不同 —— 那一档存在主进程的 `appSettingsManager` 里，
 * 随时读得到。这一档存在渲染层（`store/modules/aiConfig.ts`），主进程手上没有，
 * 只能每轮随请求带下来，和 `thinkingLevel` / `skillLearning` 同一条路。
 *
 * 带下来之后必须跟着**执行流**走而不是写模块级变量，理由同
 * `projectTargetContext.ts`：两条会话可以并发，后来者会把前一个的值覆盖掉 ——
 * 而这里被覆盖掉的后果是**一条关着截图的会话真的拍了一张**。子 agent 和并发
 * 工具跑在同一条执行流的后代里，自动继承，不需要各自再传一遍。
 *
 * ## 兜底为什么是「允许」
 *
 * 三层的兜底必须同一个值（渲染层 store 的 `?? true`、IPC 的 zod、这里），
 * 否则同一个用户在不同入口下会得到不同的行为，而他一个开关都没动过。
 * 那个值是 `true`：这一档的默认状态就是开着的，读不到（老版本渲染层、无头跑、
 * 调试入口、单元测试）表示**没人说过话**，不是「用户关过」。
 *
 * 这和 `accessScope.ts` 那句「读不出来就按收窄档走」不矛盾：那边是**设置读取
 * 抛异常**的兜底，用户明明选过、只是拿不到；这里是根本没人传，把它当成用户
 * 关过的话，每一个还没接这个字段的入口都会静默失去截图能力。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 没人传这一档时按什么算。
 *
 * **改这个值要三处一起改**：`store/modules/aiConfig.ts` 的 `?? true`、
 * `core/sessionExecutionOptions.ts` 的 zod 默认、和这里。
 */
export const EDITOR_SCREENSHOT_DEFAULT = true

/**
 * 关掉这一档时要从工具池里摘掉的工具。
 *
 * 只有 `ue_screenshot` —— 它是唯一一个「拍用户眼前那块画面」的工具。
 *
 * 刻意**不包括**的两个，理由都写在这里，免得下次有人凭名字往里加：
 *
 * - `ue_playtest`：它的正事是把游戏跑起来读日志，截图只是它的一个可选参数。
 *   整个摘掉等于用一个隐私开关顺手关掉了「验证游戏能不能跑」这件事。
 *   改成**强制不截**（见 `playtest.ts`），能力留着，画面不出去。
 * - `widget_preview`：它走 `FWidgetRenderer` 把模型点名的那个 Widget 资产
 *   离屏渲染一遍，拍的不是视口、不是用户的屏幕，画面里只有他自己问的那个控件。
 *   开关的原话是「编辑器视口截图」，把它也摘掉是超出用户授权范围地收窄 ——
 *   代价是「看一眼这个 UI 布局对不对」从此做不到，而它一个像素的隐私也没泄。
 */
export const VIEWPORT_CAPTURE_TOOLS: ReadonlySet<string> = new Set(['ue_screenshot'])

const storage = new AsyncLocalStorage<boolean>()

/**
 * 在「这一轮允不允许截编辑器」的上下文里跑一段逻辑。
 *
 * 由 `ipc/agentV3.ts` 在每轮开始时套上，和目标工程、锁主、运行时作用域并列。
 */
export function runWithEditorScreenshotScope<T>(enabled: boolean, fn: () => T): T {
  return storage.run(enabled, fn)
}

/** 当前执行流允不允许拍编辑器画面。不在上下文里按默认档走，见文件头 */
export function editorScreenshotAllowed(): boolean {
  return storage.getStore() ?? EDITOR_SCREENSHOT_DEFAULT
}

/**
 * 拒绝的话必须能自解 —— 同 `tools/builtin/accessScope.ts` 的 `refusal()`。
 *
 * 少了后面那几段，模型收到的只是一次没有下文的失败：它会换个参数再试一遍、
 * 或者拿 `ue_run_python_script` 自己去截一张（那是在绕开用户明确关掉的东西），
 * 最后对用户说一句「截图失败了」—— 而用户压根不知道是自己关的。
 *
 * 所以这段话要说清楚四件事：**被挡的是什么、还能怎么办、怎么放开、
 * 以及什么时候该把这段话转达给用户**。
 */
export function editorScreenshotRefusal(attempted: string): string {
  return (
    `${attempted}被挡下了：用户把「允许编辑器截图」关掉了，这条会话里没有任何` +
    '能拍编辑器画面的工具。\n' +
    '不要换个参数再试，也不要用 ue_run_python_script、run_shell_command 或别的工具' +
    '自己去截一张 —— 那是在绕开用户明确关掉的东西。\n' +
    '换个做法：场景里有什么、摆在哪、材质连成什么样，问引擎要数据比看图准 ——' +
    'ue_get_actor、ue_get_selection、ue_content_describe、blueprint_get_graph、' +
    'material_get_graph 都照常可用。真到了非看画面不可的一步，请用户自己看一眼，' +
    '或者让他把截图发给你。\n' +
    '要放开只有一条路，**得用户自己点**：「设置 → AI 助手 → 隐私 →' +
    '允许编辑器截图」。\n' +
    '这不是故障，是用户自己设的。**要不要把上面这段告诉他，你自己判断**：' +
    '他要的就是「看一眼画面」—— 原样转达；' +
    '只是你想顺手确认一下 —— 换成回读工具，别拿这件事打扰他。'
  )
}

/**
 * 降级说明（不是拒绝）—— 给 `ue_playtest` 那种「正事照做、只是不出图」的场合。
 *
 * 和上面那段共处一个模块，是为了两处文案不会各改各的。这里刻意短：试玩可能
 * 连着调好几次，每次都贴一整段放开指引是在烧 token，而模型这次并没有被挡住。
 */
export const EDITOR_SCREENSHOT_SKIPPED_NOTE =
  '（这一次没有截图：用户把「允许编辑器截图」关掉了。' +
  '试玩本身照常跑完，结论请从 print_strings 和 errors 里读。' +
  '要看画面得由用户自己在「设置 → AI 助手 → 隐私」里打开。）'
