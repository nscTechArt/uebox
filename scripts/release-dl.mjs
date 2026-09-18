#!/usr/bin/env node
/**
 * 把 dist/ 里的安装包镜像到对象存储（R2），供官网直接下载。
 *
 * ## 为什么在本地跑，而不是 GitHub Actions
 *
 * 跟 release-app.mjs 同一个理由：出包天生是本地的（`build:win` 第一步要给八个引擎
 * 各编一遍插件，托管 runner 装不下 UE，`resources/plugins/*.zip` 也没进 git）。
 * 走 Actions 就得「本地出包 → 传 GitHub → Actions 再下回来 → 推 R2」绕一圈，
 * 还得把对象存储的**写**凭据放进 GitHub Secrets 长期存着。本地传少一跳、少一份密钥。
 *
 * 这一步不挂在 `build:win` 里：构建不该有网络副作用，出包和发布得能分开重试。
 *
 * ## 上传两份的原因
 *
 *   dl/<版本>/uebox-1.0.0-setup.exe   版本化，内容永不变 → 可以往死里缓存，旧版永远可下
 *   dl/latest/uebox-setup.exe         固定别名，每次发版覆盖 → 官网按钮指的就是它
 *
 * 官网因此不需要知道版本号，发版之后一行代码都不用改、也不用重新部署。
 * 另外写一份 dl/manifest.json，官网运行时读它来显示版本号和体积（读不到也不影响下载）。
 *
 * ## 和 electron-updater 的 latest.yml 没有关系
 *
 * 那个是「检查更新」读的清单，归 release-app.mjs 发到 GitHub Releases。这里的
 * manifest.json 只给官网页面用。两者不要混。
 *
 * ## 默认只演练
 *
 * 上传是对外发布。默认 `--dry-run`：把要传什么、传到哪、多大全打印出来但不动网络。
 *
 * ## 用法
 *
 *   node scripts/release-dl.mjs                 # 演练
 *   node scripts/release-dl.mjs --publish       # 真传
 *
 * 需要的环境变量（见 .env.example）：
 *   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_BASE
 */

import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = join(ROOT, 'dist')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version

const PUBLISH = process.argv.includes('--publish')

/**
 * 平台 → 产物文件名 / 别名。
 *
 * 文件名跟 electron-builder.yml 里的 artifactName 对齐，改那边要改这里。
 * 别名不带版本号 —— 官网按钮指的就是它，所以必须固定。
 */
const TARGETS = [
  { key: 'win', file: `uebox-${VERSION}-setup.exe`, alias: 'uebox-setup.exe' },
  { key: 'mac-arm64', file: `uebox-${VERSION}-arm64-mac.dmg`, alias: 'uebox-arm64.dmg' },
  { key: 'mac-x64', file: `uebox-${VERSION}-x64-mac.dmg`, alias: 'uebox-x64.dmg' },
  { key: 'linux', file: `uebox-${VERSION}.AppImage`, alias: 'uebox.AppImage' }
]

/*
 * 读 .env。
 *
 * Node 不会自动加载 .env —— 不显式读一次，下面拿到的永远是空，
 * 表现是「明明填好了却说缺环境变量」。已经在环境里的变量优先，方便临时覆盖。
 */
try {
  process.loadEnvFile(join(ROOT, '.env'))
} catch {
  // 没有 .env 就只认真实环境变量
}

function env(name) {
  const v = (process.env[name] ?? '').trim()
  return v || null
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/**
 * S3 SigV4 签名。
 *
 * 手写而不是装 @aws-sdk/client-s3：那一整包是几十兆的运行时依赖，而这里只需要
 * 「PUT 一个对象」这一个动作。R2 完全兼容 SigV4。
 */
function sign({ method, host, path, payloadHash, headers, accessKey, secretKey, region = 'auto' }) {
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)

  const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
  const names = Object.keys(all)
    .map((k) => k.toLowerCase())
    .sort()
  const canonicalHeaders = names
    .map((k) => `${k}:${String(all[Object.keys(all).find((h) => h.toLowerCase() === k)]).trim()}\n`)
    .join('')
  const signedHeaders = names.join(';')

  const canonical = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(Buffer.from(canonical))].join('\n')

  let k = hmac(`AWS4${secretKey}`, dateStamp)
  k = hmac(k, region)
  k = hmac(k, 's3')
  k = hmac(k, 'aws4_request')
  const signature = createHmac('sha256', k).update(toSign).digest('hex')

  return {
    ...all,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }
}

