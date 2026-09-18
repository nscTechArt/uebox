import { bindingSeesImages, findVisionCapableRole } from '../../shared/aiProvider'
import { readSettings } from './store'
import {
  LEVEL_TO_ROLE,
  ROLE_FALLBACK,
  type AiProviderSettings,
  type ModelBinding,
  type ModelRequest,
  type ModelRole
} from './types'

/**
 * 角色解析。
 *
 * 「这次调用该用哪个角色的模型」全应用只有这一份判断：调用方说 chat / agent /
 * 轻量任务，带没带图，最终落到哪个绑定上。**它不碰 HTTP，也不造模型** ——
 * 造模型是 pi 的事（见 piCompletion / streamFn），这里只回答「用谁」。
 *
 * 上一版这个文件还负责构造 AI SDK 的 LanguageModel。那套推理运行时已经整个
 * 下线，与之配套的「把 pi 模型包成 AI SDK 模型」的桥也一并删掉了。
 */

export class ModelNotConfiguredError extends Error {
  constructor(
    message: string,
    readonly role: ModelRole
  ) {
    super(message)
    this.name = 'ModelNotConfiguredError'
  }
}

/**
 * 这次请求本来该用哪个角色 —— 只看调用方说了什么，不管带没带图。
 *
 * 带图那一步要查用户配了什么模型，所以单独一个函数（`resolveRoleForRequest`）。
 */
export function resolveRole(request: ModelRequest): ModelRole {
  if (request.role) return request.role
  if (request.level) return LEVEL_TO_ROLE[request.level]
  return 'chat'
}

/**
 * 算上「这一轮带了图」之后，最终该用哪个角色。
 *
 * **主模型看得懂图就用主模型。** 现在的旗舰模型基本都能读图，为了一张截图
 * 把整轮对话换成另一个模型是赔本买卖 —— 工具调用能力、上下文、思考档位全跟着变，
 * 而用户明明是挑着这个模型来干这件事的。只有主模型是纯文本模型时，才轮到
 * 「视觉」角色接手；「视觉」也没绑，就在其余已绑角色里找一个看得懂图的。
 *
 * 一个都找不到才落到 vision 上报错 —— 直接把图喂给纯文本模型的话，pi 会按模型
 * 声明的输入模态把图片替换成一句占位符，模型照着占位符回答「我看不到图片」，
 * 用户在界面上却明明看到图发出去了。宁可报错，也不要这种静默降级。
 */
export function resolveRoleForRequest(
  settings: AiProviderSettings,
  request: ModelRequest
): ModelRole {
  const base = resolveRole(request)
  // 显式点名 vision 的调用（截图分析、参考图改写）本身就是「来看图的」
  if (!request.hasImages && base !== 'vision') return base

  const found = findBinding(settings, base)
  if (found && (base === 'vision' || bindingSeesImages(settings, found.binding))) return base

  const fallback = findVisionCapableRole(settings)
  if (fallback) return fallback

  // 谁都看不了图：主模型绑过就报「缺视觉兜底」，一个模型都没绑就报「还没配模型」
  return found ? 'vision' : base
}

/**
 * 按回落链找一个可用绑定。
 *
 * 用户只配了一个 chat 模型也应该能把整个应用跑起来，而不是每个功能
 * 各弹一次「未配置」。
 */
export function findBinding(
  settings: AiProviderSettings,
  role: ModelRole
): { binding: ModelBinding; usedRole: ModelRole } | null {
  for (const candidate of ROLE_FALLBACK[role]) {
    const binding = settings.roles[candidate]
    if (binding) return { binding, usedRole: candidate }
  }
  return null
}

/** 缺配时给用户的那句话。V3 的 streamFn 也用它，两条路径的说法必须一致 */
export function describeMissingRole(role: ModelRole): string {
  if (role === 'vision') {
    return '当前模型无法识图。请到 设置 → 模型 选择支持图片的对话或视觉模型。'
  }
  return '还没有可用的 AI 模型。请到 设置 → 模型 添加服务商，并选择默认模型。'
}

/** 本地是否已经配得出模型。界面据此显示「AI 未配置」引导 */
export async function isLocalModelConfigured(): Promise<boolean> {
  const settings = await readSettings()
  return findBinding(settings, 'chat') !== null
}
