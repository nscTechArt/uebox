/**
 * Error message formatter helpers.
 */
function extractServerPayload(
  errorMessage: string
): { code?: string; message?: string } | undefined {
  const httpMatch = errorMessage.match(/^HTTP\s+\d+\s*:\s*(.+)$/is)
  const rawBody = httpMatch?.[1]?.trim()
  if (!rawBody) return undefined

  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>
    const payload: { code?: string; message?: string } = {}

    if (typeof parsed.code === 'string') payload.code = parsed.code
    if (typeof parsed.message === 'string') payload.message = parsed.message
    if (typeof parsed.error === 'string' && !payload.code) payload.code = parsed.error
    if (parsed.error && typeof parsed.error === 'object') {
      const errorObj = parsed.error as Record<string, unknown>
      if (typeof errorObj.code === 'string' && !payload.code) payload.code = errorObj.code
      if (typeof errorObj.errorCode === 'string' && !payload.code) {
        payload.code = errorObj.errorCode
      }
      if (typeof errorObj.message === 'string' && !payload.message) {
        payload.message = errorObj.message
      }
      if (typeof errorObj.msg === 'string' && !payload.message) payload.message = errorObj.msg
    }

    return payload.code || payload.message ? payload : undefined
  } catch {
    return undefined
  }
}

/**
 * 余额不足类报错。
 *
 * 这里说的余额是**用户自己那家模型服务商**的余额，不是本应用的任何账户 ——
 * 公开核心没有应用内钱包，模型一律由用户自带 Key 直连。
 *
 * 判据要认这几种写法，因为各家措辞不一样：DeepSeek 回 `Insufficient Balance`、
 * OpenAI 回 `insufficient_quota`、还有一批国内厂商直接回中文「余额不足」。
 * 曾经这几条被当成本应用的计费错误，于是用户自己的 Key 欠费时，
 * 应用弹的是本应用的充值窗 —— 买一个跟欠费毫无关系的东西。
 */
function normalizeBusinessErrorMessage(
  code: string | undefined,
  message: string | undefined
): string | undefined {
  const normalizedCode = String(code || '').toLowerCase()
  const normalizedMessage = String(message || '').toLowerCase()
  const combined = `${normalizedCode} ${normalizedMessage}`

  if (
    combined.includes('insufficient_funds') ||
    combined.includes('insufficient_balance') ||
    combined.includes('insufficient balance') ||
    combined.includes('insufficient_quota') ||
    combined.includes('余额不足')
  ) {
    return '当前模型服务商返回「余额不足」。请到该服务商的控制台充值，或在 设置 → 模型 换一个可用的模型。'
  }

  return undefined
}

export function formatErrorMessage(
  errorMessage: string | undefined | null,
  fallbackMessage: string = '操作失败，请稍后再试'
): string {
  if (!errorMessage) {
    return fallbackMessage
  }

  const ipcInvokeMatch = errorMessage.match(/error invoking remote method '[^']+':\s*(.+)$/i)
  if (ipcInvokeMatch?.[1]) {
    return formatErrorMessage(ipcInvokeMatch[1], fallbackMessage)
  }

  const serverPayload = extractServerPayload(errorMessage)
  if (serverPayload) {
    const normalized = normalizeBusinessErrorMessage(serverPayload.code, serverPayload.message)
    if (normalized) return normalized
    if (serverPayload.message) return formatErrorMessage(serverPayload.message, fallbackMessage)
  }

  const lowerCaseMsg = errorMessage.toLowerCase()

  const normalizedBusinessMessage = normalizeBusinessErrorMessage(undefined, errorMessage)
  if (normalizedBusinessMessage) {
    return normalizedBusinessMessage
  }

  if (lowerCaseMsg === 'aggregateerror' || lowerCaseMsg.endsWith(': aggregateerror')) {
    return fallbackMessage
  }

  const aiActiveDevicePatterns = [
    'ai_active_device_limit_exceeded',
    '正在使用 ai 功能',
    '等待其他设备空闲后再继续'
  ]

  for (const pattern of aiActiveDevicePatterns) {
    if (lowerCaseMsg.includes(pattern.toLowerCase())) {
      return '当前已有其他设备正在使用 AI 功能，请稍后再试'
    }
  }

  const networkErrorPatterns = [
    'fetch failed',
    'network error',
    'networkerror',
    'failed to fetch',
    'econnrefused',
    'econnreset',
    'etimedout',
    'enotfound',
    'socket hang up',
    'connection refused',
    'connection reset',
    'network request failed',
    'net::err_'
  ]

  for (const pattern of networkErrorPatterns) {
    if (lowerCaseMsg.includes(pattern)) {
      return '网络请求错误，请稍后再试'
    }
  }

  return errorMessage
}

function extractServerErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const anyErr = error as { response?: { data?: unknown } }
  const data = anyErr.response?.data

  const extractFromObject = (obj: Record<string, unknown>): string | undefined => {
    if (typeof obj.message === 'string') return obj.message
    if (typeof obj.error === 'string') return obj.error
    if (obj.error && typeof obj.error === 'object') {
      const errorObj = obj.error as Record<string, unknown>
      if (typeof errorObj.message === 'string') return errorObj.message
      if (typeof errorObj.msg === 'string') return errorObj.msg
    }
    return undefined
  }

  if (data && typeof data === 'object') {
    return extractFromObject(data as Record<string, unknown>)
  }

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>
      return extractFromObject(parsed)
    } catch {
      return undefined
    }
  }

  return undefined
}

export function getServerErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const anyErr = error as { response?: { data?: unknown } }
  const data = anyErr.response?.data

  const extractCode = (obj: Record<string, unknown>): string | undefined => {
    if (typeof obj.error === 'string') return obj.error
    if (obj.error && typeof obj.error === 'object') {
      const errorObj = obj.error as Record<string, unknown>
      if (typeof errorObj.code === 'string') return errorObj.code
      if (typeof errorObj.errorCode === 'string') return errorObj.errorCode
    }
    if (typeof obj.code === 'string') return obj.code
    return undefined
  }

  if (data && typeof data === 'object') {
    return extractCode(data as Record<string, unknown>)
  }

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>
      return extractCode(parsed)
    } catch {
      return undefined
    }
  }

  return undefined
}

export function getFormattedErrorMessage(
  error: unknown,
  fallbackMessage: string = '操作失败，请稍后再试'
): string {
  const serverMessage = extractServerErrorMessage(error)
  if (serverMessage) {
    return formatErrorMessage(serverMessage, fallbackMessage)
  }

  let errorMessage: string | undefined
  if (error instanceof Error) {
    errorMessage = error.message
  } else if (typeof error === 'string') {
    errorMessage = error
  } else if (error && typeof error === 'object' && 'message' in error) {
    errorMessage = String((error as { message: unknown }).message)
  }

  return formatErrorMessage(errorMessage, fallbackMessage)
}
