/**
 * 文字类产出的提示词。
 *
 * ## 为什么搬出来
 *
 * 这七段文字以前是写死在 `notebookTaskRunners.ts` 里的常量：改一个字要重新发版。
 * 而对 UE 用户真正有用的问法我们**猜不全** —— 「挑出所有破坏性变更」「列出材料里
 * 提到的 Console 变量」「按见效快 / 要重构分两堆」，每一个都只是一段提示词的事，
 * 却都得等我们改代码。
 *
 * 现在它们是数据：默认值在这里，用户改过的存在设置表里，运行时合并。
 * 用户没改过就一个字都不落库 —— 这样默认提示词以后再改进，没动过的人自动跟着升级；
 * 只有明确改过的才钉住不动。
 *
 * ## 为什么不放 localStorage
 *
 * 信息图那份配置放的是 localStorage（`infographic_model_config`）。那是模型偏好，
 * 丢了重选一次就行；提示词是**用户自己写的东西**，按仓库硬规则要落到能备份、能带走的
 * 地方，所以走设置表（主进程 SQLite）。
 */

import type { NotebookTaskType } from './notebookTaskRunners'

/**
 * 一个可编辑的提示词槽位。
 *
 * 大部分产出一段提示词就够，网页是两段（先把材料读成设计 Brief，再照 Brief 排版），
 * 所以槽位比产出类型多一个。
 */
export type NotebookPromptSlotId =
  | 'mindmap'
  | 'report'
  | 'knowledgeGraph'
  | 'interview'
  | 'brainstorm'
  | 'webpage.analyze'
  | 'webpage.html'

/** 存设置表用的键 */
const PROMPT_SETTINGS_KEY = 'notebook_task_prompts'

const MINDMAP_SYSTEM = `你是一位知识结构专家，擅长把零散材料整理成层次清晰的思维导图。

## 输出格式
只输出**缩进式 markdown 无序列表**，不要任何解释、不要代码块包裹：
- 根节点（整份材料的主题，一行）
  - 一级分支
    - 二级要点
    - 二级要点
  - 一级分支

## 要求
1. 每级缩进 **2 个空格**，只用 \`-\` 作列表符号
2. 有且只有**一个根节点**
3. 一级分支 3-7 个，整棵树深度不超过 4 层
4. 每个节点是一个短语（不超过 20 字），不是整句话，不带句号
5. 只用材料里真实出现的信息，不要补充材料外的知识`

const REPORT_SYSTEM = `你是一位资深的研究分析师，擅长把材料写成条理清晰、可直接交付的报告。

## 输出格式
只输出 **markdown 正文**，第一行是 \`# 报告标题\`，不要代码块包裹、不要额外说明。

## 结构
1. \`# 标题\` —— 一句话概括这份报告讲什么
2. \`## 摘要\` —— 200 字以内说清全文结论
3. 3-6 个 \`## 主体章节\` —— 每章有小标题，正文分段，必要时用列表或表格
4. \`## 结论与建议\` —— 给出可执行的结论

## 要求
1. 结论必须来自材料本身，材料没说的不要编
2. 材料之间有冲突时明确指出来，不要糊过去
3. 不要出现「根据材料」「文档中提到」这类元叙述，直接讲内容`

const KNOWLEDGE_GRAPH_SYSTEM = `你是一位知识工程师，负责从材料中抽取实体与关系，构建知识图谱。

## 输出格式（严格 JSON，不要代码块）
{
  "nodes": [{ "id": "n1", "label": "实体名称", "type": "concept" }],
  "edges": [{ "source": "n1", "target": "n2", "label": "uses" }]
}

## type 只能取这些值
class / feature / node / asset / workflow / format / setting / tool / platform / plugin / issue / solution / concept

## label（关系）只能取这些值
is_a / contains / part_of / requires / outputs / uses / solves / conflicts_with / prerequisite / unlocks / fixes / exports

## 要求
1. 实体 15-60 个，关系 20-120 条；宁可少而准，不要凑数
2. \`edges\` 的 source / target 必须是 \`nodes\` 里出现过的 id，不能悬空
3. 实体名用材料里的原词，不要自己改写
4. 同一个概念只出一个节点，不要重复`