/**
 * PUT 一个对象。
 *
 * `extra` 用来带 x-amz-copy-source 那一组头 —— 带上之后 body 是空的，
 * 对象内容由 R2 在服务端复制，不再走一遍网络（见 mirror()）。
 *
 * 重试是必要的：两百多兆的上传撞上一次瞬断就整个失败，而失败点通常不是签名
 * 或权限（那种第一次就 4xx 了），是连接被中途掐断。只重试网络层错误和 5xx，
 * 4xx 是配置错，重试多少次都一样。
 */
async function put(cfg, key, body, contentType, cacheControl, extra = {}) {
  const host = `${cfg.account}.r2.cloudflarestorage.com`
  const path = `/${cfg.bucket}/${key}`
  const payloadHash = sha256(body)

  for (let attempt = 1; ; attempt++) {
    const headers = sign({
      method: 'PUT',
      host,
      path,
      payloadHash,
      headers: { 'content-type': contentType, 'cache-control': cacheControl, ...extra },
      accessKey: cfg.accessKey,
      secretKey: cfg.secretKey
    })

    try {
      const res = await fetch(`https://${host}${path}`, { method: 'PUT', headers, body })
      if (res.ok) return
      const text = await res.text()
      // 4xx 是我们这边配错了，重试没意义
      if (res.status < 500) throw new Error(`PUT ${key} → ${res.status}\n${text}`)
      if (attempt >= 3)
        throw new Error(`PUT ${key} → ${res.status}（重试 ${attempt} 次仍失败）\n${text}`)
    } catch (err) {
      if (attempt >= 3 || /→ 4\d\d/.test(err.message)) {
        // fetch 的 "fetch failed" 把真正的原因藏在 cause 里，不翻出来根本没法查
        const cause = err.cause
          ? `\n  原因：${err.cause.code ?? ''} ${err.cause.message ?? err.cause}`
          : ''
        throw new Error(`${err.message}${cause}`)
      }
    }
    const wait = attempt * 3000
    console.log(`  第 ${attempt} 次失败，${wait / 1000}s 后重试…`)
    await new Promise((r) => setTimeout(r, wait))
  }
}

/**
 * 这个 key 是不是已经传上去了、而且大小一致。
 *
 * 为的是中途失败之后重跑不用再传一遍两百多兆 —— 版本化的对象内容永不变，
 * 大小对上就是同一个东西。别名不走这里（它每次发版都要指向新内容）。
 */
async function exists(cfg, key, size) {
  const host = `${cfg.account}.r2.cloudflarestorage.com`
  const path = `/${cfg.bucket}/${key}`
  const headers = sign({
    method: 'HEAD',
    host,
    path,
    payloadHash: sha256(Buffer.alloc(0)),
    headers: {},
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey
  })
  try {
    const res = await fetch(`https://${host}${path}`, { method: 'HEAD', headers })
    return res.ok && Number(res.headers.get('content-length')) === size
  } catch {
    return false
  }
}

/**
 * 别名对象：让 R2 在服务端从版本化那份复制过去。
 *
 * 一开始是把同一个 Buffer 再 PUT 一遍 —— 两百多兆传两次，第二次在网络层挂了。
 * 内容完全一样，本来就没有必要再传一遍。
 * metadata-directive=REPLACE 是为了让别名用自己的 Cache-Control（短缓存），
 * 不继承版本化那份的 immutable —— 继承了的话发新版用户拿到的还是旧包。
 */
