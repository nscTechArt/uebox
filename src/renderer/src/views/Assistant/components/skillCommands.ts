import type { AgentV3SkillSummary } from '@/api/agentV3'

/**
 * 自带界面的命令 —— 打全了就把面板让给它们。
 *
 * 只有 `/wiki`：它一打全就弹自己的知识库选择层（见 `InputComposer.vue` 的
 * `isWikiCommand`），两个浮层同时开会打架。**没打全的时候不在这里拦** ——
 * `/wik` 仍然要能在面板里搜到 `/wiki`，那正是这次要补的发现路径。
 *
 * 这里原来是一份 29 个词的表，装着 V2 Router 时代的命令（`/router`、`/direct`、
 * `/blueprint` …）。那批命令随扁平单 agent 一起下线了，留着的唯一效果是让这些词
 * 既不触发命令、也不触发技能搜索 —— 打了等于掉进真空。现在它们照常走技能搜索：
 * 真有同名技能就搜得到，没有就如实说没有，两种都比原来的静默强。
 */
const SELF_RENDERING_COMMANDS = new Set(['wiki'])

/**
 * 只在整段输入仍是一个 `/关键词` 时打开命令面板。
 *
 * 用户选完技能后会得到 `$skill-name `、选完命令会得到 `/name `，再继续写需求；
 * 一旦已经输入空格，面板就不再抢占正常的消息编辑。
 */
export function parseSkillSlashQuery(value: string): string | null {
  if (!value.startsWith('/')) return null

  const query = value.slice(1)
  if (/\s/.test(query)) return null
  if (SELF_RENDERING_COMMANDS.has(query.toLowerCase())) return null
  return query
}

/** 名称精确/前缀命中排在描述命中前面，结果相同时保留发现顺序。 */
export function filterSkillCommands(
  skills: AgentV3SkillSummary[],
  query: string
): AgentV3SkillSummary[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return skills

  return skills
    .map((skill, index) => {
      const name = skill.name.toLowerCase()
      const description = skill.description.toLowerCase()
      const score =
        name === normalized
          ? 0
          : name.startsWith(normalized)
            ? 1
            : name.includes(normalized)
              ? 2
              : description.includes(normalized)
                ? 3
                : Number.POSITIVE_INFINITY
      return { skill, index, score }
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.skill)
}

/** 输入框和 system prompt 共同约定的显式技能标记。 */
export function skillMention(name: string): string {
  return `$${name} `
}
