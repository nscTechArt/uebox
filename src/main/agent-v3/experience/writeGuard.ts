/**
 * 干活的 agent 不能写经验目录。
 *
 * ## 为什么
 *
 * 经验只能由整理员从引擎的客观结果里提炼（`curator.ts`）。要是模型自己能写，
 * 一句聊天、一段抓来的网页就能往经验库里塞一条「以后都这么做」—— 那就是
 * 记忆投毒，也就回到了旧长期记忆「垃圾太多」的老路。读是放开的：模型想翻看
 * 本工程学过什么，没有理由拦。
 *
 * ## 挡得住什么
 *
 * 和 `pathBoundary` 一样是特征匹配，不是沙箱：只管 write / edit 这两个参数里明写路径的工具。
 * shell 和引擎里的 Python 照样能写到那里 —— 那两条路本来就由审批门兜底，而且模型
 * 没有绕过这道检查的动机（它被告知的是「这里由盒子维护」，不是「这里有宝贝」）。
 */

const EXPERIENCE_SEGMENT = /[\\/]\.uebox[\\/]experience([\\/]|$)/i

export function assertNotWritingExperience(path: string): string | undefined {
  if (!EXPERIENCE_SEGMENT.test(path)) return undefined
  return (
    '`.uebox/experience/` 由盒子根据引擎的真实结果自动维护，agent 不能直接写。' +
    '这次学到的东西不用你记：这一轮结束后会自动整理。要沉淀一套做法，写成技能（.uebox/skills）。'
  )
}