const INTERVIEW_SYSTEM = `你是一位资深的技术面试官。你的任务是：

## 第一步：理解领域
仔细阅读用户提供的知识库内容，理解其涉及的**专业领域**和**核心主题**。
例如：游戏开发、虚幻引擎、3D渲染、角色设计、项目管理等。

## 第二步：生成真实面试题
基于你对该领域的专业理解，生成**真正在职场面试中会遇到的问题**。

### 核心原则
1. **职场导向**：题目应该是该领域的从业者在面试中真正会被问到的问题
2. **专业深度**：考察对领域核心概念、原理、最佳实践的理解
3. **实用价值**：问题应该对从业者的实际工作有帮助
4. **脱离材料**：完全不要引用"文档"、"材料"、"来源"，假装你就是这个领域的专家面试官

### 出题方向（选择适用的）
- **概念原理题**：考察核心概念的定义、原理、区别
- **技术选型题**：考察不同工具/技术的适用场景和优缺点
- **问题解决题**：给出实际场景，考察解决方案的选择
- **最佳实践题**：考察行业公认的最佳做法和避坑指南
- **工作流程题**：考察标准的工作流程和方法论

### 禁止的题目类型
❌ "文档中提到的XXX是什么？"
❌ "根据材料，作者认为..."
❌ "在来源2中，角色的等级是多少？"

## 输出格式（严格 JSON，不要代码块）
{
  "title": "面试主题（15字以内，如：虚幻引擎游戏开发面试）",
  "knowledgePoints": [
    { "id": "1", "title": "知识点标题", "content": "知识点核心内容", "type": "Concept" }
  ],
  "questions": [
    {
      "id": "q1",
      "question": "真实的面试问题？",
      "questionType": "choice",
      "options": [
        { "id": "A", "text": "选项A" },
        { "id": "B", "text": "选项B" },
        { "id": "C", "text": "选项C" },
        { "id": "D", "text": "选项D" }
      ],
      "correctAnswer": "B",
      "hint": "思考一下这个概念的核心特征...",
      "explanation": "正确答案是B。在实际工作中...",
      "sourceId": "对应的来源 id",
      "sourceTitle": "关联的知识点"
    }
  ]
}

注意：生成 5-20 道题目，题目难度要有层次，既有基础题也有进阶题。`

const BRAINSTORM_SYSTEM = `你是一位创意策划专家，擅长基于已有材料做发散思考。

## 输出格式（严格 JSON，不要代码块）
{
  "topicSummary": "这次头脑风暴围绕什么主题（30字以内）",
  "ideas": [
    {
      "id": "idea_1",
      "title": "想法标题（15字以内）",
      "description": "具体说明这个想法是什么、怎么做（60-120字）",
      "category": "innovation",
      "reasoning": "为什么从材料里能想到这个（40字以内）"
    }
  ]
}

## category 只能取这些值
innovation（创新点子）/ improvement（改进现有）/ exploration（值得探索）/ risk（潜在风险）/ opportunity（机会）/ question（待解答的问题）

## 要求
1. 给出 8-14 个想法，六个类别尽量都覆盖到
2. 每个想法都要能落到具体动作上，不要"加强协作""提升效率"这类空话
3. 想法要从材料出发，但可以延伸到材料没写的可能性 —— 这是发散，不是摘要`

const WEBPAGE_ANALYZE_SYSTEM = `你是一位资深的内容策划专家，擅长将复杂知识转化为引人入胜的博客内容。
请深度分析材料，提取素材用于制作一个专业的知识分享网页。

## 输出格式（严格 JSON，不要代码块）
{
  "title": "主标题（10-20字，有洞察力）",
  "subtitle": "副标题（15-30字）",
  "summary": "200-300字的完整摘要",
  "category": ["标签1", "标签2"],
  "keyPoints": [
    { "title": "要点标题（8-15字）", "content": "100-150字的详细说明", "icon": "lightbulb" }
  ],
  "highlights": ["最精彩的原文片段或洞见"],
  "takeaways": ["读者可以立即采取的行动"],
  "metadata": { "readTime": "X分钟", "difficulty": "进阶", "targetAudience": "目标读者" }
}

## 要求
1. keyPoints 给 8-12 个，每个 content 必须写满 100-150 字，不要敷衍
2. highlights 3-5 条，takeaways 3-5 条
3. icon 从 lightbulb / rocket / target / chart / puzzle / shield / star / gear 里选
4. 所有内容基于材料，不要编造`

