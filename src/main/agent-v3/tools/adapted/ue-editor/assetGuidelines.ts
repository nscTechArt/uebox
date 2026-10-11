/**
 * ue_asset_guidelines —— 资产自带的「使用说明」（UAssetGuideline）：查、修。
 *
 * CitySample 这类资产包里夹着说明，写着「用我的工程得开虚拟纹理、开 16 位骨骼索引……」。
 * 编辑器加载到它就和工程设置比一遍，对不上弹「缺失项目设置！」，一张说明一个框，
 * 点「忽略」下次打开照弹。用户看到的是三个框和一堆 r.xxx。
 *
 * 这里把同一件事交给 Agent：
 * - check：插件找出说明（给了目录就先扫包头，只加载提到说明的包），逐项和工程比
 * - apply：没满足的工程设置按说明原样写进工程的 Default*.ini 并读回；要开的插件走
 *   system.manage_plugin（也回读 .uproject）；最后再 check 一遍，报现在的样子
 *
 * 改的是整个工程的设置、要重启才生效，所以 apply 是 destructive（每次都问用户）。
 * 不提供「移除指南」：那会改用户的资产文件。
 */

import { z } from 'zod'

import { defineTool, type ToolOutcome } from '../../defineTool'
import { callUe, callUeRaw } from '../../defineUeTool'
import { PLUGIN_UPDATE_HINT } from '../project/pluginUpdateHint'

// ────────────────────────────────────────────────────────────────────────────
// 插件回包
// ────────────────────────────────────────────────────────────────────────────

export type GuidelineSettingStatus = 'ok' | 'missing' | 'pending_restart' | 'unchecked' | 'bad_file'
export type GuidelinePluginStatus = 'ok' | 'missing' | 'pending_restart' | 'not_installed'

export interface GuidelineSetting {
  section: string
  key: string
  required: string
  file: string
  /** 工程那份 ini 里现在写的；没有这一项就是没设 */
  current?: string
  /** 引擎此刻跑着的控制台变量值 */
  live?: string
  status: GuidelineSettingStatus
}

export interface GuidelinePlugin {
  name: string
  friendly_name: string
  status: GuidelinePluginStatus
}

export interface Guideline {
  name: string
  /** 说明所在的包：蓝图说明是它自己，挂在资产上的是那个资产 */
  asset: string
  class: string
  settings: GuidelineSetting[]
  plugins: GuidelinePlugin[]
}

export interface GuidelineCheckResponse {
  guidelines: Guideline[]
  unmet_settings: number
  unmet_plugins: number
  pending_restart: number
  scanned_packages: number
  unreadable_packages?: number
  candidate_packages?: string[]
  load_failed?: string[]
  bad_paths?: string[]
  truncated?: boolean
  /** 5.3 起插件加载可疑包时能让引擎不弹框；更老的引擎加载时会照样弹 */
  popups_suppressed_while_loading?: boolean
}

export interface GuidelineApplyResponse {
  results: Array<{
    guideline: string
    section: string
    key: string
    required: string
    file: string
    result: 'written' | 'failed' | 'conflict'
    on_disk?: string
    error?: string
  }>
  plugins_to_enable: Array<{
    name: string
    friendly_name: string
    status: 'missing' | 'not_installed'
    guideline: string
  }>
  written_count: number
  failed_count: number
  guidelines_matched: number
  restart_required: boolean
}

export interface PluginEnableResult {
  name: string
  friendly_name: string
  ok: boolean
  error?: string
}

// ────────────────────────────────────────────────────────────────────────────
// 给模型的文字
// ────────────────────────────────────────────────────────────────────────────

const isUnmetSetting = (s: GuidelineSetting): boolean =>
  s.status === 'missing' || s.status === 'bad_file'
const isUnmetPlugin = (p: GuidelinePlugin): boolean =>
  p.status === 'missing' || p.status === 'not_installed'

function describeSetting(s: GuidelineSetting): string {
  const what = `[${s.section}] ${s.key} = ${s.required}`
  switch (s.status) {
    case 'missing':
      return `${what}（现在${s.current === undefined ? '没设' : `是 ${s.current}`}）`
    case 'pending_restart':
      return `${what}（已写进工程，重启编辑器后生效）`
    case 'bad_file':
      return `${what}（说明指定的配置文件 ${s.file} 不是工程 Config 下的 Default*.ini，没法自动改）`
    default:
      return what
  }
}

