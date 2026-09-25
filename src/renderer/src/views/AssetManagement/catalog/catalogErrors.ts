/**
 * 主进程错误码 → 界面文案。认识的码给翻译好的一句话，不认识的给原文（服务端 / lore 的原话
 * 比一句"操作失败"有用）。
 */
type Translate = (key: string, values?: Record<string, unknown>) => string

const KNOWN = new Set([
  'invalid-address',
  'insecure-http',
  'insecure',
  'unreachable',
  'untrusted-certificate',
  'fingerprint-mismatch',
  'ca-file-not-ca',
  'ca-file-not-pem',
  'not-a-catalog',
  'no-member-surface',
  'missing-password',
  'missing-token',
  'signed-out',
  'unauthorized',
  'forbidden',
  'not-found',
  'route-missing',
  'network',
  'timeout',
  'tls',
  'unavailable',
  'throttled',
  'lore-missing',
  'no-lore-remote',
  'bad-remote'
])

/** 连不上的几种：文案里要带上"哪台机器的哪个端口"（或证书上的名字），用户好转给管理员 */
const WITH_TARGET = new Set([
  'port-blocked',
  'port-closed',
  'host-not-found',
  'host-unreachable',
  'cert-name-mismatch',
  'tls-handshake'
])

export function catalogErrorText(
  t: Translate,
  code: string | null | undefined,
  raw?: string | null
): string {
  if (code && WITH_TARGET.has(code)) {
    // 主进程给的是 "码: 对象"（探测）或直接是对象（其他调用）
    const text = raw ?? ''
    const target = text.startsWith(`${code}:`) ? text.slice(code.length + 1).trim() : text
    return t(`catalogLibrary.errors.${code}`, { target })
  }
  if (code && KNOWN.has(code)) {
    const base = t(`catalogLibrary.errors.${code}`)
    // 网络 / TLS 这几类把原话附上，便于用户转给管理员
    if (raw && ['unreachable', 'network', 'tls', 'lore-missing'].includes(code))
      return `${base}（${raw}）`
    return base
  }
  return raw || t('catalogLibrary.errors.unknown')
}

/** 界面里抛出来的 CatalogApiError（带 code）或普通 Error */
export function catalogErrorOf(t: Translate, error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  return catalogErrorText(t, typeof code === 'string' ? code : null, message)
}