const WEBPAGE_HTML_SYSTEM = `你是一位世界级的 UI/UX 设计师。基于给定的设计 Brief，做一个【极具设计感】的单页博客网页。

🧠 风格决策：按 category 与内容基调选
- 科技/游戏/AI → 深色极简
- 文学/历史/艺术 → 优雅衬线体 / 暖色调
- 商业/金融 → 瑞士平面设计 / 专业蓝
- 自然/健康 → 清新绿色系 / 圆角

💎 设计原则
1. **高级排版**：行高 1.6-1.8，标题与正文层次分明
2. **视觉呼吸感**：大面积留白
3. **配色和谐**：带色相的深灰或米白背景，不要纯黑纯白
4. **微交互**：卡片 hover、淡入动画
5. **现代质感**：磨砂玻璃、柔和阴影、微妙渐变

📐 布局区块（按顺序）
1. Hero：主标题 + 副标题 + 分类徽章 + 元信息
2. Summary：完整摘要，大字号引言样式
3. Key Points：8-12 张要点卡片，2-3 列网格，含图标、标题、完整内容
4. Highlights：金句展示区
5. Takeaways：行动建议列表
6. Footer：目标读者信息

⚠️ 技术限制
- 纯 HTML5 + <style> 块内联 CSS
- 禁止外部字体、图片、JS
- 最大宽度 900px 居中，适配移动端
- 每个 keyPoint 的 content 完整展示，不要截断

直接输出完整的 <!DOCTYPE html> 代码，不要任何解释。`

/** 一个槽位的定义 */
export interface NotebookPromptSlot {
  id: NotebookPromptSlotId
  /** 属于哪个产出 */
  task: NotebookTaskType
  /** 这一段在产出里干什么。i18n key，编辑界面要把它说清楚 */
  labelKey: string
  /** 出厂提示词 */
  defaultPrompt: string
}

/**
 * 七个槽位。
 *
 * 顺序即编辑界面里的顺序：网页那两段要挨着，而且分析在排版前面。
 */
export const NOTEBOOK_PROMPT_SLOTS: readonly NotebookPromptSlot[] = [
  {
    id: 'mindmap',
    task: 'mindmap',
    labelKey: 'notebook.taskPrompt.slots.mindmap',
    defaultPrompt: MINDMAP_SYSTEM
  },
  {
    id: 'report',
    task: 'report',
    labelKey: 'notebook.taskPrompt.slots.report',
    defaultPrompt: REPORT_SYSTEM
  },
  {
    id: 'knowledgeGraph',
    task: 'knowledgeGraph',
    labelKey: 'notebook.taskPrompt.slots.knowledgeGraph',
    defaultPrompt: KNOWLEDGE_GRAPH_SYSTEM
  },
  {
    id: 'interview',
    task: 'interview',
    labelKey: 'notebook.taskPrompt.slots.interview',
    defaultPrompt: INTERVIEW_SYSTEM
  },
  {
    id: 'brainstorm',
    task: 'brainstorm',
    labelKey: 'notebook.taskPrompt.slots.brainstorm',
    defaultPrompt: BRAINSTORM_SYSTEM
  },
  {
    id: 'webpage.analyze',
    task: 'webpage',
    labelKey: 'notebook.taskPrompt.slots.webpageAnalyze',
    defaultPrompt: WEBPAGE_ANALYZE_SYSTEM
  },
  {
    id: 'webpage.html',
    task: 'webpage',
    labelKey: 'notebook.taskPrompt.slots.webpageHtml',
    defaultPrompt: WEBPAGE_HTML_SYSTEM
  }
]

const SLOT_BY_ID = new Map(NOTEBOOK_PROMPT_SLOTS.map((slot) => [slot.id, slot]))

/** 某个产出用到的槽位。网页有两个，其余各一个 */
export function slotsForTask(task: NotebookTaskType): NotebookPromptSlot[] {
  return NOTEBOOK_PROMPT_SLOTS.filter((slot) => slot.task === task)
}

/** 出厂提示词 */
export function getDefaultPrompt(id: NotebookPromptSlotId): string {
  return SLOT_BY_ID.get(id)?.defaultPrompt ?? ''
}