function describePlugin(p: GuidelinePlugin): string {
  const name =
    p.friendly_name && p.friendly_name !== p.name ? `${p.friendly_name}（${p.name}）` : p.name
  switch (p.status) {
    case 'missing':
      return `插件 ${name} 没开`
    case 'not_installed':
      return `插件 ${name} 本机没装。Fab / 付费插件请用户自己装；免费开源的可经用户同意拷进工程 Plugins 目录`
    case 'pending_restart':
      return `插件 ${name} 已在工程里开启，重启编辑器后生效`
    default:
      return `插件 ${name}`
  }
}

/** 每张说明一段：哪个资产要求的、缺什么。没缺的说明不列 */
function describeGuidelines(guidelines: Guideline[], include: 'unmet' | 'pending'): string[] {
  const lines: string[] = []
  for (const g of guidelines) {
    const settings = g.settings.filter((s) =>
      include === 'unmet' ? isUnmetSetting(s) : s.status === 'pending_restart'
    )
    const plugins = g.plugins.filter((p) =>
      include === 'unmet' ? isUnmetPlugin(p) : p.status === 'pending_restart'
    )
    if (settings.length === 0 && plugins.length === 0) continue
    lines.push(`- ${g.name}（来自 ${g.asset}）：`)
    for (const s of settings) lines.push(`    ${describeSetting(s)}`)
    for (const p of plugins) lines.push(`    ${describePlugin(p)}`)
  }
  return lines
}

/** 给模型的判断依据和下一步。导入回执和 check 共用 */
const NEXT_STEP =
  '这些是整个工程的设置，不是只影响这几个资产；改完要重启编辑器才生效，部分渲染设置重启后会重新编译着色器，第一次打开要多等一阵。' +
  '不改的话这些资产可能显示不正常，而且编辑器每次打开都会弹「缺失项目设置」。' +
  '用大白话告诉用户：哪些资产要求的、不改会怎样、改了的代价，并给出建议（用户导入它们就是要用，一般应该改）；' +
  '用户同意后调 ue_asset_guidelines(action="apply")（不在当前工具列表里就先 search_tools(names=["ue_asset_guidelines"]) 加载），再调 ue_restart_editor。' +
  '不要建议点编辑器弹框里的「移除指南」——那会改用户的资产文件。'

export function summarizeGuidelineCheck(
  res: GuidelineCheckResponse,
  scannedPaths?: string[]
): string {
  const unmet = describeGuidelines(res.guidelines, 'unmet')
  const pending = describeGuidelines(res.guidelines, 'pending')
  const lines: string[] = []

  if (unmet.length > 0) {
    lines.push(
      `有 ${res.unmet_settings} 项工程设置、${res.unmet_plugins} 个插件没满足资产自带的「资产指南」要求：`,
      ...unmet,
      NEXT_STEP
    )
  } else if (res.guidelines.length === 0) {
    lines.push(
      scannedPaths && scannedPaths.length > 0
        ? `扫了 ${res.scanned_packages} 个包，没有资产带「资产指南」。`
        : '编辑器里已加载的资产都没带「资产指南」。要查刚导入、还没打开过的资产，传 paths。'
    )
  } else {
    lines.push(`${res.guidelines.length} 张「资产指南」的要求都已写进工程。`)
  }

  if (pending.length > 0) {
    lines.push('已经写好、等重启编辑器生效的：', ...pending)
  }
  if (res.truncated) {
    lines.push('⚠️ 包太多，只扫了一部分（上限），没扫到的目录可以分开再查。')
  }
  if (res.bad_paths && res.bad_paths.length > 0) {
    lines.push(`⚠️ 这些路径在工程里不存在：${res.bad_paths.join('、')}`)
  }
  if (res.load_failed && res.load_failed.length > 0) {
    lines.push(`⚠️ 这些包提到了资产指南但加载失败，没读到要求：${res.load_failed.join('、')}`)
  }
  if (scannedPaths && scannedPaths.length > 0 && res.popups_suppressed_while_loading === false) {
    lines.push('（这个引擎版本加载资产时会照样弹「缺失项目设置」框，那是同一件事，不用另外处理。）')
  }
  return lines.join('\n')
}

/**
 * 导入完要扫哪些目录：每个资产取 /Game 下第一层目录。
 *
 * 指南往往不在资产自己那个目录里 —— CitySample 的车在 /Game/CitySampleVehicles/vehicle01/，
 * 指南在 /Game/CitySampleVehicles/AssetGuidelines/，是作为依赖一起拷进来的。
 * 直接放在 /Game 根下的资产只扫它自己，不扫整个工程。
 */
