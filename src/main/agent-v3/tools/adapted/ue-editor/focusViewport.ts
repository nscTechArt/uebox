/**
 * 把关卡视口的镜头对准指定 Actor —— 等同于人在编辑器里选中它再按 F。
 *
 * ## 为什么参数是「看谁」而不是坐标
 *
 * 一开始想过做成 `move_camera(x, y, z, pitch, yaw)`。那个工具一定会废掉：
 * 模型算不出该站在哪儿才能把一个东西拍全，它只会猜一个数，然后拍到一片虚空
 * 或者怼在物体表面上，再猜一次。提示词救不了，这是算术问题。
 *
 * 所以接口只收「看谁」，取景（站多远、往哪看）全部交给引擎。插件端发的是
 * `CAMERA ALIGN`，最终走 `UEditorEngine::MoveViewportCamerasToActor` ——
 * 那里有一百多行专门处理包围盒的边角情况（空 Actor、粒子发射器、子 Actor
 * 容器、巨大但看不见的触发器组件），自己重写一份只会更差。
 *
 * ## region：看「树干」而不是「整棵树」
 *
 * 只有整体聚焦是不够的。实测：拍整棵树一发命中，「我要看树干」就完全对不上焦 ——
 * 包围盒聚焦只会把整棵树框进画面，树干在图里只有几个像素。调用方于是退回去
 * 手写相机坐标，连拍五六张全歪，根因是 UE Python 里 `unreal.Rotator` 的
 * **位置参数顺序是 (roll, pitch, yaw)**，按 (pitch, yaw, roll) 传会把 yaw 塞进
 * pitch 槽位 —— 镜头垂直朝下拍地面，而且**传错不报任何错**，每一步都「成功」。
 *
 * 结论不是「给相机 API 加护栏」（那是引擎的 Python 绑定，我们改不了），
 * 而是**让这一层覆盖到位，根本不必掉进 Python**。所以有了 region：
 * 按包围盒高度三等分，树干 = bottom，树冠 = top。
 *
 * ## direction 只有三个值，这是故意的
 *
 * current / horizontal / top。曾经想加 front/back/left/right/三-四侧，砍掉了：
 * 一个道具的「正面」是哪一面引擎并不知道（+X 只是约定，摆模型的人不遵守），
 * 每加一个方向就是加一个有一半概率是错的猜测。
 *
 * region 非 whole 时默认 horizontal —— 看树干、看门、看柱子，人的本能是
 * 走过去平视。上面那次翻车里，距离其实一直是对的，错的自始至终只有角度。
 *
 * ## 整体聚焦仍然只调远近不调角度
 *
 * 不带 region/direction/distance 时走引擎的 `CAMERA ALIGN`，它按**当前视口朝向**
 * 算机位。所以距离对、角度不变。要改角度就得给 direction，那会切到自己定机位那条路。
 */

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { describeCameraAim } from '../../ueOrientation'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'
import {
  describeUnmatchedTargets,
  unmatchedTargetFields,
  type UnmatchedTargetsResponse
} from '../../unmatchedTargets'

/** 插件端等相机落地最多 1.5 秒，留出往返余量 */
const FOCUS_TIMEOUT_MS = 15_000

