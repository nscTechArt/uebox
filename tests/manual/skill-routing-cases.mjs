/**
 * 技能路由的评测用例集。
 *
 * ## 为什么只有 17 条
 *
 * 计划里的完整集是 22 技能 × 2 正例 + 每技能 1 条邻域例 + 5 条无技能例 ≈ 74 条。
 * 这里**只写 0-7 方法试跑要的那 17 条**（`docs/review/` 里点名的 4 个高风险技能 +
 * 各自邻域 + 无技能例）。
 *
 * 理由是 0-7 的首要产出是**耗时**：每条样本要「关编辑器 → 重建副本 → 重开 → 跑」，
 * 那个数还没量过。先写 74 条、再发现方法太慢必须缩集，等于把大部分写作扔掉。
 * 试跑证明方法站得住之后再补齐，补的时候照这份的形状写即可。
 *
 * ## 三类用例，判据各不相同
 *
 * | 类别 | 声明 | 判据 |
 * |---|---|---|
 * | 正例 | `expect: '<技能名>'` | 六态判定，只有 `read-first` 算通过 |
 * | 邻域混淆例 | `expect` + `nearby: [...]` | 同上；加载了 `nearby` 里的名字单独记为「混淆」 |
 * | 无技能例 | `expect: null` | 整轮**没有** `load_skill` 才算通过 |
 *
 * 混淆和「根本不该加载」要分开报：前者修法是改描述的判别力，后者是改这条技能
 * 该不该出现在清单里 —— 合成一个「误触发率」就把两条相反的修法混在一起了。
 *
 * ## `say` 必须是改写过的说法
 *
 * **绝不能逐字抄 description 里的触发词。** 那些词就摆在模型的上下文里，
 * 逐字用等于把答案先给它看一遍，命中率会被测成虚高。
 * 这条不是靠自觉 —— `skill-routing-cases.test.ts` 会把每条 description 里
 * 引号包着的触发短语抠出来，逐个断言它不是 `say` 的子串。
 *
 * ## `requiredCompeting` 是什么
 *
 * 这道题「不读技能直接动手」要用到的工具。它不在会话工具池里的时候，
 * 跳过技能在物理上就发生不了，该样本对「模型会不会跳过技能」这个结论无效
 * （仍然对判别力有效）。真机上撞到过：`add_asset_tags` 不在那次的 72 个工具里。
 */

/**
 * 无技能例的公共形状。这几条要问得**确实不需要任何技能**——
 * 稍微沾点边（"这个盒子能干什么"）都可能是合理触发，那样测的就不是误触发了。
 */
const NO_SKILL = { expect: null, nearby: [], requiredCompeting: [], needsEngine: false }

export const CASES = Object.freeze([
  // ── ue-animation-retargeting ────────────────────────────────────────────
  // 描述里那串有序步骤（建 IK Rig → 定义链 → 建 Retargeter → 映射 → 对齐 → 批量）
  // 恰好省掉了正文最要命的三件事：版本闸（5.0/5.1 根本没有那两个类）、
  // 每步回读、ue_save。所以这条技能是「读没读到正文」差别最大的一个。
  {
    tag: 'retarget-pos-1',
    say: '我从网上下了一套跑步和走路的动作，骨架跟我角色的不一样，怎么让我的角色也能用上？',
    expect: 'ue-animation-retargeting',
    nearby: [],
    requiredCompeting: ['ue_run_python_script'],
    needsEngine: true
  },
  {
    tag: 'retarget-pos-2',
    say: '这些动作套到新角色身上肩膀会拧成麻花，能不能调一下让姿势对得上？',
    expect: 'ue-animation-retargeting',
    nearby: [],
    requiredCompeting: ['ue_run_python_script'],
    needsEngine: true
  },
  {
    // 邻域：description 自己点名的三条「不适用于」——导入 FBX、序列里的动画轨道、改网格
    tag: 'retarget-nearby',
    say: '这批动作我想整体挪到另一副骨骼上去，第一步该干什么？',
    expect: 'ue-animation-retargeting',
    nearby: ['ue-content-import-organize', 'ue-sequencer', 'ue-geometry-editing'],
    requiredCompeting: ['ue_run_python_script'],
    needsEngine: true
  },

  // ── ue-sequencer ────────────────────────────────────────────────────────
  // 正文第一条是「引擎断连时立刻停」，原话写着这是本 skill 出过的最严重事故，
  // 含四条禁令。描述里一个字没提。
  {
    tag: 'sequencer-pos-1',
    say: '我想让摄像机围着这栋楼慢慢绕一周，做成一小段镜头。',
    expect: 'ue-sequencer',
    nearby: [],
    requiredCompeting: ['sequence_camera_keys'],
    needsEngine: true
  },
  {
    tag: 'sequencer-pos-2',
    say: '预览的时候画面一片漆黑，序列里好像哪里配错了，帮我查查。',
    expect: 'ue-sequencer',
    nearby: [],
    requiredCompeting: ['sequence_audit', 'sequence_describe'],
    needsEngine: true
  },
  {
    // 邻域：「出图」和「运镜」在用户嘴里经常是同一句话
    tag: 'sequencer-nearby',
    say: '给这个场景做一段能看的镜头，最后要能交出去。',
    expect: 'ue-sequencer',
    nearby: ['ue-ai-render-from-blockout'],
    requiredCompeting: ['sequence_camera_keys'],
    needsEngine: true
  },

  // ── deep-research ───────────────────────────────────────────────────────
  // 正文里「搜索摘要是引擎写的不是页面写的，绝不可引用」这条，描述里没有。
  {
    tag: 'research-pos-1',
    say: 'Nanite 在哪些几何体上会掉回传统管线？我要能追到出处的结论。',
    expect: 'deep-research',
    nearby: [],
    requiredCompeting: ['web_search'],
    needsEngine: false
  },
  {
    tag: 'research-pos-2',
    say: '把 Lumen 和传统烘焙光照的代价摆一起比一比，每条都要有来源。',
    expect: 'deep-research',
    nearby: [],
    requiredCompeting: ['web_search'],
    needsEngine: false
  },
  {
    // 邻域：「存进知识库」容易把它带到 knowledge-base；「读某个文件」带到 local-files
    tag: 'research-nearby',
    say: '把虚幻的资产命名规范摸清楚，整理成一份能长期用的材料。',
    expect: 'deep-research',
    nearby: ['knowledge-base-and-projects', 'local-files'],
    requiredCompeting: ['web_search'],
    needsEngine: false
  },

  // ── ue-ai-render-from-blockout ──────────────────────────────────────────
  // 正文第一节是「渲染」的二义性判别表 + 歧义时必须先问。描述里只提了一句
  // 「When the wording is ambiguous… ask」，判别表本身在正文。
  {
    tag: 'airender-pos-1',
    say: '我摆了个灰模的大厅，想要一张能拿给客户看的氛围图。',
    expect: 'ue-ai-render-from-blockout',
    nearby: [],
    requiredCompeting: ['generate_image', 'ue_screenshot'],
    needsEngine: true
  },
  {
    tag: 'airender-pos-2',
    say: '按现在这个机位画一张风格化的宣传画，不用真的去渲。',
    expect: 'ue-ai-render-from-blockout',
    nearby: [],
    requiredCompeting: ['generate_image', 'ue_screenshot'],
    needsEngine: true
  },
  {
    // 邻域：这一条故意用二义的说法，看它会不会跑去 sequencer 做真渲染
    tag: 'airender-nearby',
    say: '这个白模场景，能不能弄一张成品效果出来看看？',
    expect: 'ue-ai-render-from-blockout',
    nearby: ['ue-sequencer'],
    requiredCompeting: ['generate_image', 'ue_screenshot'],
    needsEngine: true
  },

  // ── 无技能例 ────────────────────────────────────────────────────────────
  { tag: 'chitchat-greeting', say: '你好', ...NO_SKILL },
  { tag: 'chitchat-model', say: '你是什么模型？', ...NO_SKILL },
  { tag: 'chitchat-thanks', say: '谢谢，先这样吧。', ...NO_SKILL },
  { tag: 'chitchat-date', say: '今天几号？', ...NO_SKILL },
  { tag: 'chitchat-ack', say: '嗯，我知道了。', ...NO_SKILL }
])