export function guidelineScanRoots(uePaths: string[]): string[] {
  const roots = new Set<string>()
  for (const raw of uePaths) {
    const uePath = raw.replace(/\\/g, '/').split('.')[0]
    if (!uePath.startsWith('/Game/')) continue
    const parts = uePath.split('/').filter(Boolean)
    if (parts.length >= 3) roots.add(`/${parts[0]}/${parts[1]}`)
    else if (parts.length === 2) roots.add(uePath)
  }
  return Array.from(roots)
}

/** 导入回执里的那一行。没东西要说就给 null，不往回执里塞「一切正常」 */
export function describeGuidelinesForImport(res: GuidelineCheckResponse): string | null {
  const unmet = describeGuidelines(res.guidelines, 'unmet')
  if (unmet.length > 0) {
    return [
      `⚠️ 导入的资产自带「资产指南」，要求的 ${res.unmet_settings} 项工程设置、${res.unmet_plugins} 个插件当前工程没满足：`,
      ...unmet,
      NEXT_STEP
    ].join('\n')
  }
  const pending = describeGuidelines(res.guidelines, 'pending')
  if (pending.length > 0) {
    return ['ℹ️ 资产指南要求的设置已写进工程，重启编辑器后生效：', ...pending].join('\n')
  }
  return null
}

export function summarizeGuidelineApply(
  apply: GuidelineApplyResponse,
  plugins: PluginEnableResult[],
  after?: GuidelineCheckResponse
): string {
  const pluginOk = plugins.filter((p) => p.ok).length
  const okCount = apply.written_count + pluginOk
  const failCount = apply.failed_count + (plugins.length - pluginOk)
  const lines: string[] = []

  if (okCount === 0 && failCount === 0) {
    lines.push(
      apply.guidelines_matched === 0
        ? '编辑器里没有已加载的「资产指南」。先用 ue_asset_guidelines(action="check", paths=[...]) 把刚导入的资产查一遍。'
        : '没有需要改的：「资产指南」要求的设置都已经写进工程了。'
    )
  } else {
    lines.push(`${okCount} 项已改好 / ${failCount} 项失败。`)
  }

  for (const r of apply.results) {
    if (r.result === 'written') {
      lines.push(
        `✅ [${r.section}] ${r.key} = ${r.on_disk ?? r.required}（${r.file}，已从磁盘读回）`
      )
    } else if (r.result === 'conflict') {
      lines.push(
        `❌ [${r.section}] ${r.key}：两张指南要的值不一样（${r.guideline} 要 ${r.required}，${r.error ?? ''}），没改，要问用户用哪个`
      )
    } else {
      lines.push(`❌ [${r.section}] ${r.key} = ${r.required}：${r.error ?? '没写进去'}`)
    }
  }
  for (const p of plugins) {
    const name =
      p.friendly_name && p.friendly_name !== p.name ? `${p.friendly_name}（${p.name}）` : p.name
    lines.push(p.ok ? `✅ 已在工程里开启插件 ${name}` : `❌ 插件 ${name}：${p.error ?? '没开成'}`)
  }

  if (okCount > 0) {
    lines.push(
      '这些设置要重启编辑器才生效。告诉用户，问好之后调 ue_restart_editor（它会先提醒保存）。'
    )
  }
  if (after && after.unmet_settings + after.unmet_plugins > 0) {
    lines.push('改完再查，仍没满足的：', ...describeGuidelines(after.guidelines, 'unmet'))
  }
  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// 调插件
// ────────────────────────────────────────────────────────────────────────────

/** 扫目录要读几万个包头、加载可疑包，大素材包上要一阵 */
const CHECK_TIMEOUT_MS = 5 * 60 * 1000

/** 老插件没有这两条命令 —— 原文「Unknown method」对谁都没意义 */
function translateOldPlugin(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('Unknown method')) {
    throw new Error(
      '这个工程里装的虚幻盒子插件太旧，还不会检查「资产指南」。' +
        PLUGIN_UPDATE_HINT +
        '更新完再试；也可以让用户在编辑器弹框里点「启用缺失」，效果相同。'
    )
  }
  throw error
}

