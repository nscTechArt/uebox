/**
 * 审查本轮改动 —— 「它说做完了，那到底做成了没有」。
 *
 * ## 为什么需要这一层
 *
 * 「本轮改动」清单答的是**agent 干了什么**：建了这个材质、改了那个蓝图。
 * 它照抄工具调用，工具回了成功它就记成功。但 UE 里「调用成功」和「东西是好的」
 * 差着好几步：资产建在了内存里没落盘，蓝图连线连错了编译不过，引用指向一个
 * 被删掉的贴图 —— 这些工具全都回成功，用户要等到关掉编辑器、或者打包的时候
 * 才发现。那时他早就忘了是哪一轮改出来的。
 *
 * 引擎自己知道这些事，只是从来没人替用户去问一遍。这个模块就是去问一遍。
 *
 * ## 为什么不交给模型去审
 *
 * 让 agent 再跑一轮「你检查一下自己刚才做的」，审的是它自己的记忆 ——
 * 它记得自己调用成功了，于是回答「都做好了」。而这里问的是引擎的当前状态，
 * 和模型说过什么无关。确定性检查在这件事上不是省钱，是唯一说得准的做法。
 *
 * ## 分两半：静态的和引擎的
 *
 * 命名建议不需要引擎，光看路径就能给。其余七项全要引擎回答。
 * 引擎没连时**只报静态那一半，并明说另一半没跑** —— 否则「没查出问题」
 * 会被读成「一切正常」，而最要紧的几项根本没执行。
 */

import type {
  AgentReviewCode,
  AgentReviewFinding,
  AgentReviewResult,
  AgentReviewSeverity,
  AgentReviewTarget
} from '../../../shared/agentReview'
import { REVIEW_SEVERITY_ORDER } from '../../../shared/agentReview'
import { runEditorPython, type EditorPythonResult } from './editorPython'

/** 检查项 → 严重程度。界面按这个排序着色，主进程这边只负责定级 */
const SEVERITY: Readonly<Record<AgentReviewCode, AgentReviewSeverity>> = Object.freeze({
  missing: 'error',
  'still-there': 'error',
  'compile-error': 'error',
  'broken-dependency': 'error',
  'orphan-referencer': 'error',
  unsaved: 'warning',
  'compile-warning': 'warning',
  'check-failed': 'warning',
  naming: 'info'
})

/**
 * 命名前缀惯例。
 *
 * 各家团队的规范不完全一样，这里只收**社区里没有争议的那几个**，而且一律
 * 定级 info：把「命名不符合我这份表」报成错误，会让真正的编译失败淹没在
 * 一堆挑刺里。宁可漏报也不要喧宾夺主。
 *
 * 只对**新建**的资产提。用户工程里早就存在的资产叫什么名字不是这一轮的事，
 * 顺手挑出来只会让每次审查都带着一串改不完的历史遗留。
 */
const NAMING_RULES: Readonly<Record<string, { prefixes: readonly string[]; suggestion: string }>> =
  Object.freeze({
    material: { prefixes: ['M_', 'MI_', 'MF_', 'MPC_'], suggestion: 'M_ / MI_' },
    blueprint: { prefixes: ['BP_', 'ABP_', 'BPI_', 'GM_', 'GI_', 'PC_', 'AC_'], suggestion: 'BP_' },
    widget: { prefixes: ['WBP_', 'W_'], suggestion: 'WBP_' }
  })

/** 引擎内资产路径（`/Game/…`、插件挂载点）。Actor 名和本地文件路径进不来 */
function isContentPath(path: string): boolean {
  return /^\/[A-Za-z0-9_]+\/.+/.test(path.trim())
}

/**
 * 归一成**包名**。
 *
 * 资产路径有两种写法：包名 `/Game/A/M_X` 和对象路径 `/Game/A/M_X.M_X`。
 * 资产注册表的 `get_dependencies` 要的是前者，传后者查不到任何依赖 ——
 * 而且不会报错，只是安静地回一个空列表，看起来像「这个资产没有依赖」。
 */
function toPackagePath(path: string): string {
  const trimmed = path.trim()
  const dot = trimmed.lastIndexOf('.')
  const slash = trimmed.lastIndexOf('/')
  return dot > slash ? trimmed.slice(0, dot) : trimmed
}

