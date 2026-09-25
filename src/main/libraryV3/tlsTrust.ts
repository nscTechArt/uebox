/**
 * 部署 CA 的固定（pinning）。
 *
 * ## 选了哪种做法，为什么
 *
 * 私有部署的服务端用的是自签的部署 CA（安装器生成，Lore 的 QUIC/TLS 也用它）。
 * 客户端要信任它，有两种常见做法：
 *
 * - **TOFU**（第一次见到就信，弹个指纹让用户点"确认"）：用户几乎不会真的去核对
 *   那串 64 位十六进制，点确认只是习惯动作。局域网里被人冒充一次，就把冒充者的 CA
 *   永久记住了。
 * - **按带外给的指纹比对**：管理员发邀请链接时带上部署 CA 的 SHA-256 指纹
 *   （设计 3.8：邀请链接 = 服务器地址 + CA 指纹 + 邀请码），或者直接给 CA 文件。
 *   客户端拿服务端出示的证书链逐张算指纹，**由程序比对**，对上了才固定这张 CA。
 *
 * 选后者。比对由程序做，不靠用户眼睛；没有指纹也没有 CA 文件时，只要系统信任库
 * 本来就能验证这张证书（公网证书、已装进系统的企业 CA）也可以连，否则直接拒绝，
 * 并告诉用户去找管理员要邀请链接或 CA 文件。固定的 CA 只对这一台主机生效
 * （每台服务器一个 https.Agent），不进系统信任库。
 */
import { X509Certificate, createHash } from 'node:crypto'
import tls from 'node:tls'
import { URL } from 'node:url'
import { normalizeFingerprint } from '../../shared/catalogLibrary'

export interface PresentedCertificate {
  subject: string
  issuer: string
  fingerprint256: string
  isCA: boolean
  pem: string
}

export interface ChainProbe {
  chain: PresentedCertificate[]
  /** 不额外信任任何东西时，系统信任库能否验证 */
  systemTrusted: boolean
  authorizationError: string | null
  /**
   * 证书上的名字对不上填的地址时，列出证书上的名字（"DNS:a.lan, IP Address:10.0.0.5"）；
   * 对得上为 null。指纹固定只证明"是这家部署的证书"，主机名照样要核对。
   */
  nameMismatch: string | null
}

function derToPem(der: Buffer): string {
  const base64 = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim()
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`
}

/** PEM（可以是一串）里第一张证书的 SHA-256 指纹 */
export function pemFingerprint(pem: string): string {
  const certificate = new X509Certificate(pem)
  return normalizeFingerprint(certificate.fingerprint256) as string
}

/** CA 文件是否真是一张 CA 证书 */
export function isCaPem(pem: string): boolean {
  try {
    return new X509Certificate(pem).ca
  } catch {
    return false
  }
}

/**
 * 连上去拿证书链，但**不**据此信任任何东西 —— 只是把链拿回来算指纹。
 * 真正的请求之后用固定的 CA 走标准校验（链 + 主机名）。
 */
export async function probeCertificateChain(
  address: string,
  timeoutMs = 8000
): Promise<ChainProbe> {
  const url = new URL(address)
  const port = Number(url.port || 443)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return await new Promise<ChainProbe>((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: /^[\d.:]+$/.test(host) ? undefined : host,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1']
    })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`No TLS answer from ${host}:${port} within ${timeoutMs} ms`))
    }, timeoutMs)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      const chain: PresentedCertificate[] = []
      const seen = new Set<string>()
      let current = socket.getPeerCertificate(true) as tls.DetailedPeerCertificate | null
      while (current && current.raw && !seen.has(current.fingerprint256)) {
        seen.add(current.fingerprint256)
        const pem = derToPem(current.raw)
        let isCA = false
        try {
          isCA = new X509Certificate(current.raw).ca
        } catch {
          isCA = false
        }
        chain.push({
          subject: formatName(current.subject),
          issuer: formatName(current.issuer),
          fingerprint256: normalizeFingerprint(current.fingerprint256) ?? '',
          isCA,
          pem
        })
        const next = current.issuerCertificate as tls.DetailedPeerCertificate | undefined
        if (!next || next === current) break
        current = next
      }
      const authorizationError = socket.authorizationError
        ? String(socket.authorizationError)
        : null
      const leaf = socket.getPeerCertificate()
      const identityError = leaf && leaf.raw ? tls.checkServerIdentity(host, leaf) : undefined
      const nameMismatch = identityError
        ? leaf.subjectaltname || (leaf.subject?.CN ? `CN=${leaf.subject.CN}` : '')
        : null
      socket.end()
      resolve({
        chain,
        systemTrusted: socket.authorized === true,
        authorizationError,
        nameMismatch
      })
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function formatName(name: tls.Certificate | undefined): string {
  if (!name) return ''
  const parts: string[] = []
  for (const key of ['CN', 'O', 'OU']) {
    const value = (name as unknown as Record<string, string | string[] | undefined>)[key]
    if (value) parts.push(`${key}=${Array.isArray(value) ? value.join('+') : value}`)
  }
  return parts.join(', ')
}

/**
 * 在服务端出示的链里找与给定指纹一致的那张 CA。
 * 服务端通常只发叶子 + 中间证书，根 CA 不一定在链里 —— 这时退到
 * `/.well-known/unreal-box` 返回的 caPem，同样要比对指纹。
 */
export function selectPinnedCa(
  chain: PresentedCertificate[],
  fingerprint: string,
  wellKnownCaPem?: string | null
): { pem: string; fingerprint256: string } | null {
  const wanted = normalizeFingerprint(fingerprint)
  if (!wanted) return null
  const fromChain = chain.find((certificate) => certificate.fingerprint256 === wanted)
  if (fromChain) return { pem: fromChain.pem, fingerprint256: wanted }
  if (wellKnownCaPem) {
    try {
      if (pemFingerprint(wellKnownCaPem) === wanted)
        return { pem: wellKnownCaPem, fingerprint256: wanted }
    } catch {
      return null
    }
  }
  return null
}

/** 给 lore.exe 的 SSL_CERT_FILE 用：CA 写成文件，文件名带指纹，内容不变就不重写 */
export function caFileName(fingerprint: string): string {
  return `deployment-ca-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}.pem`
}
