import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'

const trackedFiles = execFileSync('git', ['ls-files', '-z'])
  .toString('utf8')
  .split('\0')
  .filter(Boolean)

const patterns = [
  {
    name: 'AWS access key ID',
    expression: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g
  },
  {
    name: 'Hard-coded cloud credential',
    expression:
      /\b(?:accessKeyId|secretAccessKey|aws_access_key_id|aws_secret_access_key)\b\s*[:=]\s*(['"`])([^'"`\r\n]{16,})\1/gi,
    valueGroup: 2
  },
  {
    name: 'Private key',
    expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
  },
  {
    name: 'OpenAI API key',
    expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g
  },
  {
    name: 'GitHub token',
    expression: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g
  },
  {
    name: 'Google API key',
    expression: /\bAIza[A-Za-z0-9_-]{35}\b/g
  },
  {
    name: 'Stripe live secret',
    expression: /\bsk_live_[A-Za-z0-9]{16,}\b/g
  }
]

const placeholderPattern =
  /^(?:your[_-]|example|placeholder|replace[_-]?me|change[_-]?me|test[_-])/i
const findings = []

/**
 * 超过这个大小的文件不读。
 *
 * 原来是无条件 readFileSync：仓库里被误提交过一个 3.7GB 的 app.asar，
 * 于是 node 直接抛 ERR_FS_FILE_TOO_LARGE（Buffer 上限 2GiB），
 * **整个密钥扫描一个文件都没扫就崩了** —— 门禁第一步永远过不去。
 * 崩掉比漏掉严重得多：漏的是一个二进制包，崩的是全部源码。
 *
 * 16MB 对源码来说绰绰有余（本仓库最大的文本文件两个数量级都不到），
 * 比这大的实际上全是构建产物和二进制，它们本来也会被下面那道 NUL 检查跳过。
 * 跳过的文件会在结尾报数，不做成静默的洞。
 */
const MAX_SCAN_BYTES = 16 * 1024 * 1024
const skipped = []

for (const file of trackedFiles) {
  if (!existsSync(file) || !statSync(file).isFile()) continue

  if (statSync(file).size > MAX_SCAN_BYTES) {
    skipped.push(file)
    continue
  }

  const buffer = readFileSync(file)
  if (buffer.includes(0)) continue
  const content = buffer.toString('utf8')

  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0
    for (const match of content.matchAll(pattern.expression)) {
      const candidate = pattern.valueGroup ? match[pattern.valueGroup] : ''
      if (candidate && placeholderPattern.test(candidate)) continue

      const line = content.slice(0, match.index).split('\n').length
      findings.push({ file, line, name: pattern.name })
    }
  }
}

if (findings.length > 0) {
  console.error('Potential secrets found in tracked files:')
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} (${finding.name})`)
  }
  console.error('Remove the secret from source and rotate it before committing.')
  process.exit(1)
}

if (skipped.length > 0) {
  console.warn(
    `Skipped ${skipped.length} tracked file(s) over 16MB (build artifacts should not be committed):`
  )
  for (const file of skipped) console.warn(`- ${file}`)
}

console.log(`Secret scan passed (${trackedFiles.length - skipped.length} tracked files checked).`)