/** 能送进引擎查的目标：引擎内资产路径，去重，最多 40 个 */
export function normalizeReviewTargets(targets: AgentReviewTarget[]): AgentReviewTarget[] {
  const seen = new Map<string, AgentReviewTarget>()

  for (const target of targets) {
    const path = toPackagePath(String(target?.path ?? ''))
    if (!path || !isContentPath(path)) continue
    // 同一个资产被多次列出时保留第一条 —— 清单本来就是按资产聚合的，
    // 重复只可能来自路径的两种写法，归一之后它们是同一个
    if (!seen.has(path)) {
      seen.set(path, { path, action: target.action ?? 'modified', kind: target.kind })
    }
  }

  // 上限是给引擎那一半兜底的：每个资产都要 load + 遍历依赖，四十个已经要跑几秒。
  // 一轮里 agent 动四十个以上资产的情况没见过，真出现时截断也比卡住编辑器好
  return [...seen.values()].slice(0, 40)
}

/** 命名建议。不需要引擎，路径本身就够判断 */
export function reviewNaming(targets: AgentReviewTarget[]): AgentReviewFinding[] {
  const findings: AgentReviewFinding[] = []

  for (const target of targets) {
    if (target.action !== 'created') continue

    const rule = NAMING_RULES[String(target.kind ?? '')]
    if (!rule) continue

    const name = target.path.split('/').pop() ?? ''
    if (!name || rule.prefixes.some((prefix) => name.startsWith(prefix))) continue

    findings.push({
      target: target.path,
      code: 'naming',
      severity: SEVERITY.naming,
      detail: rule.suggestion
    })
  }

  return findings
}

/** 引擎脚本回来的一条原始记录 */
interface RawFinding {
  target?: unknown
  code?: unknown
  detail?: unknown
}

/**
 * 把引擎脚本的输出折算成 findings。
 *
 * 认不出来的 code 直接丢掉：脚本和这份表都在同一个仓库里，对不上说明有人只改了
 * 一边，那时候少一行比在界面上显示一行空白强。
 */
export function parseEngineFindings(output: Record<string, unknown> | undefined): {
  findings: AgentReviewFinding[]
} {
  const raw = Array.isArray(output?.findings) ? (output!.findings as RawFinding[]) : []
  const findings: AgentReviewFinding[] = []

  for (const item of raw) {
    const code = String(item?.code ?? '') as AgentReviewCode
    const target = String(item?.target ?? '')
    if (!target || !(code in SEVERITY)) continue

    const detail = typeof item?.detail === 'string' ? item.detail.trim() : ''
    findings.push({
      target,
      code,
      severity: SEVERITY[code],
      ...(detail ? { detail } : {})
    })
  }

  return { findings }
}

/**
 * 引擎里跑的那一半。
 *
 * 每一项检查各自 try/except：`AssetRegistryDependencyOptions` 的默认值在 5.0 和
 * 5.2 之间变过（5.2 起全部默认 False，不显式传参会一个依赖都查不出来），
 * `Blueprint.status` 至今标着 Experimental。一项探不到就跳过那一项，
 * 不能让整次审查因为某个版本少个 API 就全军覆没。
 */