const FocusViewportSchema = z
  .object({
    names: z
      .array(z.string())
      .optional()
      .describe(
        '要看的 Actor，用**大纲里显示的名字**。给多个就把它们一起框进画面。' +
          '和 selection 至少给一个'
      ),
    selection: z
      .boolean()
      .optional()
      .describe('true = 看用户此刻在视口/大纲里选中的东西，不用报名字'),
    region: z
      .enum(['whole', 'top', 'middle', 'bottom'])
      .optional()
      .describe(
        '看整个物体还是只看它的某一截（按包围盒高度三等分）。默认 whole。' +
          '**要看树干、看柱子、看底座就用 bottom**；看树冠、看屋顶用 top。' +
          '不用 bottom 的话镜头只会把整棵树框进画面，树干在图里只有几个像素'
      ),
    direction: z
      .enum(['current', 'horizontal', 'top'])
      .optional()
      .describe(
        '相机往哪个方向看。current = 保持视口现在的朝向（只调远近）；' +
          'horizontal = 水平平视，俯仰归零；top = 从正上方俯视。' +
          'region 不是 whole 时默认 horizontal —— 看物体的某一截，人的本能是走过去平视。' +
          '**没有 front/left/right**：一个道具的「正面」是哪一面引擎并不知道'
      ),
    distance: z
      .number()
      .positive()
      .optional()
      .describe(
        '相机离目标多远（虚幻单位，1 = 1 厘米）。留空自动按目标尺寸算，' +
          '一般不用给。嫌太远/太近时再手动指定'
      ),
    all_viewports: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        '默认 false，只动当前活动的那个视口。设为 true 会把**所有**视口都挪走 ——' +
          '用户开着四视图时四个全被抢，一般不要'
      )
  })
  .refine(
    (v) => Boolean(v.selection || (v.names && v.names.length > 0)),
    '至少给 names 或 selection 之一'
  )

interface FocusViewportResponse extends UnmatchedTargetsResponse {
  ok?: boolean
  success?: boolean
  error?: string
  message?: string
  focused?: string[]
  camera?: {
    location?: { x?: number; y?: number; z?: number }
    rotation?: { pitch?: number; yaw?: number; roll?: number }
    fov?: number
  }
  moved?: boolean
  transition_settled?: boolean
  is_perspective?: boolean
  is_active_viewport?: boolean
  all_viewports?: boolean
  distance?: number
  region?: string
  target_radius?: number
  target_center?: { x?: number; y?: number; z?: number }
  /** 目标的包围盒。附在聚焦结果里，省得再单独调 actor 查询和 mesh 描述两趟 */
  bounds?: {
    center?: { x?: number; y?: number; z?: number }
    extent?: { x?: number; y?: number; z?: number }
    min?: { x?: number; y?: number; z?: number }
    max?: { x?: number; y?: number; z?: number }
    radius?: number
    height?: number
  }
  /** 朝向自检：相机正前方到底有没有对着瞄准点 */
  aim?: {
    point?: { x?: number; y?: number; z?: number }
    error_degrees?: number
    on_target?: boolean
  }
  occluded_by?: string
  occluded_by_self?: boolean
  hidden_in_editor?: string[]
  skipped_hidden_levels?: string[]
}

/**
 * 相机离目标多远算「不对劲」。
 *
 * 包围盒炸掉时（Landscape、挂了远处组件的蓝图）算出来的机位在几公里外，
 * 拍回来是一片灰。50 米是个粗线：正常聚焦一件家具在几米内，聚焦一栋楼
 * 也就几十米。超了不报错 —— 大场景聚焦本来就该远 —— 但要提醒一句，
 * 否则调用方会拿着一张空图去改别的东西。
 */
const SUSPICIOUS_DISTANCE = 5000

