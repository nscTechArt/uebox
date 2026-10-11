/**
 * 拿本机盒子里配好的密钥，核对内置目录（catalog.generated.ts）里的预置模型在厂商那边是不是真有。
 *
 * 为什么要有它：目录从 models.dev 生成，上游会列出厂商根本没有的模型。2026-10-09
 * 硅基流动那一组 12 个里 5 个回「模型不存在」—— 社区用户绑了其中的 Kimi K3，盒子一用就是 400。
 * `sync-provider-catalog.mjs` 刷完目录之后跑一遍，查出来的写进那边的 MODEL_REMOVALS。
 *
 * 只查**直连官方地址**的厂商：配置的 Base URL 和目录条目对得上才查。走中转的
 * 查出来是中转的情况，说明不了目录对不对。每个模型发一条最短的请求（几个 token），
 * 一家一家串行发。不打印密钥。
 *
 * 要用 Electron 跑（密钥是 safeStorage 加密的，只有 Electron 解得开）：
 *   pnpm check:catalog-models
 *   pnpm check:catalog-models -- --only=siliconflow,deepseek
 *   pnpm check:catalog-models -- --user-data=<盒子的 userData 目录>   默认 %APPDATA%/unreal-box
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_FILE = path.join(ROOT, 'src/main/ai/catalog.generated.ts')
const REQUEST_TIMEOUT_MS = 60_000
const GAP_MS = 300

const args = process.argv.slice(2)
const argValue = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1]
const only = argValue('only')?.split(',').filter(Boolean)
const userData =
  argValue('user-data') || path.join(process.env.APPDATA || app.getPath('appData'), 'unreal-box')
app.setPath('userData', userData)

const norm = (url) => String(url || '').replace(/\/+$/, '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 生成文件就是一段 JSON 包在 TS 里，取出来直接解析 */
function readCatalog() {
  const source = fs.readFileSync(CATALOG_FILE, 'utf8')
  const start = source.indexOf('Object.freeze([') + 'Object.freeze('.length
  const end = source.lastIndexOf('] as CatalogEntry[]')
  return JSON.parse(source.slice(start, end + 1))
}

function readSecrets() {
  const file = path.join(userData, 'ai-provider-secrets.bin')
  if (!fs.existsSync(file)) return {}
  return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)))
}

/** 取不到（命令取密钥、过期的登录、要特殊请求头的账号）就返回原因，不硬试 */
function keyFor(provider, secrets) {
  const ref = provider.apiKey || { kind: 'none' }
  if (ref.kind === 'none') return { key: '' }
  if (ref.kind === 'env') {
    const key = String(process.env[ref.name] || '').trim()
    return key ? { key } : { skip: `环境变量 ${ref.name} 没设` }
  }
  if (ref.kind === 'literal') {
    const key = String(secrets[ref.id] || '').trim()
    return key ? { key } : { skip: '密钥解不开' }
  }
  if (ref.kind === 'oauth') {
    // CodeBuddy 每次请求要带账号头，这里不复刻那一套
    if (ref.provider === 'codebuddy') return { skip: 'CodeBuddy 登录账号要专门的请求头' }
    try {
      const tokens = JSON.parse(secrets[ref.id] || 'null')
      if (!tokens?.accessToken) return { skip: '登录信息不存在' }
      if (tokens.expiresAt && tokens.expiresAt < Date.now()) {
        return { skip: '登录已过期，在盒子里用一次再来' }
      }
      return { key: tokens.accessToken }
    } catch {
      return { skip: '登录信息解不开' }
    }
  }
  return { skip: `不支持的密钥方式 ${ref.kind}（不替你执行取密钥命令）` }
}

function requestFor(protocol, baseUrl, key, headers, model) {
  const base = norm(baseUrl)
  if (protocol === 'openai-completions') {
    return {
      url: `${base}/chat/completions`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...headers
        },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
      }
    }
  }
  if (protocol === 'anthropic-messages') {
    return {
      url: `${base}/v1/messages`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': key,
          ...headers
        },
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
      }
    }
  }
  return undefined
}

const MISSING =
  /does not exist|not exist|not[ _-]?found|no such model|model_not_found|invalid model|unknown model|unsupported model|不存在|未找到/i
const NO_ACCESS = /private|permission|forbidden|not authorized|unauthorized model|无权|未开通|开通/i

function classify(status, text) {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401) return 'auth'
  if (status === 429) return 'rateLimited'
  if (status === 404 || MISSING.test(text)) return 'missing'
  if (status === 403 || NO_ACCESS.test(text)) return 'noAccess'
  return 'other'
}

async function probe(request) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      const text = await res.text().catch(() => '')
      const verdict = classify(res.status, text)
      if (verdict === 'rateLimited' && attempt === 0) {
        await sleep(3000)
        continue
      }
      return { verdict, status: res.status, detail: verdict === 'ok' ? '' : text.slice(0, 160) }
    } catch (error) {
      return { verdict: 'other', status: 0, detail: String(error?.message || error).slice(0, 160) }
    }
  }
}

const LABEL = {
  ok: '能用',
  missing: '不存在',
  noAccess: '无权限',
  auth: '密钥无效',
  rateLimited: '限流',
  other: '其他错误'
}

async function main() {
  const catalog = readCatalog()
  const settings = JSON.parse(fs.readFileSync(path.join(userData, 'models.json'), 'utf8'))
  const secrets = readSecrets()
  const findings = []

  for (const entry of catalog) {
    if ((entry.kind || 'chat') !== 'chat' || entry.models.length === 0) continue
    if (only && !only.includes(entry.id)) continue
    const provider = settings.providers.find(
      (item) => (item.kind || 'chat') === 'chat' && norm(item.baseUrl) === norm(entry.baseUrl)
    )
    if (!provider) continue

    const { key, skip } = keyFor(provider, secrets)
    const firstRequest = skip
      ? undefined
      : requestFor(entry.protocol, entry.baseUrl, key, provider.headers || {}, entry.models[0].id)
    if (skip || !firstRequest) {
      console.log(
        `\n## ${entry.id}（配置里叫 ${provider.id}）跳过：${skip || `${entry.protocol} 协议不查`}`
      )
      continue
    }

    console.log(`\n## ${entry.id}（配置里叫 ${provider.id}）${entry.models.length} 个预置模型`)
    for (const model of entry.models) {
      const request = requestFor(
        entry.protocol,
        entry.baseUrl,
        key,
        provider.headers || {},
        model.id
      )
      const result = await probe(request)
      const line = `${LABEL[result.verdict].padEnd(4, '　')} ${result.status || '---'}  ${model.id}`
      console.log(result.detail ? `${line}  ${result.detail.replace(/\s+/g, ' ')}` : line)
      if (result.verdict !== 'ok') findings.push({ provider: entry.id, model: model.id, ...result })
      // 密钥不对，后面全是同一句，不用再发
      if (result.verdict === 'auth') {
        console.log('  密钥被拒，这一家后面的不查了')
        break
      }
      await sleep(GAP_MS)
    }
  }

  const missing = findings.filter((item) => item.verdict === 'missing')
  console.log(`\n共 ${findings.length} 个没跑通，其中「不存在」${missing.length} 个：`)
  for (const item of missing) console.log(`  ${item.provider}: '${item.model}'`)
  console.log('「不存在」的确认后写进 scripts/sync-provider-catalog.mjs 的 MODEL_REMOVALS。')
  console.log('「无权限」多半是账号没开通，换个账号可能就有，别急着删。')
}

app
  .whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
