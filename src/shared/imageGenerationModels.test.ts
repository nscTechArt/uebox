/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import {
  findImageModelOption,
  getImageModelLabel,
  getImageModelOption,
  IMAGE_MODEL_OPTIONS
} from './imageGenerationModels'

/**
 * 生图模型的字符串同时承担线上 id 与历史记录稳定标识。
 *
 * 这一整块守的就是两者的边界。
 */
describe('生图模型的两个身份', () => {
  it('每个模型都同时给出线上 id 和稳定 key', () => {
    for (const option of IMAGE_MODEL_OPTIONS) {
      expect(option.model, `${option.label} 缺 model`).toBeTruthy()
      expect(option.key, `${option.label} 缺 key`).toBeTruthy()
    }
  })

  /** 服务商模型 id 与本地历史记录标识分开维护，避免旧别名影响新请求。 */
  it('线上 id 不是 preview 别名', () => {
    for (const option of IMAGE_MODEL_OPTIONS) {
      expect(option.model, `${option.label} 的线上 id 是 preview 别名，随时会停服`).not.toMatch(
        /-preview$/
      )
    }
  })

  /**
   * 三种标识都要认：线上 id、稳定 key、以及用过的旧标识（aliases）。
   * 历史任务里存的可能是其中任何一种 —— 只认一种的话，换过一次 id 之后
   * 旧记录就查不到了。
   */
  it('线上 id 与稳定 key 都能认出同一个模型', () => {
    for (const option of IMAGE_MODEL_OPTIONS) {
      expect(findImageModelOption(option.model)?.key).toBe(option.key)
      expect(findImageModelOption(option.key)?.key).toBe(option.key)
      for (const alias of option.aliases ?? []) {
        expect(findImageModelOption(alias)?.key, `别名「${alias}」认不出来`).toBe(option.key)
      }
    }
  })

  /**
   * findImageModelOption 如实回答「认不认识」，getImageModelOption 负责界面兜底。
   */
  it('不认识的模型：find 返回 undefined，get 才回落到第一项', () => {
    expect(findImageModelOption('doubao-seedream-4-5-251128')).toBeUndefined()
    expect(findImageModelOption(null)).toBeUndefined()
    expect(getImageModelOption('doubao-seedream-4-5-251128')).toBe(IMAGE_MODEL_OPTIONS[0])
  })

  /**
   * 名字这一项**不能**跟着 get 一起兜底。
   *
   * 社区版用户绑的是自己配的生图模型，而进度条上写的是「正在使用 X 生成图片」——
   * 回落到列表第一项的话，那句话会说成 GPT Image 2，可它压根没参与这次生成。
   */
  it('不认识的模型如实显示模型 id，而不是说成 GPT Image 2', () => {
    expect(getImageModelLabel('doubao-seedream-5-0-260128')).toBe('doubao-seedream-5-0-260128')
    expect(getImageModelLabel('')).toBe(IMAGE_MODEL_OPTIONS[0].label)
    expect(getImageModelLabel(null)).toBe(IMAGE_MODEL_OPTIONS[0].label)
  })
})
