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
 * ## 顺带做一份更新镜像
 *
 * 国内连 GitHub 很慢，盒子内的「检查更新」可以同时问几个源、谁先答用谁
 * （src/main/services/updater/updateFeed.ts 的 pickFastestFeed）。所以这里把
 * electron-updater 要的东西也放一份：
 *
 *   dl/<版本>/uebox-1.0.0-setup.exe.blockmap   增量更新用
 *   dl/latest.yml                              清单，`path` 改写成 `<版本>/<文件名>`
 *
 * 镜像地址填 `<公开域名>/dl`。electron-updater 按清单所在目录解析相对路径，
 * 找旧版 blockmap 时把路径里的新版本号换成旧版本号 —— 正好落在 dl/<旧版本>/，
 * 版本化目录不用为更新再复制一份安装包。
 *
 * manifest.json 只给官网页面用，跟 latest.yml 不要混。
 *
 * ## 可以同时传多个桶
 *
 * R2 之外再配一个国内的 S3 兼容存储（`MIRROR_*`），两边内容一模一样，
 * 官网和盒子各自比谁快。哪组变量没填就跳过哪个桶。
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
 *   MIRROR_S3_ENDPOINT / MIRROR_S3_REGION / MIRROR_S3_BUCKET /
 *   MIRROR_S3_ACCESS_KEY_ID / MIRROR_S3_SECRET_ACCESS_KEY / MIRROR_PUBLIC_BASE（可选）
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
 * 「PUT 一个对象」这一个动作。R2 和国内几家 S3 兼容存储都认 SigV4 + 路径式地址。
 */
