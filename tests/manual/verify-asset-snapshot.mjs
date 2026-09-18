/**
 * 真机验证资产快照/回滚这条链：**保存 → 拷贝 → 改一下 → 还原 → 重载**。
 *
 * ## 为什么必须真机验
 *
 * 三件事光看代码定不了，只有开着编辑器才知道：
 *
 *   1. **重载 API 在这个引擎版本上叫什么。** 脚本里逐个探
 *      `EditorAssetLibrary.reload_asset` 和 `EditorLoadingAndSavingUtils.reload_packages`，
 *      把「试过哪些、哪个成功」原样打出来 —— 猜是猜不出来的。
 *   2. **资产正开在编辑器标签页里时会怎样。** 换文件本身一定成功（那只是拷贝），
 *      问题在重载：轻则弹窗，重则崩。这一步要你手动开着 M_ 材质再跑一遍。
 *   3. **save_asset 要多久。** 大工程里如果一次要好几秒，那「每次写操作前都快照」
 *      这个设计就得改成按轮快照。
 *
 * ## 前置
 *
 *   - 虚幻编辑器开着，装了 UnrealAgentLink，盒子能连上
 *   - 工程里有一个可以随便改的材质，路径当参数传进来
 *
 * ## 跑法
 *
 * ```bash
 * node tests/manual/verify-asset-snapshot.mjs [/Game/你的材质路径]
 * ```
 *
 * ## 看什么
 *
 *   - `capture.entry.snapshotPath` 指向 `<工程>/Saved/UnrealBox/Snapshots/...`，
 *     文件真的在那儿、大小非零
 *   - 改完之后 `changed=true`（磁盘上的字节数或哈希变了）
 *   - `restore.reloaded=true`，且 `restore.tried` 里能看出**哪个 API 成功了**
 *   - 回到编辑器里看那个材质：粗糙度应当回到改之前的值
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const USERDATA = path.join(APP_DIR, '.test', 'asset-snapshot-userdata')
const REAL = path.join(process.env.APPDATA || '', 'unreal-box')
const ASSET = process.argv[2] || '/Game/EvalTmp/M_SnapshotProbe'

fs.rmSync(USERDATA, { recursive: true, force: true })
fs.mkdirSync(USERDATA, { recursive: true })
for (const file of ['models.json', 'ai-provider-secrets.bin', 'Local State']) {
  const src = path.join(REAL, file)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(USERDATA, file))
}

const log = (message) => process.stdout.write(`${message}\n`)

const app = await electron.launch({
  args: ['.', `--user-data-dir=${USERDATA}`],
  cwd: APP_DIR,
  env: { ...process.env, NODE_ENV: 'production' }
})

const page = await app.firstWindow({ timeout: 60_000 })
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(5000)

// 1. 确认连上了引擎，并拿到工程目录
const project = await page.evaluate(async () => {
  const projects = await window.api.websocket.getProjects()
  const first = (projects || [])[0]
  return first ? { name: first.projectName, path: first.projectPath } : null
})

if (!project?.path) {
  log('✖ 没有连接的 UE 工程 —— 先把编辑器打开、确认盒子连上再跑')
  await app.close()
  process.exit(1)
}

log(`工程：${project.name}  ${project.path}`)
log(`目标资产：${ASSET}`)

// 2. 快照
const started = Date.now()
const capture = await page.evaluate(
  ([projectDir, contentPath]) =>
    window.api.agentV3.snapshot.capture({
      projectDir,
      sessionId: 'manual-verify',
      contentPath
    }),
  [project.path, ASSET]
)
log(`\ncapture（耗时 ${Date.now() - started}ms）：\n${JSON.stringify(capture, null, 2)}`)

if (!capture?.ok || !capture.entry) {
  log('✖ 快照没做成 —— 上面的 skipped/detail 就是原因')
  await app.close()
  process.exit(1)
}

const snapshotExists = fs.existsSync(capture.entry.snapshotPath)
log(`快照文件在不在：${snapshotExists ? '✅ 在' : '✖ 不在'}  ${capture.entry.snapshotPath}`)

// 3. 改一下这个资产（改粗糙度，够小也够明显）
const beforeBytes = fs.existsSync(capture.entry.diskPath)
  ? fs.statSync(capture.entry.diskPath).size
  : 0

log('\n现在去编辑器里改这个材质（比如把 Roughness 调一下）并保存，然后回车继续…')
await new Promise((resolve) => process.stdin.once('data', resolve))

const afterBytes = fs.existsSync(capture.entry.diskPath)
  ? fs.statSync(capture.entry.diskPath).size
  : 0
log(
  `磁盘字节数：改前 ${beforeBytes} → 改后 ${afterBytes}（${beforeBytes === afterBytes ? '没变，可能没保存' : '变了'}）`
)

// 4. 回滚
const restore = await page.evaluate(
  ([entry]) => window.api.agentV3.snapshot.restore({ entry }),
  [capture.entry]
)
log(`\nrestore：\n${JSON.stringify(restore, null, 2)}`)

log(
  [
    '',
    '=== 人工确认 ===',
    `1. restore.reloaded 是不是 true，tried 里哪个 API 成功了：${JSON.stringify(restore?.tried)}`,
    '2. 回编辑器看那个材质，参数有没有回到改之前',
    '3. 把材质开在编辑器标签页里，再跑一遍这个脚本，看重载会不会弹窗或崩'
  ].join('\n')
)

await app.close()
