/**
 * 「自动沉淀」那档开关里唯一被点名的技能名。
 *
 * 放在 shared 而不是主进程里，是因为两边都要认它：主进程按它在关档时把这条
 * 技能从清单里摘掉（`applySkillLearningMode`），设置页按它把那一行标成
 * 「此刻模型看不见」。各写各的字符串就会漂 —— 漂了之后界面显示的是开着，
 * 模型手里其实没有，而这正是开关最不该出现的失效方向。
 */
export const SKILL_CREATOR_NAME = 'ue-skill-creator'
