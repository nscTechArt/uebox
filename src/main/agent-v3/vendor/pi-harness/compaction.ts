/**
 * Context-compaction helpers vendored from @earendil-works/pi-agent-core 0.84.3
 * (packages/agent/src/harness/compaction/{compaction,utils}.ts and harness/messages.ts).
 * Copyright (c) 2025 Mario Zechner. MIT License, see ./LICENSE.
 *
 * pi 1.0 removed the harness, compaction included. Only the parts Unreal Box calls are kept,
 * and their behavior is unchanged:
 * - Session-entry helpers, file-operation tracking, and branch summaries are dropped.
 * - The harness-only message roles (bashExecution, custom, branchSummary, compactionSummary)
 *   are dropped from the estimator and converter; Unreal Box never produces them.
 * - System messages (new in pi 1.0) estimate as 0 and are not summarized, which is what the
 *   0.84.3 code did for any role it did not know.
 */

import {
  type Api,
  type AssistantMessage,
  type Context,
  contentText,
  type Message,
  type Model,
  type Models,
  type RetryCallbacks,
  type RetryPolicy,
  retryAssistantCall,
  type SimpleStreamOptions,
  type Usage,
  uuidv7
} from '@earendil-works/pi-ai'
import type { AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core'
import { err, ok, type Result } from './types'

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return '[unserializable]'
  }
}

export type CompactionErrorCode = 'aborted' | 'summarization_failed'

export class CompactionError extends Error {
  public code: CompactionErrorCode

  constructor(code: CompactionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CompactionError'
    this.code = code
  }
}

export async function completeSimpleWithRetries(
  models: Models,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  retry?: RetryPolicy,
  callbacks?: RetryCallbacks
): Promise<AssistantMessage> {
  // Summaries are standalone requests, so isolate routing and avoid cache writes that cannot be reused.
  const requestOptions: SimpleStreamOptions = {
    ...options,
    cacheRetention: 'none',
    sessionId: uuidv7()
  }
  return retryAssistantCall(
    () => models.completeSimple(model, context, requestOptions),
    retry,
    requestOptions.signal,
    callbacks
  )
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
  /** Enable automatic compaction decisions. */
  enabled: boolean
  /** Tokens reserved for summary prompt and output. */
  reserveTokens: number
  /** Approximate recent-context tokens to keep after compaction. */
  keepRecentTokens: number
}

/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000
}

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  if (msg.role === 'assistant' && 'usage' in msg) {
    const assistantMsg = msg as AssistantMessage
    if (
      assistantMsg.stopReason !== 'aborted' &&
      assistantMsg.stopReason !== 'error' &&
      assistantMsg.usage &&
      calculateContextTokens(assistantMsg.usage) > 0
    ) {
      return assistantMsg.usage
    }
  }
  return undefined
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
  /** Estimated total context tokens. */
  tokens: number
  /** Tokens reported by the most recent assistant usage block. */
  usageTokens: number
  /** Estimated tokens after the most recent assistant usage block. */
  trailingTokens: number
  /** Index of the message that provided usage, or null when none exists. */
  lastUsageIndex: number | null
}

function getLastAssistantUsageInfo(
  messages: AgentMessage[]
): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i])
    if (usage) return { usage, index: i }
  }
  return undefined
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages)

  if (!usageInfo) {
    let estimated = 0
    for (const message of messages) {
      estimated += estimateTokens(message)
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null
    }
  }

  const usageTokens = calculateContextTokens(usageInfo.usage)
  let trailingTokens = 0
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i])
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index
  }
}

const ESTIMATED_IMAGE_CHARS = 4800

function estimateTextAndImageContentChars(
  content: string | Array<{ type: string; text?: string }>
): number {
  if (typeof content === 'string') {
    return content.length
  }

  let chars = 0
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      chars += block.text.length
    } else if (block.type === 'image') {
      chars += ESTIMATED_IMAGE_CHARS
    }
  }
  return chars
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
  let chars = 0

  switch (message.role) {
    case 'user': {
      chars = estimateTextAndImageContentChars(
        (message as { content: string | Array<{ type: string; text?: string }> }).content
      )
      return Math.ceil(chars / 4)
    }
    case 'assistant': {
      const assistant = message as AssistantMessage
      for (const block of assistant.content) {
        if (block.type === 'text') {
          chars += block.text.length
        } else if (block.type === 'thinking') {
          chars += block.thinking.length
        } else if (block.type === 'toolCall') {
          chars += block.name.length + safeJsonStringify(block.arguments).length
        }
      }
      return Math.ceil(chars / 4)
    }
    case 'toolResult': {
      chars = estimateTextAndImageContentChars(message.content)
      return Math.ceil(chars / 4)
    }
  }

  return 0
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

/** Keep only the messages a summarizer can read (the harness converter, minus its custom roles). */
function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'
  )
}

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
  currentMessages: AgentMessage[],
  models: Models,
  model: Model<Api>,
  reserveTokens: number,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
  retry?: RetryPolicy,
  callbacks?: RetryCallbacks
): Promise<Result<string, CompactionError>> {
  const maxTokens = Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY
  )
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`
  }
  const llmMessages = convertToLlm(currentMessages)
  const conversationText = serializeConversation(llmMessages)
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
  }
  promptText += basePrompt

  const summarizationMessages = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: promptText }],
      timestamp: Date.now()
    }
  ]

  const completionOptions =
    model.reasoning && thinkingLevel && thinkingLevel !== 'off'
      ? { maxTokens, signal, reasoning: thinkingLevel }
      : { maxTokens, signal }

  const response = await completeSimpleWithRetries(
    models,
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
    completionOptions,
    retry,
    callbacks
  )
  if (response.stopReason === 'aborted') {
    return err(new CompactionError('aborted', response.errorMessage || 'Summarization aborted'))
  }
  if (response.stopReason === 'error') {
    return err(
      new CompactionError(
        'summarization_failed',
        `Summarization failed: ${response.errorMessage || 'Unknown error'}`
      )
    )
  }

  return ok(contentText(response.content))
}

const TOOL_RESULT_MAX_CHARS = 2000

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const truncatedChars = text.length - maxChars
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = contentText(msg.content, '')
      if (content) parts.push(`[User]: ${content}`)
    } else if (msg.role === 'assistant') {
      const thinkingParts: string[] = []
      const toolCalls: string[] = []

      for (const block of msg.content) {
        if (block.type === 'thinking') {
          thinkingParts.push(block.thinking)
        } else if (block.type === 'toolCall') {
          const args = block.arguments as Record<string, unknown>
          const argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
            .join(', ')
          toolCalls.push(`${block.name}(${argsStr})`)
        }
      }

      if (thinkingParts.length > 0) {
        parts.push(`[Assistant thinking]: ${thinkingParts.join('\n')}`)
      }
      if (msg.content.some((block) => block.type === 'text')) {
        parts.push(`[Assistant]: ${contentText(msg.content)}`)
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`)
      }
    } else if (msg.role === 'toolResult') {
      const content = contentText(msg.content, '')
      if (content) {
        parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`)
      }
    }
  }

  return parts.join('\n\n')
}
