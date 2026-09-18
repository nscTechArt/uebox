import { getFocusContext } from '../../../core/focusContext'

type BlueprintPathSource = 'explicit' | 'current_context' | 'context_match'

/**
 * 候选蓝图。
 *
 * V2 从 ContextManager 的 per-session 黑板里翻这些；V3 直接问引擎
 * （见 core/focusContext.ts 的说明：黑板会过期，而「当前开着什么」
 * 是引擎状态，与哪个会话在问无关）。
 */
interface BlueprintCandidate {
  path: string
  /** 资产名。模糊匹配主要靠它 */
  name: string
}

export interface ResolvedBlueprintPath {
  blueprintPath?: string
  originalInput?: string
  source: BlueprintPathSource
  wasPlaceholder: boolean
}

const CURRENT_BLUEPRINT_TOKENS = new Set([
  'current',
  'currentblueprint',
  'activeblueprint',
  'focusedblueprint',
  '当前',
  '当前蓝图',
  '当前打开蓝图',
  '当前打开的蓝图'
])

function sanitizeBlueprintPath(value?: string | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^['"]+|['"]+$/g, '')
  return trimmed.length > 0 ? trimmed : undefined
}

export function isCurrentBlueprintPlaceholder(value?: string | null): boolean {
  const sanitized = sanitizeBlueprintPath(value)
  if (!sanitized) return true

  const normalized = sanitized.toLowerCase().replace(/[\s_-]+/g, '')
  return CURRENT_BLUEPRINT_TOKENS.has(normalized)
}

function isShortBlueprintIdentifier(value: string): boolean {
  return !value.startsWith('/') && !value.includes('/')
}

function normalizeBlueprintIdentifier(value: string): string {
  return value.toLowerCase().replace(/[\s_.-]+/g, '')
}

function extractBlueprintPathVariants(path: string): string[] {
  const trimmed = path.trim().replace(/^['"]+|['"]+$/g, '')
  if (!trimmed) return []

  const lastSegment = trimmed.split('/').pop() || trimmed
  const packageName = lastSegment.split('.')[0] || lastSegment

  return Array.from(new Set([trimmed, lastSegment, packageName].filter(Boolean)))
}

/**
 * 在候选里按名字模糊匹配。
 *
 * 用户常常只说资产名（`BP_Player`）而不给完整路径，甚至写成 `BP-Player`。
 * 保留这段打分逻辑 —— 它有独立测试覆盖，是实打实的易用性。
 */
export function pickBestBlueprintCandidate<T extends BlueprintCandidate>(
  query: string,
  candidates: T[]
): T | undefined {
  const normalizedQuery = query.toLowerCase()
  const normalizedQueryIdentifier = normalizeBlueprintIdentifier(query)

  const scored = candidates
    .map((asset) => {
      const name = asset.name.toLowerCase()
      let score = -1

      if (name === normalizedQuery) {
        score = 100
      } else if (normalizeBlueprintIdentifier(asset.name) === normalizedQueryIdentifier) {
        score = 99
      } else {
        const pathVariants = extractBlueprintPathVariants(asset.path)
        for (const variant of pathVariants) {
          const normalizedVariant = variant.toLowerCase()
          if (normalizedVariant === normalizedQuery) {
            score = Math.max(score, 98)
            continue
          }

          if (normalizeBlueprintIdentifier(variant) === normalizedQueryIdentifier) {
            score = Math.max(score, 97)
          }
        }
      }

      return { asset, score }
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      // 同分时保持传入顺序。V2 这里比 timestamp（黑板记的最近使用时间），
      // V3 的候选顺序本身就是优先级：聚焦的编辑器在最前，其次才是其他已打开的。
      // Array.prototype.sort 是稳定的，返回 0 即保序。
      return 0
    })

  return scored[0]?.asset
}

export async function resolveBlueprintPathInput(
  rawInput?: string | null
): Promise<ResolvedBlueprintPath> {
  const originalInput = sanitizeBlueprintPath(rawInput)
  const wasPlaceholder = isCurrentBlueprintPlaceholder(originalInput)

  if (originalInput && !wasPlaceholder && !isShortBlueprintIdentifier(originalInput)) {
    return {
      blueprintPath: originalInput,
      originalInput,
      source: 'explicit',
      wasPlaceholder: false
    }
  }

  // 直接问引擎当前开着什么，不再走会过期的黑板缓存
  const focus = await getFocusContext()
  const candidates: BlueprintCandidate[] = []
  if (focus.focusedEditor?.type === 'blueprint' && focus.focusedEditor.path) {
    candidates.push({
      path: focus.focusedEditor.path,
      name: focus.focusedEditor.name ?? focus.focusedEditor.path
    })
  }
  for (const editor of focus.openEditors ?? []) {
    if (editor.type === 'blueprint' && editor.path) {
      candidates.push({ path: editor.path, name: editor.name ?? editor.path })
    }
  }

  if (wasPlaceholder) {
    // 焦点优先：candidates[0] 就是当前聚焦的那个
    return {
      blueprintPath: candidates[0]?.path,
      originalInput,
      source: 'current_context',
      wasPlaceholder: true
    }
  }

  if (originalInput) {
    const matched = pickBestBlueprintCandidate(originalInput, candidates)
    if (matched) {
      return {
        blueprintPath: matched.path,
        originalInput,
        source: 'context_match',
        wasPlaceholder: false
      }
    }
  }

  return {
    blueprintPath: originalInput,
    originalInput,
    source: 'explicit',
    wasPlaceholder: false
  }
}
