#!/usr/bin/env node
/**
 * 把插件分发包发到 GitHub Releases。
 *
 * ## 为什么不做成 CI
 *
 * GitHub 托管的 runner 编不了虚幻插件：每个引擎 50–100GB、装不下也没预装，
 * 光下载就超过作业时限，而且 UE 的授权不允许在公共 CI 上分发引擎。我们要
 * 覆盖 5.0–5.7 八个版本，等于八个引擎。这条路是死的。
 *
 * 自托管 runner 能做，但公开仓库挂自托管 runner 意味着任何人提 PR 都可能
 * 在你的机器上跑代码 —— 为了省一步上传引入这个面，不划算。
 *
 * 所以出包天生是本地的：引擎在维护者机器上，这个前提不会变。这个脚本只把
 * 「上传」那一步自动化。
 *
 * ## 默认只演练
 *
 * 发 Release 是**对外发布**，不可撤销地把文件挂到公开仓库上。所以默认
 * `--dry-run`：把要发什么、发到哪、多大，全部打印出来但不动网络。
 * 确认无误再加 `--publish`。
 *
 * ## 用法
 *
 *   node scripts/release-plugin.mjs                    # 演练，看看会发什么
 *   node scripts/release-plugin.mjs --publish          # 真发
 *   node scripts/release-plugin.mjs --tag v1.2.8       # 指定 tag（默认取 .uplugin 版本）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { checkStaleness, findExcludedEntries, sourceFingerprint } from './build-plugin.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE_DIR = join(ROOT, 'plugin', 'UnrealAgentLink')
const DIST_DIR = join(ROOT, 'resources', 'plugins')
const REPO = 'ueboxai/unreal-agent-link'
const API = 'https://api.github.com'

/**
 * 复用 git 已有的 GitHub 凭据。
 *
 * 比让维护者另配一个 `GITHUB_TOKEN` 好：少一份要保管的密钥，也少一次
 * 「配错了才发现」。凭据全程不落盘、不打印。
 */
function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN

  const result = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8'
  })
  if (result.status !== 0) return null

  const line = result.stdout.split('\n').find((l) => l.startsWith('password='))
  return line ? line.slice('password='.length).trim() : null
}

/** 插件自己声明的版本，作为默认 tag */
function pluginVersion() {
  const descriptor = join(SOURCE_DIR, 'UnrealAgentLink.uplugin')
  if (!existsSync(descriptor)) return null
  try {
    // .uplugin 带 BOM，JSON.parse 会噎住。
    // 用 \uFEFF 转义而不是把 BOM 字符直接写进正则 —— 那是个不可见字符，
    // 编辑器里看不出来，改代码的人很容易误删或误加一个
    return JSON.parse(readFileSync(descriptor, 'utf8').replace(/^\uFEFF/, '')).VersionName ?? null
  } catch {
    return null
  }
}

/**
 * 发之前必须全绿的检查。
 *
 * 每一条都对应一次真实踩过的坑，别删：
 *   - 包过期 → 用户装到七个月前的二进制
 *   - 包里混进 .pdb → 八个包从 39MB 涨到 150MB
 *   - 源码没推 → Release 里的二进制在仓库里找不到对应代码
 */
function preflight(zips) {
  const problems = []

  if (!existsSync(SOURCE_DIR)) {
    problems.push('没有插件源码，先跑 node scripts/build-plugin.mjs --sync')
    return problems
  }

  const fingerprint = sourceFingerprint()
  if (!checkStaleness(fingerprint)) {
    problems.push('分发包与源码对不上（见上面的明细）')
  }

  for (const zip of zips) {
    const leaked = findExcludedEntries(zip)
    if (leaked.length > 0) {
      problems.push(`${basename(zip)} 混进了 ${leaked.length} 个不该带的文件（${leaked[0]}）`)
    }
  }

  // 源码必须已经推上去：Release 挂的是二进制，对不上代码就没法追溯
  const status = spawnSync('git', ['-C', SOURCE_DIR, 'status', '--porcelain'], { encoding: 'utf8' })
  if (status.stdout?.trim()) {
    problems.push('插件源码有未提交的改动，先提交并推送')
  }
  const ahead = spawnSync('git', ['-C', SOURCE_DIR, 'log', '@{u}..HEAD', '--oneline'], {
    encoding: 'utf8'
  })
  if (ahead.stdout?.trim()) {
    problems.push(`插件源码有 ${ahead.stdout.trim().split('\n').length} 条提交还没推送`)
  }

  return problems
}

