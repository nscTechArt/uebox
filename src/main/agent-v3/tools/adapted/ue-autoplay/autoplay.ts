/**
 * `ue_autoplay` —— 自主试玩机器人。
 *
 * 把游戏跑起来（复用 `pie.run` 的整套会话：日志捕获、收尾截图、关卡组成），
 * 在它跑着的那段时间里由盒子这一侧的决策循环（`runner.ts`）边看边操作，
 * 最后把机器人的发现和 `pie.run` 的报告合成一份。
 *
 * 与 `ue_playtest` 的分工：playtest 只跑「自己会跑的东西」（BeginPlay、Tick、定时器），
 * 碰不到要按键才触发的逻辑；这个工具补上那一半 —— 它会走、会跳、会按遍输入、会点菜单。
 */

import { app } from 'electron'
import { join } from 'path'
import { z } from 'zod'

import { defineV2Tool } from '../../adaptV2Tool'
import { serviceManager } from '../../../../services'
import { getTargetConnectionId } from '../../../core/projectTargetContext'
import {
  editorScreenshotAllowed,
  EDITOR_SCREENSHOT_SKIPPED_NOTE
} from '../../../core/editorScreenshotScope'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import { readScreenshotImage } from '../ue-editor/screenshot'
import { withPieBusyHint } from '../ue-editor/playtest'
import { createJudgeBrain, createJudgeNavigator, type AskJudgeRaw } from './controller'
import { rulePolicy } from './policy'
import { createBotRpc, waitForPlay } from './rpc'
import { runAutoplay, type AutoplayOptions, type AutoplayResult } from './runner'
import { summarizeAutoplay } from './summary'
import { createFileTrace } from './trace'
import type { PieRunReport } from './types'

const Vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() })

const AutoplaySchema = z.object({
  mode: z
    .enum(['explore', 'goal', 'objective'])
    .optional()
    .describe(
      'explore = 没有目标，自己到处走、把输入按一遍，找卡住/掉出世界/报错；' +
        'goal = 按 goal 里写死的步骤走（到哪、按什么）；' +
        'objective = 给一句自然语言目标，每一步由判定模型决定做什么。' +
        '给了 objective 默认就是 objective，给了 goal 默认就是 goal'
    ),
  objective: z
    .string()
    .optional()
    .describe(
      '一句话目标，比如「找到钥匙，然后用它把门打开」「拉下拉杆，穿过闸门走到出口」。' +
        '机器人每一步看周围有什么（八个方向的障碍、附近有名字的 Actor），在合法动作里选一个。' +
        '想要确证就同时给 goal.until_log（那是断言；目标完成与否的「判断」不是断言）'
    ),
  goal: z
    .object({
      reach_actor: z.string().optional().describe('走到这个 Actor 附近（大纲里的名字）'),
      reach_location: Vec3Schema.optional().describe('或者走到这个坐标附近'),
      reach_radius: z.number().optional().describe('多近算到了，默认 150（1.5 米）'),
      press: z
        .string()
        .optional()
        .describe(
          '到了之后按一次这个输入：动作名（IA_Interact）或按键名（E）。没有 reach 就是开局就按'
        ),
      until_log: z
        .string()
        .optional()
        .describe('等到出现包含这段文字的 PrintString 才算达成。只给这一项时机器人一边探索一边等')
    })
    .optional(),
  duration_seconds: z
    .number()
    .min(5)
    .max(60)
    .optional()
    .describe('最多跑多久，默认 30，上限 60。目标提前达成会提前停'),
  step_frames: z
    .number()
    .int()
    .min(4)
    .max(60)
    .optional()
    .describe('每一步按住多少帧，默认 12（固定 60fps 下 0.2 秒）。关卡很大时可以调大'),
  screenshot: z.boolean().optional().describe('结束时截一张玩家视角，默认 true')
})

/** 这个工程的试玩一次都没真跑起来之前，最多等它多久（大关卡加载、编着色器） */
const START_TIMEOUT_MS = 40_000