/** 把插件返回的东西拼成一句人和模型都能直接用的话 */
export function summarizeFocus(response: FocusViewportResponse): string {
  const parts: string[] = []
  const names = response.focused ?? []
  const regionLabel =
    response.region && response.region !== 'whole'
      ? ({ top: '的上部', middle: '的中段', bottom: '的下部' }[response.region] ?? '')
      : ''
  parts.push(names.length > 0 ? `镜头已对准 ${names.join('、')}${regionLabel}` : '镜头已移动')

  // 镜头此刻朝哪，用人话说一遍。真机上参考机位被改成仰视 33.6° 后截回一片蓝天，
  // 模型以为场景没了 —— 三个裸角度看不出「仰视」，这一句看得出
  const aim = describeCameraAim(response.camera?.rotation)
  if (aim) parts.push(aim)

  // 朝向自检 —— 这条是真机翻车的直接对策：当时相机位置设对了、回读也一致，
  // 唯独旋转错得离谱（镜头垂直朝下拍地面），而所有中间步骤都「成功」了
  if (response.aim?.on_target === false) {
    const err = response.aim.error_degrees
    parts.push(
      `⚠️ 但相机并没有朝着目标${typeof err === 'number' ? `（偏了 ${Math.round(err)} 度）` : ''}，` +
        '这张图多半拍不到你要的东西'
    )
  }
  if (response.occluded_by) {
    parts.push(
      response.occluded_by_self
        ? `⚠️ 视线被目标自己挡住了（${response.occluded_by} 的其他部分），换个角度或用 region 再试`
        : `⚠️ 视线被 ${response.occluded_by} 挡住了`
    )
  }
  if (response.moved === false) {
    parts.push('但相机位置没变 —— 可能本来就在这个位置，也可能当前不是关卡视口')
  }
  if (response.transition_settled === false) {
    // 不说「失败」：5.8 上目标含被 Deformer 变形的骨骼网格时，聚焦要先等
    // 一次异步 GPU 回读，那是「还没到」不是「没成功」
    parts.push('相机还在移动中（没等到停稳），这时候截图可能拍到半路的画面')
  }
  if (response.is_perspective === false) {
    parts.push('当前是正交视口（顶视/侧视那种），不是透视视角')
  }
  if (response.is_active_viewport === false) {
    parts.push('注意：编辑器没有活动的关卡视口，动的是找到的第一个')
  }
  if (typeof response.distance === 'number' && response.distance > SUSPICIOUS_DISTANCE) {
    parts.push(
      `相机离目标 ${Math.round(response.distance)} 单位，偏远 —— ` +
        '目标包围盒可能被巨大组件撑开了（Landscape、远处的触发器），画面里也许看不清东西'
    )
  }
  if (response.hidden_in_editor && response.hidden_in_editor.length > 0) {
    parts.push(
      `⚠️ ${response.hidden_in_editor.join('、')} 在编辑器里是隐藏的 —— ` +
        '镜头对过去了，但画面上什么也看不见'
    )
  }
  if (response.skipped_hidden_levels && response.skipped_hidden_levels.length > 0) {
    parts.push(`${response.skipped_hidden_levels.join('、')} 在隐藏的关卡里，已跳过`)
  }
  // 点名 7 个只对上 6 个：以前 focused 里就少一条，别的什么都没说。
  // 这时候截的图里少一个东西，而调用方会当成「都框进去了」
  const unmatched = describeUnmatchedTargets(response).trim()
  if (unmatched) parts.push(unmatched)
  return parts.join('。')
}

