/**
 * UE Sequencer 工具集。
 *
 * 覆盖 UE 5.0–5.8 —— Epic 官方的 278 个 Sequencer 工具只有 5.8 才有，
 * 而今天在产的国内项目绝大多数还在 5.0–5.4。
 *
 * 设计与边界。
 *
 * ## 分工：创作归模型，领域知识归工具
 *
 * 硬边界只剩一条：**不做渲染出片**（不可逆的资源消耗，交付责任必须在人）。
 *
 * 原来还有一条「不替用户做主观创作判断」，去掉了。创作判断本来就是模型该做的事；
 * 工具和 skill 负责的是它不可能自己知道的那半边 —— 引擎会怎么反应、什么不可逆、
 * 帧边界怎么算、哪个 API 在 5.1 上叫别的名字。
 *
 * 覆盖用户已有的曲线也**不再禁止**：禁止就等于不许改用户的东西，那又变成工具
 * 替用户做主。危不危险由用户在审批环节判断，工具的责任是把代价说清楚
 * （`sequence_camera_keys` 会报出它清掉了多少个旧关键帧）。
 *
 * ## 已注册
 *
 *   - `sequence_describe`     —— 读一条序列的结构
 *   - `sequence_audit`        —— 出片前体检（五位评审一致排第一优先级）
 *   - `sequence_camera_keys`  —— 写相机关键帧，任意运镜都走这里
 *   - `sequence_camera_cuts`  —— 给已有序列补相机切轨
 *
 * `sequence_orbit` 已删除（2026-08-30）。它的参数是「转几圈、俯角多少、半径倍数」，
 * 等于把「镜头只能是圆」这个创作限制烧进工具：用户要 8 字、要手持晃、要先升后俯，
 * 模型只能拿环绕去凑。`sequence_camera_keys` 是它的替代品 —— 环绕退化成
 * 「模型自己算 24 个点」的一种用法，和别的运镜没有区别。不留兼容层。
 *
 * 未实现：变焦动画、重定时、批量换引用、变体批处理。见文档 §8 的顺序。
 * possessable 的重新绑定引擎没导出 Python 接口，只能让用户手点（见 cameraCuts.ts）。
 *
 * ## 那次崩溃
 *
 * `sequence_orbit` 在真机上崩过一次编辑器：`EXCEPTION_ACCESS_VIOLATION`，
 * 栈是 `python311 → PythonScriptPlugin → CoreUObject`，用到的 API 签名逐条比对过
 * 引擎源码全是对的，崩在哪一行至今没定位。**这个风险没有消除** ——
 * `sequence_camera_keys` 走的是同一批 API。
 *
 * 变的是代价：现在写关键帧之后、碰相机切轨之前会**先把关卡存盘**，
 * 崩了也不会带走新建的相机；真崩在切轨那步，`sequence_camera_cuts` 能单独补上。
 * 最坏情况从「丢掉工作、只能手点修」变成「重启编辑器，再跑一次」。
 *
 * 拿到那次崩溃日志之前，这段不要删。
 */

import { createSequenceAuditTool } from './audit'
import { createSequenceCameraCutsTool } from './cameraCuts'
import { createSequenceCameraKeysTool } from './cameraKeys'
import { createSequenceDescribeTool } from './describe'
import type { UnrealAgentTool } from '../defineTool'

export function sequencerTools(): UnrealAgentTool<never>[] {
  // 工具带自己的 details 类型，注册表要的是统一的 never —— 与 ue-material 同一处理
  return [
    createSequenceDescribeTool(),
    createSequenceAuditTool(),
    createSequenceCameraKeysTool(),
    createSequenceCameraCutsTool()
  ] as unknown as UnrealAgentTool<never>[]
}

export { createSequenceAuditTool } from './audit'
export { createSequenceCameraCutsTool } from './cameraCuts'
export { createSequenceCameraKeysTool } from './cameraKeys'
export { createSequenceDescribeTool } from './describe'
export * from './findings'