async function copyTo(cfg, destKey, srcKey) {
  await put(cfg, destKey, Buffer.alloc(0), 'application/octet-stream', 'public, max-age=60', {
    'x-amz-copy-source': `/${cfg.bucket}/${encodeURI(srcKey)}`,
    'x-amz-metadata-directive': 'REPLACE'
  })
}

const MB = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

async function main() {
  if (!existsSync(DIST)) {
    console.error(`找不到 ${DIST} —— 先跑 pnpm build:win（或 build:mac / build:linux）`)
    process.exit(1)
  }

  // 只传这次构建真的产出来的东西。缺哪个平台就跳过哪个 ——
  // 出包是分平台在不同机器上做的，一次只会有一部分产物。
  const found = TARGETS.map((t) => ({ ...t, path: join(DIST, t.file) })).filter((t) =>
    existsSync(t.path)
  )

  if (!found.length) {
    console.error(
      `dist/ 里没有任何认得出的产物。期望文件名：\n  ${TARGETS.map((t) => t.file).join('\n  ')}`
    )
    process.exit(1)
  }

  const files = {}
  for (const t of found) {
    const size = statSync(t.path).size
    files[t.key] = {
      name: t.file,
      size,
      url: `${env('R2_PUBLIC_BASE') ?? 'https://dl.uebox.ai'}/dl/latest/${t.alias}`,
      versioned: `${env('R2_PUBLIC_BASE') ?? 'https://dl.uebox.ai'}/dl/${VERSION}/${t.file}`
    }
  }

  const manifest = {
    version: VERSION,
    date: new Date().toISOString().slice(0, 10),
    files
  }

  console.log(`\n虚幻盒子 ${VERSION} → 对象存储\n`)
  for (const t of found) {
    console.log(`  ${t.key.padEnd(10)} ${t.file}  (${MB(files[t.key].size)})`)
    console.log(`  ${''.padEnd(10)} → dl/${VERSION}/${t.file}`)
    console.log(`  ${''.padEnd(10)} → dl/latest/${t.alias}`)
  }
  console.log(`\n  manifest   dl/manifest.json`)
  console.log(
    `${JSON.stringify(manifest, null, 2)
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n')}\n`
  )

  if (!PUBLISH) {
    console.log('演练模式，没有动网络。确认无误后加 --publish 真传。\n')
    return
  }

  const cfg = {
    account: env('R2_ACCOUNT_ID'),
    bucket: env('R2_BUCKET'),
    accessKey: env('R2_ACCESS_KEY_ID'),
    secretKey: env('R2_SECRET_ACCESS_KEY')
  }
  const missing = Object.entries(cfg)
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length) {
    console.error(`缺少环境变量：${missing.join(', ')}（见 .env.example）`)
    process.exit(1)
  }

  for (const t of found) {
    // 版本化那份先传：它传成功了，别名才有东西可指
    const key = `dl/${VERSION}/${t.file}`
    if (await exists(cfg, key, files[t.key].size)) {
      console.log(`跳过 ${key}（已存在，大小一致）`)
    } else {
      console.log(`上传 ${key}（${MB(files[t.key].size)}）…`)
      await put(
        cfg,
        key,
        readFileSync(t.path),
        'application/octet-stream',
        'public, max-age=31536000, immutable'
      )
    }
    console.log(`复制 → dl/latest/${t.alias}（服务端复制，不重传）`)
    await copyTo(cfg, `dl/latest/${t.alias}`, `dl/${VERSION}/${t.file}`)
  }

  // 清单最后传：前面任何一步失败，官网读到的还是上一版，不会指向半传上去的包
  console.log('上传 dl/manifest.json …')
  await put(
    cfg,
    'dl/manifest.json',
    Buffer.from(JSON.stringify(manifest, null, 2)),
    'application/json',
    'public, max-age=60'
  )

  console.log('\n完成。官网会在 60 秒内（清单缓存过期后）显示新版本。\n')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