async function api(token, method, path, body, extraHeaders = {}) {
  const response = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extraHeaders
    },
    body
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : {}
}

async function publish(token, tag, zips, fingerprint) {
  const body = [
    `插件分发包，覆盖 UE 5.0–5.7。`,
    ``,
    `装哪个引擎就下哪一个，解压到 \`引擎目录/Engine/Plugins/UnrealAgentLink\`。`,
    `虚幻盒子会自动安装，手动装才需要下这里的包。`,
    ``,
    `源码指纹 \`${fingerprint}\` —— 每个包里的 \`.ual-build\` 都记着它，`,
    `可以用来确认拿到的包和这个 tag 的源码是同一份。`
  ].join('\n')

  let release
  try {
    release = await api(token, 'GET', `/repos/${REPO}/releases/tags/${tag}`)
    console.log(`  已存在同名 Release，复用：${release.html_url}`)
  } catch {
    release = await api(
      token,
      'POST',
      `/repos/${REPO}/releases`,
      JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false })
    )
    console.log(`  已创建 Release：${release.html_url}`)
  }

  const existing = new Set((release.assets ?? []).map((a) => a.name))
  for (const zip of zips) {
    const name = basename(zip)
    if (existing.has(name)) {
      console.log(`  跳过 ${name}（已存在）`)
      continue
    }
    const data = readFileSync(zip)
    const uploadUrl = release.upload_url.replace(/\{.*\}$/, `?name=${encodeURIComponent(name)}`)
    await api(token, 'POST', uploadUrl, data, { 'Content-Type': 'application/zip' })
    console.log(`  已上传 ${name}（${(data.length / 1024 / 1024).toFixed(2)} MB）`)
  }

  return release.html_url
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const willPublish = argv.includes('--publish')

  const version = pluginVersion()
  const tag = flag('tag') ?? (version ? `v${version}` : null)
  if (!tag) {
    console.error('✖ 取不到版本号，用 --tag 指定')
    process.exit(1)
  }

  const zips = readdirSync(DIST_DIR)
    .filter((f) => /^UnrealAgentLink\d+\.zip$/.test(f))
    .sort()
    .map((f) => join(DIST_DIR, f))

  if (!zips.length) {
    console.error(`✖ ${DIST_DIR} 里没有分发包，先跑 node scripts/build-all-plugins.mjs`)
    process.exit(1)
  }

  console.log(`仓库：${REPO}`)
  console.log(`tag ：${tag}${flag('tag') ? '' : `（取自 .uplugin 的 VersionName ${version}）`}`)
  console.log(`分发包：${zips.length} 个\n`)

  const problems = preflight(zips)
  if (problems.length > 0) {
    console.error('\n✖ 发布前检查未通过：')
    for (const p of problems) console.error(`  · ${p}`)
    process.exit(1)
  }

  console.log('\n将要上传：')
  let total = 0
  for (const zip of zips) {
    const size = statSync(zip).size
    total += size
    console.log(`  ${basename(zip).padEnd(28)} ${(size / 1024 / 1024).toFixed(2)} MB`)
  }
  console.log(`  ${'合计'.padEnd(26)} ${(total / 1024 / 1024).toFixed(2)} MB`)

  if (!willPublish) {
    console.log('\n这是演练，什么都没发。确认无误后加 --publish 真发。')
    return
  }

  const token = githubToken()
  if (!token) {
    console.error(
      '\n✖ 拿不到 GitHub 凭据。设置 GITHUB_TOKEN 环境变量，或先 git push 一次让凭据落地。'
    )
    process.exit(1)
  }

  console.log('\n开始发布…')
  const url = await publish(token, tag, zips, sourceFingerprint())
  console.log(`\n✓ 完成：${url}`)
}

main().catch((error) => {
  console.error(`\n✖ ${error.message}`)
  process.exit(1)
})
