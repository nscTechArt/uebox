#!/usr/bin/env node
/**
 * 把桌面端安装包发到 GitHub Releases —— 也就是「检查更新」读的那个源。
 *
 * ## 为什么不做成 GitHub Actions
 *
 * 跟 release-plugin.mjs 同一个理由，而且更硬：`pnpm build:win` 第一步就是
 * `plugin:build:all`，要八个引擎各编一遍；GitHub 托管的 runner 装不下，UE 的
 * 授权也不允许在公共 CI 上分发引擎。退一步说，就算跳过编插件，
 * `resources/plugins/*.zip` 根本没进 git（只有 ualink-config.json 进了），
 * runner 检出的工作区里没有这些包，`plugin:check:all` 当场就拦下来。
 *
 * 自托管 runner 能编，但公开仓库挂自托管 runner 等于任何人提个 PR 就能在维护者
 * 机器上跑代码。为省一步上传引入这个面，不划算。
 *
 * 所以出包天生是本地的，这个脚本只把「上传」那一步自动化。
 *
 * ## 为什么三个文件缺一不可
 *
 * electron-updater 的流程是：先拉 `latest.yml`，比版本号，再按里面记的文件名和
 * sha512 去下 `.exe`，用 `.blockmap` 做增量。少传 latest.yml 就是「永远没有更新」，
 * 少传 blockmap 是下载报错。这三个必须同时在，且必须是同一次构建出来的 ——
 * 所以下面会拿 latest.yml 里的 sha512 跟磁盘上的 exe 现算一遍对。
 *
 * ## 默认只演练
 *
 * 发 Release 是对外发布，不可撤销。默认 `--dry-run`：把要发什么、发到哪、多大
 * 全打印出来但不动网络，确认无误再加 `--publish`。
 *
 * ## 用法
 *
 *   node scripts/release-app.mjs                  # 演练
 *   node scripts/release-app.mjs --publish        # 真发
 *   node scripts/release-app.mjs --tag v0.2.3     # 指定 tag（默认取 package.json 版本）
 *   node scripts/release-app.mjs --notes 发版说明.md
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIST_DIR = join(ROOT, 'dist')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * 发到哪个仓库 = 包会去哪个仓库检查更新。
 *
 * 只认 package.json 的 updateGithubRepo，跟 build-win-installer.js 和运行期的
 * updateFeed.ts 读的是同一个字段。发布源和检查源必须同一个来源，不然就会出现
 * 「发到 A、装好的包去 B 找」这种查半天的错。
 */
function resolveRepo() {
  const raw = typeof pkg.updateGithubRepo === 'string' ? pkg.updateGithubRepo.trim() : ''
  if (!raw) return null
  return /^[\w.-]+\/[\w.-]+$/.test(raw) ? raw : undefined
}

/** 复用 git 已有的 GitHub 凭据，少一份要保管的密钥。全程不落盘、不打印 */
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

/** electron-updater 记的是 base64 的 sha512，不是十六进制 */
function sha512(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

/**
 * 从 latest.yml 里挖出 version / path / sha512。
 *
 * 不引 yaml 依赖：这个文件是 electron-builder 生成的，结构固定且只读这三个字段，
 * 为它多一个生产外的依赖不值。真要变了，下面的检查会直接报「读不出」而不是静悄悄
 * 放过去。
 */
function parseLatestYml(file) {
  const text = readFileSync(file, 'utf8')
  const pick = (key) => {
    const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)
    return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : undefined
  }
  return { version: pick('version'), path: pick('path'), sha512: pick('sha512') }
}

/**
 * 发之前必须全绿的检查。
 *
 * 每一条都对应一种「发出去才发现」的事故，别删：
 *   - 版本对不上 → 用户点检查更新，提示的版本跟装上的不是一个
 *   - sha512 对不上 → 下载完校验失败，更新永远卡在最后一步
 *   - 源码没推 → Release 里的二进制在仓库里找不到对应代码
 */
function preflight(files, latest, tag) {
  const problems = []

  if (latest.version !== pkg.version) {
    problems.push(
      `latest.yml 写的是 ${latest.version}，package.json 是 ${pkg.version} —— dist 里是上一次构建的残留，重新跑 pnpm build:win`
    )
  }
  if (tag !== `v${pkg.version}`) {
    problems.push(
      `tag ${tag} 跟版本号 v${pkg.version} 对不上；electron-updater 按 latest.yml 认版本，tag 不一致只会让人对不上账`
    )
  }

  const installer = files.find((f) => basename(f) === latest.path)
  if (!installer) {
    problems.push(`latest.yml 指名要 ${latest.path}，但 dist 里没有`)
  } else {
    const actual = sha512(installer)
    if (actual !== latest.sha512) {
      problems.push(`${latest.path} 跟 latest.yml 记的 sha512 对不上，两者不是同一次构建的产物`)
    }
    if (!existsSync(`${installer}.blockmap`)) {
      problems.push(`缺 ${latest.path}.blockmap，装好的旧版本下载更新时会报错`)
    }
  }

  const status = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' })
  if (status.stdout?.trim()) {
    problems.push('仓库有未提交的改动，先提交并推送')
  }
  const ahead = spawnSync('git', ['-C', ROOT, 'log', '@{u}..HEAD', '--oneline'], {
    encoding: 'utf8'
  })
  if (ahead.stdout?.trim()) {
    problems.push(`有 ${ahead.stdout.trim().split('\n').length} 条提交还没推送`)
  }

  return problems
}

