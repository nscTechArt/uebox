// Subprocess-only substitutes: gate steps are recorded instead of run, and any other external
// command fails the test.
import childProcess from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

if (process.env.PLUGIN_RELEASE_TEST_PLATFORM) {
  Object.defineProperty(process, 'platform', { value: process.env.PLUGIN_RELEASE_TEST_PLATFORM })
}

const record = (event: unknown): void =>
  fs.appendFileSync(join(process.cwd(), 'operations.jsonl'), JSON.stringify(event) + '\n')

Object.defineProperty(childProcess, 'spawnSync', {
  value: (command: string, args: string[]) => {
    record({ command, args })
    // verify.mjs runs every gate step through pnpm; record them instead of running them.
    if (command === 'pnpm') return { status: 0 }
    throw new Error(`Unexpected external command: ${command} ${args.join(' ')}`)
  }
})
syncBuiltinESMExports()