export async function checkAssetGuidelines(paths?: string[]): Promise<GuidelineCheckResponse> {
  try {
    return await callUe<GuidelineCheckResponse>(
      'project.check_asset_guidelines',
      paths && paths.length > 0 ? { paths } : {},
      { timeoutMs: CHECK_TIMEOUT_MS }
    )
  } catch (error) {
    return translateOldPlugin(error)
  }
}

async function enablePlugin(
  p: GuidelineApplyResponse['plugins_to_enable'][number]
): Promise<PluginEnableResult> {
  const base = { name: p.name, friendly_name: p.friendly_name }
  if (p.status === 'not_installed') {
    return {
      ...base,
      ok: false,
      error:
        '本机没装这个插件。Fab / 付费插件请用户自己装；免费开源的可经用户同意用 run_shell_command ' +
        '拷进工程 Plugins 目录，再调一次'
    }
  }
  try {
    const res = await callUeRaw<{
      ok?: boolean
      success?: boolean
      error?: string
      message?: string
    }>('system.manage_plugin', { plugin_name: p.name, action: 'Enable' }, { timeoutMs: 30_000 })
    if (res.ok === false || res.success === false) {
      return { ...base, ok: false, error: res.error || res.message || '编辑器没开成' }
    }
    return { ...base, ok: true }
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────────────────────

const Input = z.object({
  action: z
    .enum(['check', 'apply'])
    .describe(
      'check：查哪些资产指南没满足（只读）；apply：把没满足的设置写进工程、开插件（要用户同意）'
    ),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      'check 用：要扫的内容目录或资产，如 ["/Game/CitySampleVehicles"]。刚导入、没打开过的资产必须给，' +
        '不给只报编辑器里已加载的'
    ),
  names: z
    .array(z.string())
    .optional()
    .describe('apply 用：只修这几张指南（check 结果里的名字）。不给就修全部')
})

type Details = {
  check?: GuidelineCheckResponse
  apply?: GuidelineApplyResponse
  plugins?: PluginEnableResult[]
}

export const assetGuidelinesTool = defineTool<typeof Input, Details>({
  name: 'ue_asset_guidelines',
  namespace: 'ue.editor',
  risk: 'destructive',
  riskFor: (args) => (args.action === 'check' ? 'safe' : 'destructive'),
  concurrency: 'sequential',
  description: `资产自带的「资产指南」：查它要求的工程设置 / 插件有没有满足，没满足就一次改好。

编辑器弹「缺失项目设置！」「缺失插件！」（Missing Project Settings / Missing Plugins）就是它 ——
CitySample 等资产包要求工程开虚拟纹理、蒙皮缓存这类设置。

【check】只读。paths 给内容目录时先扫包头、只加载提到指南的包，刚拷进工程的资产也查得到。
【apply】按指南原样写进工程 Config/Default*.ini 并从磁盘读回；要开的插件写进 .uproject 并读回；
最后再查一遍。改的是整个工程、要重启编辑器才生效 —— 先跟用户说清楚、得到同意再调。

不做「移除指南」：那会改用户的资产文件。`,
  input: Input,
  execute: async (args): Promise<ToolOutcome<Details>> => {
    if (args.action === 'check') {
      const check = await checkAssetGuidelines(args.paths)
      return { text: summarizeGuidelineCheck(check, args.paths), details: { check } }
    }

    let apply: GuidelineApplyResponse
    try {
      apply = await callUe<GuidelineApplyResponse>(
        'project.apply_asset_guidelines',
        args.names && args.names.length > 0 ? { names: args.names } : {},
        { timeoutMs: 60_000 }
      )
    } catch (error) {
      return translateOldPlugin(error)
    }

    const plugins: PluginEnableResult[] = []
    for (const p of apply.plugins_to_enable ?? []) {
      plugins.push(await enablePlugin(p))
    }

    // 改完照引擎现在的样子再报一遍（AGENTS.md §5 第 14 条）。复查失败不影响上面已经读回的结果
    let after: GuidelineCheckResponse | undefined
    try {
      after = await checkAssetGuidelines()
    } catch {
      after = undefined
    }

    const text = summarizeGuidelineApply(apply, plugins, after)
    const anyOk = apply.written_count > 0 || plugins.some((p) => p.ok)
    const anyFail = apply.failed_count > 0 || plugins.some((p) => !p.ok)
    return {
      text,
      details: { apply, plugins, ...(after ? { check: after } : {}) },
      ...(anyFail && !anyOk ? { isError: true } : {})
    }
  }
})
