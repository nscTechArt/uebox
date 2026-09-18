/**
 * 体检结论 → 人话。
 *
 * ## 为什么单独一个文件
 *
 * 「查出什么」是 Python 的事，「怎么说给用户听」是纯逻辑。分开之后这张解释表
 * 可以脱离引擎单独测 —— 而它恰恰是最需要测的部分：**说错一句话的代价比查漏一项高**。
 * 报一个假的「已失效」会让用户去修一个没坏的东西。
 *
 * ## 每条问题必须给三样
 *
 * 现象是什么、为什么会这样、**他自己怎么点**。
 *
 * 这不是文案讲究，是评审得出的结论：这些坑用户每隔几个月会再踩一次。
 * 替他改一次，三个月后他还是不会；告诉他一次，他大概能记住一半，
 * 而且知道下次该查什么。见 `resources/skills/ue-sequencer/`。
 *
 * ## 严重度分三档，不是两档
 *
 * `breaks_render` 和 `breaks_preview` 必须分开：前者是「渲出去就是废的」，
 * 后者是「编辑器里看着不对但渲染没事」。混成一个「错误」，用户就得自己判断
 * 该不该按渲染键 —— 而他问我们就是为了不用自己判断。
 */

/** 严重度。决定 PASS / FAIL，也决定用户该不该现在按渲染键 */
export type Severity =
  /** 渲出去就是废的：黑帧、错相机、轨道无效果 */
  | 'breaks_render'
  /** 编辑器里表现不对，但渲染出来大概率没事 */
  | 'breaks_preview'
  /** 不影响结果，只影响可维护性 */
  | 'cosmetic'
  /** 判不出来。**不是问题**，只是这次没查成 */
  | 'unknown'

/** 一条体检结论 */
export interface Finding {
  /** 稳定的问题类型 id。修复工具以后按它点名，不要按文案匹配 */
  code: string
  severity: Severity
  /** 出问题的位置。轨道名 / 绑定名 / 帧号，越具体越好 */
  evidence: string
  /** 未来 `sequence_repair` 能不能自动修 */
  autoFixable: boolean
}

interface Explanation {
  /** 一句话说清现象 */
  what: string
  /** 为什么会这样 */
  why: string
  /** 用户自己怎么点。**没有这条的问题等于没诊断出来** */
  how: string
}

/**
 * 解释表。
 *
 * 内容来自社区实证，
 * 不是凭经验编的。改这里之前先确认新说法也有出处。
 */