function buildScript(targets: AgentReviewTarget[]): string {
  const payload = JSON.stringify(JSON.stringify(targets.map((t) => ({ p: t.path, a: t.action }))))

  return `
import json

targets = json.loads(${payload})
findings = []

def add(target, code, detail=""):
    findings.append({"target": target, "code": code, "detail": detail})

registry = None
try:
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
except Exception:
    registry = None

# 5.2 起这几个开关默认全是 False，不显式传就查不出任何依赖 —— 而且不报错
dep_options = None
if registry is not None:
    try:
        dep_options = unreal.AssetRegistryDependencyOptions(
            include_soft_package_references=True,
            include_hard_package_references=True,
            include_searchable_names=False,
            include_soft_management_references=False,
            include_hard_management_references=False,
        )
    except Exception:
        dep_options = None

# /Script/ 是 C++ 类，/Engine/ 和 /Temp/ 不是用户工程里的东西，查不到不算断引用
SKIP_ROOTS = ("/Script/", "/Engine/", "/Temp/", "/Memory/")

def exists(path):
    try:
        return bool(unreal.EditorAssetLibrary.does_asset_exist(path))
    except Exception:
        return False

for item in targets:
    path = item.get("p") or ""
    action = item.get("a") or "modified"
    if not path:
        continue

    try:
        present = unreal.EditorAssetLibrary.does_asset_exist(path)
    except Exception as err:
        add(path, "check-failed", str(err))
        continue

    if action == "deleted":
        if present:
            add(path, "still-there")
        elif registry is not None and dep_options is not None:
            try:
                alive = []
                for ref in registry.get_referencers(path, dep_options):
                    ref_path = str(ref)
                    if ref_path.startswith(SKIP_ROOTS):
                        continue
                    if exists(ref_path):
                        alive.append(ref_path)
                if alive:
                    add(path, "orphan-referencer", ", ".join(alive[:5]))
            except Exception:
                pass
        continue

    if not present:
        add(path, "missing")
        continue

    asset = None
    try:
        asset = unreal.EditorAssetLibrary.load_asset(path)
    except Exception:
        asset = None

    if asset is not None:
        try:
            pkg = asset.get_outer()
            if pkg is not None and hasattr(pkg, "is_dirty") and pkg.is_dirty():
                add(path, "unsaved")
        except Exception:
            pass

        try:
            if isinstance(asset, unreal.Blueprint):
                status = asset.get_editor_property("status")
                if status == unreal.BlueprintStatus.BS_ERROR:
                    add(path, "compile-error")
                elif status == unreal.BlueprintStatus.BS_UP_TO_DATE_WITH_WARNINGS:
                    add(path, "compile-warning")
        except Exception:
            pass

    if registry is not None and dep_options is not None:
        try:
            broken = []
            for dep in registry.get_dependencies(path, dep_options):
                dep_path = str(dep)
                if dep_path.startswith(SKIP_ROOTS):
                    continue
                if not exists(dep_path):
                    broken.append(dep_path)
            if broken:
                add(path, "broken-dependency", ", ".join(broken[:5]))
        except Exception:
            pass

output_data = {"findings": findings}
`
}

export interface ReviewDeps {
  /** 注入点：测试不连引擎 */
  runPython?: (
    script: string,
    description: string,
    timeoutMs?: number
  ) => Promise<EditorPythonResult>
}

/**
 * 审查这一轮改过的资产。
 *
 * 引擎没连上不算失败 —— 静态那一半照常返回，`engineChecked: false` 让界面
 * 把话说明白。真正的失败只有一种：一个能查的目标都没有。
 */
export async function reviewChanges(
  targets: AgentReviewTarget[],
  deps: ReviewDeps = {}
): Promise<AgentReviewResult> {
  const normalized = normalizeReviewTargets(targets ?? [])
  const naming = reviewNaming(normalized)

  if (normalized.length === 0) {
    return { success: true, checked: 0, findings: [], engineChecked: false }
  }

  const run = deps.runPython ?? runEditorPython
  let engineResult: EditorPythonResult
  try {
    engineResult = await run(
      buildScript(normalized),
      `审查 ${normalized.length} 个资产`,
      // 每个资产都要 load 一次再遍历依赖，给足两分钟
      120_000
    )
  } catch (error) {
    engineResult = { success: false, error: (error as Error).message }
  }

  if (!engineResult.success) {
    return {
      success: true,
      checked: normalized.length,
      findings: sortFindings(naming),
      engineChecked: false,
      engineError: engineResult.error || '引擎检查没有跑成'
    }
  }

  const engine = parseEngineFindings(engineResult.output)
  return {
    success: true,
    checked: normalized.length,
    findings: sortFindings([...engine.findings, ...naming]),
    engineChecked: true
  }
}

/** 先按严重程度，再按资产路径 —— 同一个资产的问题挨在一起 */
function sortFindings(findings: AgentReviewFinding[]): AgentReviewFinding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = REVIEW_SEVERITY_ORDER[a.severity] - REVIEW_SEVERITY_ORDER[b.severity]
    return bySeverity !== 0 ? bySeverity : a.target.localeCompare(b.target)
  })
}
