export const AGENT_EMPTY_RESPONSE_TEXT =
  '\u62b1\u6b49\uff0c\u6211\u6ca1\u6709\u751f\u6210\u6709\u6548\u7684\u56de\u590d\u3002\u8bf7\u5c1d\u8bd5\u91cd\u65b0\u63cf\u8ff0\u60a8\u7684\u95ee\u9898\u3002'

export const AGENT_EMPTY_RESPONSE_ECHO_TEXT =
  '\u68c0\u6d4b\u5230\u4e0a\u4e00\u8f6e\u7684\u7cfb\u7edf\u517c\u5bb9\u63d0\u793a\u88ab\u5f53\u6210\u4e86\u65b0\u95ee\u9898\u3002\u8bf7\u76f4\u63a5\u8f93\u5165\u4f60\u771f\u6b63\u60f3\u95ee\u7684\u5185\u5bb9\u3002'

const TRAILING_DECORATION_RE =
  /[!\uFF01?\uFF1F~\uFF5E\u3002,.\uff0c\u3001:\uFF1A;\uFF1B"'`\u201c\u201d\u2018\u2019()\[\]{}<>]+$/g

function normalizeFastPathInput(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, '').replace(TRAILING_DECORATION_RE, '')
}

export function isEchoedAgentFallbackInput(input: unknown): boolean {
  if (typeof input !== 'string') {
    return false
  }

  return normalizeFastPathInput(input) === normalizeFastPathInput(AGENT_EMPTY_RESPONSE_TEXT)
}
