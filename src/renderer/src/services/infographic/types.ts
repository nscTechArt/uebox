/**
 * 信息图生成服务类型定义
 */
import {
  type ImageAspectRatio,
  type ImageResolution
} from '../../../../shared/imageGenerationModels'

/**
 * 信息图生成状态
 */
export type InfographicStatus = 'idle' | 'collecting' | 'generating' | 'completed' | 'failed'

/**
 * 信息图状态接口
 */
export interface InfographicState {
  /** 当前状态 */
  status: InfographicStatus
  /** 生成进度 (0-100) */
  progress: number
  /** 状态消息 */
  message: string
  /** 错误信息 */
  error?: string
  /** 生成的图片数据 (base64 或 URL) */
  imageData?: string
}

/**
 * 信息图生成结果
 */
export interface InfographicResult {
  /** 标题 */
  title: string
  /** 图片数据 (base64 或 URL) */
  imageUrl: string
}

/**
 * 信息图生成配置
 */
export interface InfographicConfig {
  /** 图像分辨率：1K/2K/4K 或像素尺寸 */
  imageSize: ImageResolution
  /** 宽高比 */
  aspectRatio: ImageAspectRatio
  /** 用户在「模型」页配置的服务商；未选择时沿用全局「生图」绑定 */
  providerId?: string
  /** 用户在「模型」页配置的模型；未选择时沿用全局「生图」绑定 */
  modelId?: string
  /** 用户自定义的信息图生成 Prompt 模板；支持 {title} 与 {content} 占位符 */
  prompt?: string
}

/**
 * 默认配置
 */
export const DEFAULT_INFOGRAPHIC_CONFIG: InfographicConfig = {
  imageSize: '1536x1024',
  aspectRatio: '3:2'
}