const EXPLANATIONS: Record<string, Explanation> = {
  no_camera_cut_track: {
    what: '没有相机切轨（Camera Cuts Track）',
    why: '渲染器不知道该用哪台相机，输出的就是空画面 —— 整段全黑',
    how: 'Sequencer 面板左上 + Track → Camera Cut Track，然后在轨道上点 + 选中场景里的 CineCameraActor'
  },
  camera_cut_empty: {
    what: '相机切轨是空的，一个段都没有',
    why: '有轨道但没有内容，等于没有相机',
    how: '在 Camera Cuts 轨道上点 +，选中要用的 CineCameraActor'
  },
  camera_cut_gap: {
    what: '相机切轨的段之间有空隙',
    why: '两段之间哪怕差一帧，那一帧就没有相机，渲出来是黑的。这条在时间线上肉眼基本看不出来',
    how: '把后一段的起点拖到与前一段末帧相接。段是闭开区间，前一段的 end 就是后一段应有的 start，不要再 +1'
  },
  camera_cut_not_covering: {
    what: '相机切轨没有覆盖完整播放范围',
    why: '没被覆盖的那些帧没有相机，渲出来是黑的',
    how: '拖动 Camera Cuts 段的两端，盖满整个 playback range'
  },
  camera_cut_overlap: {
    what: '相机切轨的段互相重叠',
    why: '重叠区间渲哪台相机是不确定的，同一份序列在不同机器上可能出不同结果',
    how: '把重叠的段拖开，让它们首尾相接而不是叠在一起'
  },
  broken_binding: {
    what: '绑定已失效，找不到对应的 Actor',
    why: 'Possessable 绑定存的是路径引用。改名、移到别的子关卡、删了重放、关卡另存为新名字，绑定就断 —— 而且不报错，播放器照跑，那条轨道只是什么都不做',
    how: 'Level Sequence 编辑器 → 扳手图标 Actions → Advanced → Rebind Possessable References。修不好就右键那条轨道 → Assign Actor 选中正确的 Actor'
  },
  unresolved_binding: {
    what: '这次判不出绑定是否有效',
    why: 'World Partition 里没加载的 Actor、正在 PIE、或者拿不到编辑器世界，都会让好绑定看起来解析不了。**这不代表它坏了**',
    how: '打开对应的关卡、退出 PIE，然后再查一次'
  },
  section_out_of_range: {
    what: '有段落在播放范围之外',
    why: '范围外的段不会被求值，等于白做；也常常是拖拽时手滑的痕迹',
    how: '把段拖回播放范围内，或者把 playback range 拉长到包住它'
  },
  subsequence_length_mismatch: {
    what: '子序列的实际时长和它在父层 shot 段上的长度对不上',
    why: '父层截短了就丢结尾，父层拉长了就多出一段空白。改子序列时长时父层不会自动跟着变',
    how: '右键那个 shot 段 → Edit → Auto Size，让父层贴合子序列的实际内容'
  },
  empty_track: {
    what: '有轨道一个段都没有',
    why: '通常是加了轨道忘了放内容。空的 shot track 还会让所有 Camera Component 轨道失效（UE-34912）',
    how: '给它加内容，或者删掉。**先确认这不是你留的占位** —— 我们不会替你删'
  },
  binding_without_tracks: {
    what: '有绑定挂着但一条轨道都没有',
    why: '绑了对象却没有任何动画或属性变化，等于没绑',
    how: '给它加轨道，或者删掉这条绑定。同样先确认这不是占位'
  },
  mixed_camera_binding_types: {
    what: '相机在同一条序列里同时以 spawnable 和 possessable 存在',
    why: '切镜边界上可能渲到错误的那台实例，表现是闪一帧不对的画面',
    how: '统一成一种。⚠️ 注意 Convert to Spawnable 会复制并删除关卡里的原 Actor —— 名字看着像格式转换，实际是对关卡的破坏性改动，还会影响同时在这个关卡里工作的人'
  },
  subsequence_unreadable: {
    what: '有子序列读不出来',
    why: '父层 shot 段还指着它，但那个资产已经不在了（被删、被改名、或者移走了）。渲染时这一段没有内容',
    how: '在 Content Browser 里找到改名后的资产，右键那个 shot 段重新指过去；或者删掉这个 shot 段'
  },
  loop_duplicate_frame: {
    what: '循环序列的首尾帧重复',
    why: '按「首尾都含」算范围会多出一帧，loop 播放时接缝处看得出卡顿。turntable 和环绕展示尤其明显',
    how: 'N 帧一圈的话，关键帧打在第 0 和第 N 帧，播放范围设 [0, N) —— 第 N 帧不会被渲染，正好接上第 0 帧'
  }
}

/** 未知 code 的兜底。不认识的问题也要说得出口，不能印一行 undefined */
const FALLBACK: Explanation = {
  what: '发现一个未归类的问题',
  why: '这个问题类型还没有写解释',
  how: '把这条报告发给我们，我们补上'
}

export function explain(code: string): Explanation {
  return EXPLANATIONS[code] ?? FALLBACK
}

/** 已登记解释的问题类型。给测试用，保证 Python 侧新增 code 时不会漏写解释 */
export function knownCodes(): string[] {
  return Object.keys(EXPLANATIONS)
}