/** 固定步长：失焦节流时同样的帧数才是同样长的游戏时间（设计稿 §11.1、0d） */
const FIXED_FPS = 60

function traceDir(): string {
  return join(app.getPath('userData'), 'autoplay-traces')
}

export function createAutoplayTool(): ReturnType<typeof defineV2Tool> {
  return defineV2Tool({
    description: `【实验性】自主试玩：把游戏跑起来，让机器人自己操作，回一份「它碰到了什么」。

**实验性功能**：平地、导航网格走得到的目标比较可靠；要跳台阶、爬楼、跨沟才能到的地方经常到不了，报告里「没走到」先怀疑地形，不要直接判定游戏逻辑有问题。结果要向用户说明来自实验性工具。

\`ue_playtest\` 只能跑游戏自己会跑的逻辑，**碰不到要按键才触发的部分**；这个工具补上那一半 ——
它会自己找出哪个输入是移动、哪个是跳，然后走、跳、把每个输入动作按一遍、遇到菜单会点。

## 两种用法

**探索（explore）** —— 做完关卡或玩法后的冒烟测试：

    {}                                   // 默认探索 30 秒
    { duration_seconds: 60 }

找的是：**卡住的位置、掉出世界、角色没了、按了某个输入就报错、按了没反应的输入**。
每个问题带坐标和「出事前最后一个动作」。

**一句话目标（objective）** —— 不用写死步骤，让判定模型一步一步决定：

    { objective: "找到钥匙，然后用它把门打开", goal: { until_log: "DoorOpened" } }
    { objective: "拉下拉杆，穿过闸门走到出口" }

每一步由代码算出此刻能做的动作（走向某个方向、走到附近某个 Actor、按某个输入、点某个按钮），
判定模型从里面挑一个。它看得见周围八个方向的障碍和附近有名字的 Actor，看不见画面 ——
**Actor 名字起得有意义时效果最好**（BP_Key、BP_Door）；满屏 BP_Actor_12 它也只能乱猜。
没配判定模型时这个模式会直接拒绝（去设置里把 TypeSafe Jev 设为「判定」角色）。目标完成与否它会给一个判断，**那不是断言**，要确证就配 until_log。

**写死步骤（goal）** —— 验证一条具体的流程走得通：

    { goal: { reach_actor: "BP_Door", press: "IA_Interact", until_log: "DoorOpened" } }
    { goal: { reach_actor: "Checkpoint_2" } }
    { goal: { until_log: "LevelComplete" } }   // 一边探索一边等这句出现

达成会提前停。**until_log 是这里唯一的断言** —— 想证明某段逻辑真的执行了，
就在那段逻辑里放 PrintString，再把那句写进 until_log。

## 必须如实转述给用户的限制

- **移动和按键绕开了键位映射**：按键走动作层注入；长距离行走直接给角色加移动输入，连游戏自己的移动蓝图也绕过了。
  机器人走得到不等于玩家按 W 走得到。验键位用 ue_inject_input 的 key。
- **立体地形还不可靠**：要连续跳台阶、爬楼、跨沟的路线经常规划不出来或走到一半卡住。
- **点菜单是直接触发 OnClicked，没走屏幕命中测试**：点得开不等于玩家点得到。
  名字带「删除 / 重置 / 退出 / 购买」一类的按钮一律不点，报告里会列出来。
- **探索模式没有断言**：一份没问题的探索报告只能说明「这段时间里没崩、没卡死、没掉出世界」，
  不能说某个功能正常。
- 「按了没反应」**不等于坏了**：放音效、改界面数字、在别处生成东西，机器人都看不见。
- 游戏里按下的按钮是真的：会写存档、发网络请求的逻辑会真的执行。

## 用之前

不需要先保存（PIE 跑的是编辑器内存里的当前世界）。编辑器已经在 Play 时会被拒绝，不接管别人的会话。
关卡有导航网格时先按导航网格走；走不通再用按场景碰撞算的格子路线（会带跳跃点）；都不行由判定模型选方向绕。
每个决策点都记在本机的一份 trace 文件里，路径在返回的最后一行。`,

    inputSchema: AutoplaySchema,

    execute: async (input, { abortSignal }) => {
      const wsService = serviceManager.getWebSocketService()
      if (wsService.getConnectionCount() === 0) {
        return { success: false, error: UE_NOT_CONNECTED_MESSAGE }
      }
      /*
       * objective 模式要判定模型（Jev 一类）当每一步的决策者。没配就当场拒绝，不起 PIE：
       * 规则基线在真机和假世界里都几乎做不成任何目标，拿它顶上只会产出一份误导人的报告。
       * 懒加载 judge：它拖着 ai/store，不需要让工具注册表在导入时就把它拉进来
       */
      let objectiveAsk: AskJudgeRaw | null = null
      if (input.mode === 'objective' || (!input.mode && input.objective)) {
        const { judge, judgeAvailable } = await import('../../../../ai/judge')
        if (!(await judgeAvailable())) {
          return {
            success: false,
            error:
              'objective 模式需要先配置判定模型：设置 → AI 服务 → 添加 TypeSafe（Jev）并设为「判定」角色。' +
              '没有它时可以改用 goal（写死步骤：reach_actor / press / until_log）或 explore。'
          }
        }
        objectiveAsk = async (state, questions) =>
          judge(state, questions as Parameters<typeof judge>[1], {
            timeoutMs: 4_000,
            ...(abortSignal ? { signal: abortSignal } : {})
          })
      }
      const connectionId = getTargetConnectionId()
      const call = (
        method: string,
        params: Record<string, unknown>,
        timeoutMs: number
      ): Promise<unknown> =>
        wsService.callRequest(method, params, connectionId, timeoutMs, abortSignal)
      const rpc = createBotRpc(call)

      const duration = input.duration_seconds ?? 30
      const screenshotBlocked = !editorScreenshotAllowed()
      const wantScreenshot = screenshotBlocked ? false : (input.screenshot ?? true)

      // pie.run 跑整段会话；它回来的时候就是会话结束的时候
      let report: PieRunReport | null = null
      let settled = false
      const runPromise = (
        wsService.callRequest<PieRunReport>(
          'pie.run',
          { duration_seconds: duration, screenshot: wantScreenshot, fixed_fps: FIXED_FPS },
          connectionId,
          duration * 1000 + 120_000
        ) as Promise<PieRunReport>
      )
        .then((response) => {
          report = response
          return response
        })
        .catch((error: unknown) => {
          report = { ok: false, error: error instanceof Error ? error.message : String(error) }
          return report
        })
        .finally(() => {
          settled = true
        })

      const stopPie = async (reason: string): Promise<void> => {
        if (settled) return
        try {
          await rpc.stop(reason)
        } catch {
          // 停不掉（会话刚好自己结束了）不影响报告
        }
      }

      const ready = await waitForPlay(rpc, () => settled, abortSignal, START_TIMEOUT_MS)
      if (ready === 'plugin_too_old') {
        // 老插件也没有 pie.stop，这次起的试玩只能等它自己跑满
        return {
          success: false,
          error:
            '引擎里装的 UnrealAgentLink 插件版本太旧，没有试玩机器人要用的命令（pie.observe）。' +
            `更新插件并重启编辑器后再试。这次已经起的试玩会在 ${duration} 秒内自己结束。`
        }
      }
      if (ready !== 'ready') {
        if (!settled) await stopPie('游戏没能起来')
        const final = await runPromise
        const message =
          final?.ok === false ? String(final.error ?? '试玩没能启动') : '游戏没能在 40 秒内起来'
        return {
          success: false,
          error:
            final?.ended_by === 'failed_to_start'
              ? 'PIE 没能启动。关卡可能有问题，或者编辑器正忙。'
              : withPieBusyHint(message)
        }
      }

      const goal = input.goal
      const options: AutoplayOptions = {
        mode: input.mode ?? (input.objective ? 'objective' : goal ? 'goal' : 'explore'),
        ...(input.objective ? { objective: input.objective } : {}),
        durationSeconds: duration,
        ...(input.step_frames ? { stepFrames: input.step_frames } : {}),
        ...(goal
          ? {
              goal: {
                ...(goal.reach_actor || goal.reach_location
                  ? {
                      reach: {
                        ...(goal.reach_actor ? { actor: goal.reach_actor } : {}),
                        ...(goal.reach_location ? { location: goal.reach_location } : {}),
                        ...(goal.reach_radius ? { radius: goal.reach_radius } : {})
                      }
                    }
                  : {}),
                ...(goal.press ? { press: goal.press } : {}),
                ...(goal.until_log ? { untilLog: goal.until_log } : {})
              }
            }
          : {})
      }
      if (
        options.mode === 'goal' &&
        !options.goal?.reach &&
        !options.goal?.press &&
        !options.goal?.untilLog
      ) {
        await stopPie('目标为空')
        await runPromise
        return {
          success: false,
          error:
            'mode=goal 时 goal 里至少要有 reach_actor / reach_location / press / until_log 之一'
        }
      }

      if (options.mode === 'objective' && !options.objective?.trim()) {
        await stopPie('目标为空')
        await runPromise
        return { success: false, error: 'mode=objective 时要给 objective（一句话目标）' }
      }

      /*
       * objective 模式的决策者：配了判定模型（设置 → AI → 判定）就用它，没配走规则基线。
       * 懒加载 judge：它拖着 ai/store，不需要让工具注册表在导入时就把它拉进来
       */
      if (options.mode === 'objective' && objectiveAsk) {
        options.brain = createJudgeBrain(objectiveAsk)
        // 没有导航网格、规划器也规划不出路时，往哪边摸索也交给判定模型
        options.navigator = createJudgeNavigator(objectiveAsk)
      }

      const trace = createFileTrace(traceDir())
      let result: AutoplayResult
      try {
        result = await runAutoplay(
          { rpc, policy: rulePolicy, trace, signal: abortSignal, isSessionOver: () => settled },
          options
        )
      } catch (error) {
        await stopPie('机器人出错')
        await runPromise
        await trace.close()
        return {
          success: false,
          error: `试玩机器人中途出错：${error instanceof Error ? error.message : String(error)}`,
          ...(trace.path ? { trace_path: trace.path } : {})
        }
      }

      await stopPie(result.outcome === 'goal_reached' ? '目标达成' : '机器人跑完了')
      await runPromise
      await trace.close()

      const final = report as PieRunReport | null
      const images =
        final?.screenshot_path && !screenshotBlocked
          ? await readScreenshotImage(final.screenshot_path)
          : []

      return {
        success: true,
        outcome: result.outcome,
        ...(result.goal ? { goal: result.goal } : {}),
        findings: result.findings,
        ...(result.sweep.length > 0 ? { input_sweep: result.sweep } : {}),
        ...(result.uiClicks.length > 0 ? { ui_clicks: result.uiClicks } : {}),
        ...(result.move ? { movement: result.move } : {}),
        ...(result.controller
          ? {
              controller: {
                brain: result.controller.brain,
                ticks: result.controller.ticks,
                judge_decisions: result.controller.judgeDecisions,
                actions: result.controller.actionCounts,
                ...(result.controller.lastDone !== undefined
                  ? { judged_done_probability: result.controller.lastDone }
                  : {})
              }
            }
          : {}),
        ...(final?.ok
          ? {
              ended_by: final.ended_by,
              elapsed_seconds: final.elapsed_seconds,
              print_strings: final.print_strings ?? [],
              errors: final.errors ?? [],
              error_count: final.error_count ?? 0
            }
          : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(final?.screenshot_path && !screenshotBlocked
          ? { screenshot_path: final.screenshot_path, image_paths: [final.screenshot_path] }
          : {}),
        ...(trace.path ? { trace_path: trace.path } : {}),
        summary:
          summarizeAutoplay(result, final?.ok ? final : null, trace.path) +
          (screenshotBlocked ? `\n${EDITOR_SCREENSHOT_SKIPPED_NOTE}` : '')
      }
    }
  })
}
