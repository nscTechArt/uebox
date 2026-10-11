// Vendored from @earendil-works/pi-agent-core 0.84.3 (packages/agent/src/harness/tools/path-utils.ts).
// Copyright (c) 2025 Mario Zechner. MIT License, see LICENSE in this directory.
// pi 1.0 removed the harness; kept here unchanged apart from import paths and formatting.

import type { ExecutionEnv } from '../types'
import { getOrThrow } from '../types'

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
const NARROW_NO_BREAK_SPACE = '\u202F'

function normalizeToolPath(path: string): string {
  const normalized = path.replace(UNICODE_SPACES, ' ')
  return normalized.startsWith('@') ? normalized.slice(1) : normalized
}

export async function resolveToolPath(
  env: ExecutionEnv,
  path: string,
  signal?: AbortSignal
): Promise<string> {
  return getOrThrow(await env.absolutePath(normalizeToolPath(path), signal))
}

export async function resolveReadToolPath(
  env: ExecutionEnv,
  path: string,
  signal?: AbortSignal
): Promise<string> {
  const resolved = await resolveToolPath(env, path, signal)
  const variants = [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
    resolved.normalize('NFD'),
    resolved.replace(/'/g, '\u2019'),
    resolved.normalize('NFD').replace(/'/g, '\u2019')
  ]

  for (const variant of new Set(variants)) {
    if (getOrThrow(await env.exists(variant, signal))) return variant
  }
  return resolved
}