const SEVERITY_LABEL: Record<Severity, string> = {
  breaks_render: '会导致渲染失败',
  breaks_preview: '编辑器里表现不对',
  cosmetic: '不影响结果',
  unknown: '无法判定'
}

const SEVERITY_ICON: Record<Severity, string> = {
  breaks_render: '❌',
  breaks_preview: '⚠️',
  cosmetic: '·',
  unknown: 'ℹ️'
}

/**
 * 一条序列的判定。
 *
 * **只有 `breaks_render` 才算 FAIL。** 用户问的是「现在能不能渲」，
 * 把「有个空轨道」也算成不通过，他就得自己重新判断一遍 ——
 * 而他问我们就是为了不用自己判断。
 */
export function verdictOf(findings: Finding[]): 'PASS' | 'FAIL' {
  return findings.some((f) => f.severity === 'breaks_render') ? 'FAIL' : 'PASS'
}

/** 一条序列的体检报告 */
export interface SequenceReport {
  path: string
  findings: Finding[]
  /** 读不出来时的原因。有值时上面的 findings 不可信 */
  error?: string
}

/**
 * 排序：先按严重度，再按 code。
 *
 * 会导致渲染失败的必须排最前 —— 用户扫一眼就要看到「要不要现在停下来」。
 */
const SEVERITY_ORDER: Severity[] = ['breaks_render', 'breaks_preview', 'unknown', 'cosmetic']

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const d = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    return d !== 0 ? d : a.code.localeCompare(b.code)
  })
}

/**
 * 报告成文本。
 *
 * 结论先行：先给 PASS/FAIL，再展开。评审的原话是
 * 「要么 PASS，要么 FAIL：CAM_Living 第 340 帧有 1 帧空隙」——
 * 「看起来大体没问题，但建议检查一下」这种输出是负价值，
 * 用户读完还是不知道该不该按渲染键。
 */
export function formatReports(reports: SequenceReport[]): string {
  const lines: string[] = []

  // 多条序列时先给总览：一轮要出 24 个 job，逐个读等于没体检
  if (reports.length > 1) {
    lines.push('## 总览', '')
    for (const r of reports) {
      if (r.error) {
        lines.push(`- ⚠️ \`${r.path}\` 读取失败：${r.error}`)
        continue
      }
      const verdict = verdictOf(r.findings)
      const blockers = r.findings.filter((f) => f.severity === 'breaks_render').length
      lines.push(
        `- ${verdict === 'PASS' ? '✅ PASS' : '❌ FAIL'} \`${r.path}\`` +
          (blockers > 0 ? ` —— ${blockers} 项会导致渲染失败` : '') +
          (verdict === 'PASS' && r.findings.length > 0 ? `（${r.findings.length} 项提示）` : '')
      )
    }
    lines.push('')
  }

  for (const r of reports) {
    if (r.error) {
      lines.push(`## ${r.path}`, '', `读取失败：${r.error}`, '')
      continue
    }

    const verdict = verdictOf(r.findings)
    lines.push(`## ${r.path} — ${verdict === 'PASS' ? '✅ PASS' : '❌ FAIL'}`, '')

    if (r.findings.length === 0) {
      lines.push('没有发现问题。', '')
      continue
    }

    for (const f of sortFindings(r.findings)) {
      const e = explain(f.code)
      lines.push(
        `### ${SEVERITY_ICON[f.severity]} ${e.what}`,
        `- 位置：${f.evidence}`,
        `- 影响：${SEVERITY_LABEL[f.severity]}`,
        `- 原因：${e.why}`,
        `- 怎么改：${e.how}`,
        ''
      )
    }
  }

  // 划清边界。用户问「能不能渲」，很容易接着说「那你帮我渲」
  lines.push(
    '---',
    '',
    '本工具只诊断，不渲染 —— 渲染要花几小时机器时间和几十 GB 磁盘，' +
      '编解码和采样设置直接挂在交付物上，这个决定和执行都由你自己来。'
  )

  return lines.join('\n')
}
