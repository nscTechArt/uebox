// Vendored from @earendil-works/pi-agent-core 0.84.3 (packages/agent/src/harness/tools/tool-context.ts).
// Copyright (c) 2025 Mario Zechner. MIT License, see LICENSE in this directory.
// pi 1.0 removed the harness; kept here unchanged apart from import paths and formatting.

import type { ExecutionEnv } from '../types'

/** Filesystem and shell context required by the built-in execution tools. */
export interface ExecutionToolContext {
  env: ExecutionEnv
}