/** 正例（含邻域混淆例）—— 有 `expect` 的那些 */
export const POSITIVE_CASES = CASES.filter((c) => c.expect !== null)

/** 无技能例 */
export const NO_SKILL_CASES = CASES.filter((c) => c.expect === null)

/** 这一批里出现过的技能名，供测试核对它们真实存在 */
export function referencedSkills(cases = CASES) {
  const names = new Set()
  for (const c of cases) {
    if (c.expect) names.add(c.expect)
    for (const n of c.nearby ?? []) names.add(n)
  }
  return [...names].sort()
}

/**
 * 把 description 里引号包着的触发短语抠出来。
 *
 * 中英文引号都认。测试拿它来断言 `say` 没有逐字抄——**这是整份用例集
 * 能不能算数的前提**，靠人自觉守不住。
 */
export function quotedTriggers(description) {
  const out = []
  for (const re of [/"([^"]{2,})"/g, /“([^”]{2,})”/g, /「([^」]{2,})」/g]) {
    for (const m of description.matchAll(re)) out.push(m[1].trim())
  }
  return out.filter(Boolean)
}

// ── 配对随机化调度（预登记 §4）────────────────────────────────────────────

/**
 * 随机序列的种子。**写死在预登记里**（`docs/review/技能路由A-B预登记-2026-09-08.md`），
 * 改它等于作废那次实验。
 */
export const SCHEDULE_SEED = 20260908

/** mulberry32 —— 小、确定、够用。要的是可复现，不是密码学强度 */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 生成配对运行表：每条用例重复 `reps` 次，每次是一个 A/B 对，先后随机但**平衡**。
 *
 * 「平衡」是指同一条用例的 reps 次里，A 先跑和 B 先跑的次数尽量各占一半 ——
 * 只随机不平衡的话，某条用例可能 5 次全是 A 先，那条就退化成固定交替，
 * 单调漂移会被系统性地算成 B 的改善。
 *
 * 先按 `reps` 造一半 'AB' 一半 'BA'（奇数时多出来那个由随机决定），再洗牌。
 */
export function pairedSchedule(cases, reps, seed = SCHEDULE_SEED) {
  const rand = rng(seed)
  const plan = []
  for (const c of cases) {
    const orders = []
    for (let i = 0; i < Math.floor(reps / 2); i++) orders.push('AB', 'BA')
    if (reps % 2 === 1) orders.push(rand() < 0.5 ? 'AB' : 'BA')
    // Fisher–Yates
    for (let i = orders.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[orders[i], orders[j]] = [orders[j], orders[i]]
    }
    orders.forEach((order, rep) => plan.push({ tag: c.tag, rep, order }))
  }
  // 再整体洗一遍：否则同一条用例的 5 个对会连着跑，赶上一段网络抖动就全废
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[plan[i], plan[j]] = [plan[j], plan[i]]
  }
  return plan
}