function sign({ method, host, path, payloadHash, headers, accessKey, secretKey, region }) {
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
 * 对象内容由存储在服务端复制，不再走一遍网络（见 mirror()）。
 *
 * 重试是必要的：两百多兆的上传撞上一次瞬断就整个失败，而失败点通常不是签名
 * 或权限（那种第一次就 4xx 了），是连接被中途掐断。只重试网络层错误和 5xx，
 * 4xx 是配置错，重试多少次都一样。
 */
async function put(cfg, key, body, contentType, cacheControl, extra = {}) {
  const host = cfg.host
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
      secretKey: cfg.secretKey,
      region: cfg.region
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
  const host = cfg.host
  const path = `/${cfg.bucket}/${key}`
  const headers = sign({
    method: 'HEAD',
    host,
    path,
    payloadHash: sha256(Buffer.alloc(0)),
    headers: {},
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    region: cfg.region
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

/**
 * 要传的桶。R2 是主站，MIRROR_* 是国内镜像；哪组一个都没填就不算这个桶。
 *
 * 一组变量只填了一半（比如有 bucket 没密钥）是配错了，直接报出来 ——
 * 悄悄跳过的话，发完版才发现国内用户还在拉 GitHub。
 */
function bucketsFromEnv() {
  const groups = [
    {
      name: 'R2',
      vars: {
        account: 'R2_ACCOUNT_ID',
        bucket: 'R2_BUCKET',
        accessKey: 'R2_ACCESS_KEY_ID',
        secretKey: 'R2_SECRET_ACCESS_KEY'
      },
      build: (v) => ({
        host: `${v.account}.r2.cloudflarestorage.com`,
        region: 'auto',
        publicBase: env('R2_PUBLIC_BASE') ?? 'https://dl.uebox.ai'
      })
    },
    {
      name: 'MIRROR',
      vars: {
        endpoint: 'MIRROR_S3_ENDPOINT',
        bucket: 'MIRROR_S3_BUCKET',
        accessKey: 'MIRROR_S3_ACCESS_KEY_ID',
        secretKey: 'MIRROR_S3_SECRET_ACCESS_KEY',
        publicBase: 'MIRROR_PUBLIC_BASE'
      },
      build: (v) => ({
        // 填 https://xxx 或裸域名都行，签名只要 host
        host: v.endpoint.replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
        region: env('MIRROR_S3_REGION') ?? 'us-east-1',
        publicBase: v.publicBase
      })
    }
  ]

  const buckets = []
  const problems = []
  for (const g of groups) {
    const values = Object.fromEntries(Object.entries(g.vars).map(([k, name]) => [k, env(name)]))
    const missing = Object.entries(g.vars)
      .filter(([k]) => !values[k])
      .map(([, name]) => name)
    if (missing.length === Object.keys(g.vars).length) continue
    if (missing.length) {
      problems.push(`${g.name} 只配了一半，缺：${missing.join(', ')}`)
      continue
    }
    const built = g.build(values)
    buckets.push({
      name: g.name,
      bucket: values.bucket,
      accessKey: values.accessKey,
      secretKey: values.secretKey,
      ...built,
      publicBase: built.publicBase.replace(/\/+$/, '')
    })
  }
  return { buckets, problems }
}

/** 这个桶上的官网清单：下载地址指向它自己的域名，官网从哪个桶读到就从哪个桶下 */
function manifestFor(publicBase, found) {
  const files = {}
  for (const t of found) {
    files[t.key] = {
      name: t.file,
      size: t.size,
      url: `${publicBase}/dl/latest/${t.alias}`,
      versioned: `${publicBase}/dl/${VERSION}/${t.file}`
    }
  }
  return { version: VERSION, date: new Date().toISOString().slice(0, 10), files }
}

/**
 * 把 GitHub Release 用的 latest.yml 改成镜像用的：`path` / `url` 前面加 `<版本>/`。
 *
 * 版本号和 sha512 一个字不动 —— 镜像上的包和 GitHub 上的是同一个文件。
 * 一处都没改到说明 latest.yml 的格式跟预期不符，返回 null，宁可不发也别发坏的。
 */
function mirrorLatestYml(text, file, version = VERSION) {
  let hits = 0
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const out = text.replace(
    new RegExp(`^(\\s*-?\\s*(?:url|path):\\s*)${escaped}[ \\t]*$`, 'gm'),
    (_, lead) => {
      hits++
      return `${lead}${version}/${file}`
    }
  )
  return hits ? out : null
}

/**
 * 同内容再放一份。先试服务端复制，存储不支持就老实再传一遍 ——
 * 国内几家 S3 兼容存储对 x-amz-copy-source 的支持参差不齐。
 */
async function copyOrPut(cfg, destKey, srcKey, readBody) {
  try {
    await copyTo(cfg, destKey, srcKey)
  } catch (err) {
    console.log(`  服务端复制失败（${err.message.split('\n')[0]}），改为直接上传…`)
    await put(cfg, destKey, readBody(), 'application/octet-stream', 'public, max-age=60')
  }
}

async function publishTo(cfg, found, updateFiles) {
  console.log(`\n── ${cfg.name}（${cfg.host}/${cfg.bucket}）`)

  for (const t of found) {
    // 版本化那份先传：它传成功了，别名才有东西可指
    const key = `dl/${VERSION}/${t.file}`
    if (await exists(cfg, key, t.size)) {
      console.log(`跳过 ${key}（已存在，大小一致）`)
    } else {
      console.log(`上传 ${key}（${MB(t.size)}）…`)
      await put(
        cfg,
        key,
        readFileSync(t.path),
        'application/octet-stream',
        'public, max-age=31536000, immutable'
      )
    }
    console.log(`复制 → dl/latest/${t.alias}`)
    await copyOrPut(cfg, `dl/latest/${t.alias}`, key, () => readFileSync(t.path))
  }

  if (updateFiles) {
    const key = `dl/${VERSION}/${updateFiles.blockmapName}`
    console.log(`上传 ${key} …`)
    await put(
      cfg,
      key,
      readFileSync(updateFiles.blockmapPath),
      'application/octet-stream',
      'public, max-age=31536000, immutable'
    )
  }

  // 清单最后传：前面任何一步失败，官网读到的还是上一版，不会指向半传上去的包
  console.log('上传 dl/manifest.json …')
  await put(
    cfg,
    'dl/manifest.json',
    Buffer.from(JSON.stringify(manifestFor(cfg.publicBase, found), null, 2)),
    'application/json',
    'public, max-age=60'
  )

  // latest.yml 是「有新版本」这个事实本身，必须等它指向的安装包和 blockmap 都在了再传
  if (updateFiles) {
    console.log('上传 dl/latest.yml …')
    await put(
      cfg,
      'dl/latest.yml',
      Buffer.from(updateFiles.latestYml),
      'text/yaml; charset=utf-8',
      'public, max-age=60'
    )
  }
}

async function main() {
  if (!existsSync(DIST)) {
    console.error(`找不到 ${DIST} —— 先跑 pnpm build:win（或 build:mac / build:linux）`)
    process.exit(1)
  }

  // 只传这次构建真的产出来的东西。缺哪个平台就跳过哪个 ——
  // 出包是分平台在不同机器上做的，一次只会有一部分产物。
  const found = TARGETS.map((t) => ({ ...t, path: join(DIST, t.file) }))
    .filter((t) => existsSync(t.path))
    .map((t) => ({ ...t, size: statSync(t.path).size }))

  if (!found.length) {
    console.error(
      `dist/ 里没有任何认得出的产物。期望文件名：\n  ${TARGETS.map((t) => t.file).join('\n  ')}`
    )
    process.exit(1)
  }

  // 更新镜像只做 Windows：release-app.mjs 也只发 latest.yml 这一份
  let updateFiles = null
  const win = found.find((t) => t.key === 'win')
  const latestYmlPath = join(DIST, 'latest.yml')
  if (win && existsSync(latestYmlPath) && existsSync(`${win.path}.blockmap`)) {
    const latestYml = mirrorLatestYml(readFileSync(latestYmlPath, 'utf8'), win.file)
    if (!latestYml) {
      console.error(`latest.yml 里找不到指向 ${win.file} 的 path/url —— 不是这次构建的产物？`)
      process.exit(1)
    }
    updateFiles = {
      latestYml,
      blockmapPath: `${win.path}.blockmap`,
      blockmapName: `${win.file}.blockmap`
    }
  }

  const { buckets, problems } = bucketsFromEnv()

  console.log(`\n虚幻盒子 ${VERSION} → 对象存储\n`)
  for (const t of found) {
    console.log(`  ${t.key.padEnd(10)} ${t.file}  (${MB(t.size)})`)
    console.log(`  ${''.padEnd(10)} → dl/${VERSION}/${t.file}`)
    console.log(`  ${''.padEnd(10)} → dl/latest/${t.alias}`)
  }
  if (updateFiles) {
    console.log(`  ${'update'.padEnd(10)} → dl/${VERSION}/${updateFiles.blockmapName}`)
    console.log(`  ${''.padEnd(10)} → dl/latest.yml（盒子内检查更新的镜像源）`)
  } else {
    console.log(`  ${'update'.padEnd(10)} dist 里没有 latest.yml + blockmap，不做更新镜像`)
  }
  console.log(`\n  manifest   dl/manifest.json`)
  console.log(
    `${JSON.stringify(manifestFor(buckets[0]?.publicBase ?? '<公开域名>', found), null, 2)
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n')}\n`
  )
  const targets = buckets.map((b) => `${b.name}（${b.publicBase}）`).join('、')
  console.log(`  目标桶：${targets || '无'}`)
  for (const p of problems) console.log(`  ✖ ${p}`)
  console.log('')

  if (!PUBLISH) {
    console.log('演练模式，没有动网络。确认无误后加 --publish 真传。\n')
    return
  }

  if (problems.length || !buckets.length) {
    console.error(
      problems.length
        ? '环境变量没配齐，见上面 ✖ 那几行（.env.example）'
        : '一个桶都没配（见 .env.example）'
    )
    process.exit(1)
  }

  // 一个桶一个桶传：同时传两个两百多兆，哪个都传不快
  for (const cfg of buckets) await publishTo(cfg, found, updateFiles)

  console.log('\n完成。官网会在 60 秒内（清单缓存过期后）显示新版本。\n')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
