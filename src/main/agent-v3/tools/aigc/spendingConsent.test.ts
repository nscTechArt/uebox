/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { createGenerateImageTool } from './generateImage'
import { createGenerateVideoTool } from './generateVideo'
import { createGenerate3dModelTool } from './generate3dModel'

/**
 * 三个花钱的工具共有的一条规矩：**重做要用户点头。**
 *
 * 「像不像」「好不好看」是主观的，而模型手上正好有一个花钱的重做按钮 ——
 * 尤其在 3D 那边，我们刚把厂商的预览渲染图塞进它的上下文，它从此**能形成判断**。
 * 能判断 + 能花钱 = 它会替用户做决定，而花的是用户的钱。
 *
 * 这一组守的是工具描述里那几句话。描述是纯文本，最容易在后续改动里被顺手
 * 改没了，而改没了之后**没有任何东西会报错** —— 只会在某天账单上出现三次
 * 用户没同意过的生成。
 */

const TOOLS = [
  ['generate_image', createGenerateImageTool()],
  ['generate_video', createGenerateVideoTool()],
  ['generate_3d_model', createGenerate3dModelTool()]
] as const

const descriptionOf = (tool: (typeof TOOLS)[number][1]): string =>
  (tool as unknown as { description: string }).description

describe('花钱的工具都必须把重做的决定权交回用户', () => {
  it.each(TOOLS)('%s 的描述里指名要用 ask_user', (_name, tool) => {
    expect(descriptionOf(tool)).toContain('ask_user')
  })

  it.each(TOOLS)('%s 说清了「重做要花用户的钱」', (_name, tool) => {
    expect(descriptionOf(tool)).toMatch(/额度|付一次|账单|花用户的钱/)
  })

  /**
   * 光说「可以问用户」不够 —— 得明确禁止「自己决定」。
   * 模型在没有禁令时默认会把「我判断它不好」当成行动依据。
   */
  it.each([TOOLS[1], TOOLS[2]])('%s 明确禁止自己决定重做', (_name, tool) => {
    expect(descriptionOf(tool)).toMatch(/不要自己决定重做|不是自己猜一个再烧一次钱/)
  })

  /** 反过来：用户已经说了「重来」就别再问一遍，否则变成来回打断 */
  it.each([TOOLS[0], TOOLS[2]])('%s 说明用户点过头就直接做', (_name, tool) => {
    expect(descriptionOf(tool)).toMatch(/直接做/)
  })
})

describe('3D 那张预览图的边界', () => {
  const description = descriptionOf(TOOLS[2][1])

  it('说清它能判断什么', () => {
    expect(description).toContain('主体、风格、大致形状')
  })

  /** 不说清的话，模型会拿一张渲染图去替用户判断拓扑和尺寸 */
  it('说清它判断不了什么，并把那些留给用户', () => {
    expect(description).toMatch(/拓扑、面数、朝向、有没有穿模、\n?尺寸/)
    expect(description).toContain('别替他下结论')
  })
})