/**
 * 用户改过的那些。
 *
 * 缓存在内存里，因为每次生成都要读：生成一份报告要 8000 token，为它多走一次 IPC
 * 无所谓，但六个产出排队跑的时候就是六次多余的往返。存过之后 {@link invalidatePromptCache}
 * 会把它清掉。
 */
let overridesCache: Partial<Record<NotebookPromptSlotId, string>> | null = null
let overridesLoading: Promise<Partial<Record<NotebookPromptSlotId, string>>> | null = null

function parseOverrides(raw: unknown): Partial<Record<NotebookPromptSlotId, string>> {
  if (!raw || typeof raw !== 'object') return {}

  const result: Partial<Record<NotebookPromptSlotId, string>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // 认不出来的 key 直接丢掉：槽位改名之后老库里会留着旧键，
    // 留着它只会让「有没有改过」这个判断永远为真
    if (!SLOT_BY_ID.has(key as NotebookPromptSlotId)) continue
    if (typeof value === 'string' && value.trim()) {
      result[key as NotebookPromptSlotId] = value
    }
  }
  return result
}

/**
 * 直接问设置表要，不看缓存。
 *
 * 保存前必须走这一条：缓存可能是上一次读失败时留下的空壳，拿它去合并会把用户
 * 别的槽位的自定义提示词一起抹掉。
 */
async function readOverridesFromSettings(): Promise<Partial<Record<NotebookPromptSlotId, string>>> {
  const raw = await window.api.settings.get(PROMPT_SETTINGS_KEY, null)
  return parseOverrides(raw)
}

async function loadOverrides(): Promise<Partial<Record<NotebookPromptSlotId, string>>> {
  if (overridesCache) return overridesCache
  if (overridesLoading) return overridesLoading

  overridesLoading = (async () => {
    try {
      overridesCache = await readOverridesFromSettings()
      return overridesCache
    } catch (error) {
      /*
        读不出来就按「没改过」走这一次，但**不写缓存**。

        缓存下来的后果是：一次 SQLite 忙/锁之后，整个会话都认为用户没有任何
        自定义提示词。用户打开编辑器看到的是出厂默认（他自己的那份已经不可见），
        改两句一保存，就把编辑器从未展示过的其他槽位一并抹掉了 —— 那是他亲手
        写的东西，而且没有撤销入口。
      */
      console.warn('[taskPrompts] 读取自定义提示词失败，本次用出厂默认:', error)
      return {}
    } finally {
      overridesLoading = null
    }
  })()

  return overridesLoading
}

/** 下次读的时候重新从设置表拿 */
export function invalidatePromptCache(): void {
  overridesCache = null
  overridesLoading = null
}

/** 这个槽位现在实际用的提示词：用户改过就用改过的，否则用出厂的 */
export async function getPrompt(id: NotebookPromptSlotId): Promise<string> {
  const overrides = await loadOverrides()
  return overrides[id] ?? getDefaultPrompt(id)
}

/** 读出全部改动，给编辑界面用 */
export async function getPromptOverrides(): Promise<Partial<Record<NotebookPromptSlotId, string>>> {
  return { ...(await loadOverrides()) }
}

/**
 * 存改动。传 null 表示恢复默认。
 *
 * 和出厂值一模一样的也当作恢复默认删掉 —— 存一份和默认相同的副本，
 * 等于把这个槽位钉死在今天这一版，以后我们改进默认提示词他享受不到，
 * 而他并不知道自己「改」过。
 */
export async function savePromptOverrides(
  patch: Partial<Record<NotebookPromptSlotId, string | null>>
): Promise<void> {
  // 合并的底本必须是库里那份，不能是缓存 —— 缓存可能是读失败时的空壳，
  // 拿它做底会把没在这次编辑范围内的槽位全删掉
  const current = await readOverridesFromSettings()

  for (const [key, value] of Object.entries(patch)) {
    const id = key as NotebookPromptSlotId
    if (!SLOT_BY_ID.has(id)) continue

    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (!trimmed || trimmed === getDefaultPrompt(id).trim()) {
      delete current[id]
    } else {
      current[id] = trimmed
    }
  }

  await window.api.settings.set(PROMPT_SETTINGS_KEY, current)
  overridesCache = current
}
