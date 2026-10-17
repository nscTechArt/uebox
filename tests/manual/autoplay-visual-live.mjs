/** Opt-in live Jev smoke test. Uses synthetic game frames, never editor pixels.
 * TYPESAFE_API_KEY=... pnpm exec node tests/manual/autoplay-visual-live.mjs
 * This verifies the real visual acceptance pipeline, not Unreal gameplay or navigation. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'

if (!process.env.TYPESAFE_API_KEY)
  throw new Error('Set TYPESAFE_API_KEY before running this opt-in test')
const require = createRequire(import.meta.url)
const viteRequire = createRequire(require.resolve('vite'))
const { build } = await import(pathToFileURL(viteRequire.resolve('esbuild')).href)
const dir = resolve('.test', `autoplay-visual-${Date.now()}`)
await mkdir(dir, { recursive: true })
const output = join(dir, 'pipeline.mjs')
await build({
  stdin: {
    contents:
      'export { requestJudgement } from "./src/main/ai/judge.ts"; export { acceptAutoplayVisually } from "./src/main/agent-v3/tools/adapted/ue-autoplay/visualAcceptance.ts";',
    resolveDir: process.cwd()
  },
  outfile: output,
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'desktop-settings-boundary',
      setup(build) {
        build.onResolve({ filter: /^\.\/(store|credentials|creatorPlan\/callError)$/ }, (args) => ({
          path: args.path,
          namespace: 'desktop-stub'
        }))
        build.onLoad({ filter: /.*/, namespace: 'desktop-stub' }, (args) => ({
          contents:
            args.path === './credentials'
              ? 'export async function resolveApiKey() { return process.env.TYPESAFE_API_KEY }'
              : args.path === './store'
                ? 'export async function readSettings() { throw new Error("Unused in direct request") }'
                : 'export function planCallError() { throw new Error("Unused in direct request") }'
        }))
      }
    }
  ]
})
const { requestJudgement, acceptAutoplayVisually } = await import(pathToFileURL(output).href)
const provider = {
  id: 'typesafe',
  kind: 'judge',
  baseUrl: 'https://api.typesafe.ai/v1',
  apiKey: { kind: 'env', name: 'TYPESAFE_API_KEY' }
}
const frames = []
for (const [index, label] of ['KEY COLLECTED', 'VICTORY'].entries()) {
  const path = join(dir, `synthetic-${index}.png`)
  await sharp(
    Buffer.from(
      `<svg width="960" height="540"><rect width="960" height="540" fill="#6eafff"/><rect y="400" width="960" height="140" fill="#4f8a35"/><rect x="180" y="310" width="50" height="90" fill="#ff9b20"/><rect x="40" y="30" width="880" height="100" fill="#101820"/><text x="480" y="100" text-anchor="middle" font-family="Arial" font-size="52" fill="white">${label}</text></svg>`
    )
  )
    .png()
    .toFile(path)
  frames.push({ at: index * 3 + 1, path })
}
const base = {
  report: { ok: true, frame_mode: 'window', frames },
  model: 'jev-1.14.0',
  ask: (state, questions, options) =>
    requestJudgement(provider, 'jev-1.14.0', state, questions, 4000, undefined, options)
}
const passed = await acceptAutoplayVisually({
  ...base,
  outputDir: join(dir, 'positive'),
  checks: [
    { id: 'key', description: '游戏 HUD 显示 KEY COLLECTED' },
    { id: 'win', description: '游戏 HUD 显示 VICTORY' }
  ]
})
const absent = await acceptAutoplayVisually({
  ...base,
  outputDir: join(dir, 'negative'),
  checks: [{ id: 'absent', description: '游戏 HUD 显示 GAME OVER' }]
})
console.log(
  JSON.stringify(
    {
      fixture: 'synthetic, not an Unreal run',
      positive: {
        status: passed.status,
        frames: passed.frames,
        replay: passed.replay_path,
        report: passed.report_path
      },
      negative: { status: absent.status, frames: absent.frames, report: absent.report_path }
    },
    null,
    2
  )
)
assert.equal(passed.status, 'passed')
assert.equal(absent.status, 'not_passed')
assert.ok(passed.replay_path)