export function createFocusViewportTool(): V2Tool {
  return defineV2Tool({
    description: `把关卡视口的镜头对准指定的 Actor —— 等同于在编辑器里选中它再按 F。

【什么时候用】：
- 用户说「带我去看看那个东西」「这个在哪」
- 改完某个 Actor 想让用户直接看到结果
- **截图之前**先把要看的东西框进画面，再调 ue_screenshot ——
  截图拍的是镜头当前对着的地方，不先对准很可能拍回来一张画面里没有目标的图

【⚠️ 这会动用户的画面】用户的镜头会飞过去，他正在看的地方就没了。
只在确实要给人看、或者确实要截图核对时才用，不要顺手调。

【要看物体的某一截，用 region】只给 names 会把**整个**物体框进画面 ——
想看一棵树的树干，整棵树塞满画面时树干只有几个像素。这时候：

    names: ["SM_OakTree2"], region: "bottom"

树干 / 柱子 / 底座 = bottom，树冠 / 屋顶 = top，箱体中段 = middle。
region 不是 whole 时相机会自动**水平平视**（不再沿用视口原来的俯角），
因为看物体的某一截，人的本能就是走过去平视。

不要自己去算相机坐标再用 Python 摆位 —— 那条路上 unreal.Rotator 的位置参数
顺序是 (roll, pitch, yaw)，传错**不报任何错**，只会静默给你一个朝下的镜头。

【⚠️ 这会动用户的画面】用户的镜头会飞过去，他正在看的地方就没了。
只在确实要给人看、或者确实要截图核对时才用，不要顺手调。

【⚠️ 会改变用户的选中状态】实现上要先选中目标才能聚焦，跟人点一下再按 F 一样。

【参数】：
- names: 要看的 Actor，用**大纲里显示的名字**（不是类名、不是资产路径）
- selection: true = 看用户此刻选中的东西
- region: whole（默认）/ top / middle / bottom，按包围盒高度三等分
- direction: current（默认）/ horizontal（平视）/ top（俯视）。
  region 不是 whole 时默认 horizontal。**没有 front/left/right** ——
  一个道具的「正面」是哪一面引擎并不知道
- distance: 相机离目标多远，留空自动算
- all_viewports: 默认 false 只动当前视口；true 会把所有视口都挪走

【返回 —— 截图之前先看这几个】：
- aim.on_target: **相机到底有没有朝着目标**。false 就别截图了，先换个参数
- occluded_by: 视线被谁挡住了。occluded_by_self=true 表示被目标自己挡住
  （树冠裹住树干就是这种）。⚠️ 没报遮挡不等于看得见 —— 植被常常没有碰撞体，
  射线直接穿过去
- bounds: 目标的包围盒 center/extent/min/max/height。想自己规划机位、
  或者判断「树冠是不是又宽又低」，直接用这个，不用再单独调查询工具
- focused / camera / moved / distance / region
- hidden_in_editor: 这些目标在编辑器里是隐藏的，镜头对过去了但看不见`,

    inputSchema: FocusViewportSchema,

    execute: async (input) => {
      try {
        const wsService = serviceManager.getWebSocketService()
        if (wsService.getConnectionCount() === 0) {
          return {
            success: false,
            error: UE_NOT_CONNECTED_MESSAGE
          }
        }

        const targets: Record<string, unknown> = {}
        if (input.names && input.names.length > 0) targets.names = input.names
        if (input.selection) targets.selection = true

        // region/direction/distance 不给就不传 —— 插件端会据此选走引擎的
        // CAMERA ALIGN（白拿它的包围盒智能）还是自己定机位。在这边塞默认值
        // 等于把「该走哪条路」的判断分散到两处
        const params: Record<string, unknown> = {
          targets,
          all_viewports: input.all_viewports ?? false
        }
        if (input.region) params.region = input.region
        if (input.direction) params.direction = input.direction
        if (input.distance) params.distance = input.distance

        const response = await wsService.callRequest<FocusViewportResponse>(
          'viewport.focus',
          params,
          getTargetConnectionId(),
          FOCUS_TIMEOUT_MS
        )

        if (!response) {
          return { success: false, error: '服务未返回有效数据' }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = response as any
        if (raw?.ok === false || raw?.success === false) {
          return {
            success: false,
            error: `聚焦失败：${raw?.error || raw?.message || '未知原因'}`,
            code: raw?.__rpc?.code ?? raw?.code,
            details: raw?.details
          }
        }

        return {
          success: true,
          focused: response.focused ?? [],
          camera: response.camera,
          moved: response.moved,
          transition_settled: response.transition_settled,
          is_perspective: response.is_perspective,
          distance: response.distance,
          region: response.region,
          bounds: response.bounds,
          aim: response.aim,
          occluded_by: response.occluded_by,
          occluded_by_self: response.occluded_by_self,
          hidden_in_editor: response.hidden_in_editor,
          skipped_hidden_levels: response.skipped_hidden_levels,
          ...unmatchedTargetFields(response),
          message: summarizeFocus(response)
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