async function api(token, method, path, body, extraHeaders = {}) {
  const response = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
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

async function publish(token, repo, tag, files, notes) {
  let release
  try {
    release = await api(token, 'GET', `/repos/${repo}/releases/tags/${tag}`)
    console.log(`  已存在同名 Release，复用：${release.html_url}`)
  } catch {
    release = await api(
      token,
      'POST',
      `/repos/${repo}/releases`,
      // draft 对匿名用户不可见，prerelease 会被 electron-updater 默认跳过 ——
      // 两个都会表现成「发了但检查不到更新」，所以这里写死 false
      JSON.stringify({ tag_name: tag, name: tag, body: notes, draft: false, prerelease: false })
    )
    console.log(`  已创建 Release：${release.html_url}`)
  }

  const existing = new Set((release.assets ?? []).map((a) => a.name))
  for (const file of files) {
    const name = basename(file)
    if (existing.has(name)) {
      console.log(`  跳过 ${name}（已存在）`)
      continue
    }
    const data = readFileSync(file)
    const uploadUrl = release.upload_url.replace(/\{.*\}$/, `?name=${encodeURIComponent(name)}`)
    /*
     * 重试的理由和 release-dl.mjs 的 PUT 一样：两百多兆撞上一次瞬断就整个失败，
     * 而失败点通常不是权限（那种第一次就 4xx 了），是连接被中途掐断。
     * 4xx 是配置错，重试多少次都一样，直接抛。
     */
    for (let attempt = 1; ; attempt++) {
      try {
        await api(token, 'POST', uploadUrl, data, { 'Content-Type': 'application/octet-stream' })
        break
      } catch (error) {
        if (attempt >= 3 || /→ 4\d\d:/.test(error.message)) throw error
        const wait = attempt * 3000
        console.log(`  第 ${attempt} 次失败，${wait / 1000}s 后重试…`)
        await new Promise((r) => setTimeout(r, wait))
      }
    }
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

  const repo = resolveRepo()
  if (repo === null) {
    console.error(
      '✖ package.json 没配 updateGithubRepo。没有更新源的包本来就不检查更新，也就没有可发的地方。'
    )
    process.exit(1)
  }
  if (repo === undefined) {
    console.error(`✖ updateGithubRepo 要写成 owner/repo，现在是：${pkg.updateGithubRepo}`)
    process.exit(1)
  }

  const tag = flag('tag') ?? `v${pkg.version}`

  const latestYml = join(DIST_DIR, 'latest.yml')
  if (!existsSync(latestYml)) {
    console.error(`✖ ${latestYml} 不存在，先跑 pnpm build:win`)
    process.exit(1)
  }
  const latest = parseLatestYml(latestYml)
  if (!latest.version || !latest.path || !latest.sha512) {
    console.error('✖ latest.yml 读不出 version/path/sha512，格式跟预期不符，别往下发')
    process.exit(1)
  }

  /*
   * 只发更新要用到的那几个文件：安装包、它的 blockmap、latest.yml。
   * dist 下还躺着 win-unpacked 之类的中间产物，不该上传。
   *
   * **latest.yml 必须排最后。** 它是「有没有新版本」这个事实本身：客户端先拉它，
   * 再按里面记的文件名去下安装包。所以它一上传，更新对所有旧版本立刻生效 ——
   * 而此时安装包可能还没传完，或者根本传不上去。
   *
   * 2026-09-21 发 1.0.2 时就是这样：按字母序 latest.yml 排在 uebox-*.exe 前面，
   * 它传完之后 214 MB 的安装包 fetch failed，Release 于是公开挂着「有 1.0.2」
   * 却没有可下的包，检查更新的人只会下载失败。排到最后就没有这个窗口 ——
   * 中途失败最多是「Release 里有包但还没人知道」，重跑一次补上即可。
   */
  const order = (f) => (f === 'latest.yml' ? 1 : 0)
  const files = readdirSync(DIST_DIR)
    .filter((f) => f === 'latest.yml' || f === latest.path || f === `${latest.path}.blockmap`)
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((f) => join(DIST_DIR, f))

  console.log(`仓库：${repo}`)
  console.log(`tag ：${tag}${flag('tag') ? '' : `（取自 package.json 的 ${pkg.version}）`}`)

  const problems = preflight(files, latest, tag)
  if (problems.length > 0) {
    console.error('\n✖ 发布前检查未通过：')
    for (const p of problems) console.error(`  · ${p}`)
    process.exit(1)
  }

  console.log('\n将要上传：')
  let total = 0
  for (const file of files) {
    const size = statSync(file).size
    total += size
    console.log(`  ${basename(file).padEnd(36)} ${(size / 1024 / 1024).toFixed(2)} MB`)
  }
  console.log(`  ${'合计'.padEnd(34)} ${(total / 1024 / 1024).toFixed(2)} MB`)

  const notesFile = flag('notes')
  const notes = notesFile
    ? readFileSync(resolve(ROOT, notesFile), 'utf8')
    : `虚幻盒子 ${pkg.version}\n\n下载 \`${latest.path}\` 安装。已装的版本会自己检查到这个更新。`

  if (!willPublish) {
    console.log('\n发版说明：')
    console.log(
      notes
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n')
    )
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
  const url = await publish(token, repo, tag, files, notes)
  console.log(`\n✓ 完成：${url}`)
}

main().catch((error) => {
  console.error(`\n✖ ${error.message}`)
  process.exit(1)
})
