// @vitest-environment node
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  lstatSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { macShellProfile, macPathBlock, macPathEnabled, setMacPath } from './macUserPath'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'uebox-path-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

it('selects the login profile without evaluating the shell configuration', () => {
  expect(macShellProfile(home, '/bin/zsh')).toBe(join(home, '.zprofile'))
  expect(macShellProfile(home, '/bin/bash')).toBe(join(home, '.bash_profile'))
  expect(() => macShellProfile(home, '/bin/fish')).toThrow('zsh and bash')
})

it('adds once and removes only its own block, preserving every original byte', async () => {
  const profile = join(home, '.zprofile')
  const original = '# My settings\nexport CUSTOM="preserve me"'
  writeFileSync(profile, original)
  const directory = "/Applications/Unreal Box's App/cli/bin"
  await setMacPath(profile, directory, true)
  expect(await macPathEnabled(profile, directory)).toBe(true)
  const added = readFileSync(profile, 'utf8')
  await setMacPath(profile, directory, true)
  expect(readFileSync(profile, 'utf8')).toBe(added)
  await setMacPath(profile, directory, false)
  expect(readFileSync(profile, 'utf8')).toBe(original)
  expect(await macPathEnabled(profile, directory)).toBe(false)
})

it('updates a moved app directory without duplicating the managed block', async () => {
  const profile = join(home, '.bash_profile')
  await setMacPath(profile, '/old/bin', true)
  await setMacPath(profile, '/new/bin', true)
  expect(readFileSync(profile, 'utf8')).toBe(macPathBlock('/new/bin'))
})

it('preserves symlinked dotfiles', async () => {
  const stored = join(home, 'dotfiles')
  mkdirSync(stored)
  const target = join(stored, '.zprofile')
  const linked = join(home, 'linked-dotfiles')
  const profile = join(linked, '.zprofile')
  writeFileSync(target, '# Original\n')
  symlinkSync(stored, linked, 'junction')
  await setMacPath(profile, '/app/bin', true)
  expect(lstatSync(linked).isSymbolicLink()).toBe(true)
  expect(readFileSync(target, 'utf8')).toContain(macPathBlock('/app/bin'))
})

it('refuses damaged blocks and leaves the file untouched', async () => {
  const profile = join(home, '.zprofile')
  const damaged = '\n# >>> Unreal Box CLI >>>\nuser edited content\n'
  writeFileSync(profile, damaged)
  await expect(setMacPath(profile, '/app/bin', true)).rejects.toThrow()
  expect(readFileSync(profile, 'utf8')).toBe(damaged)
  expect(() => macPathBlock('/app\ncommand')).toThrow()
})

it('quotes shell metacharacters as data', () => {
  const directory = "/app's $(echo BAD) `echo BAD` path/bin"
  expect(macPathBlock(directory)).toContain(
    "export PATH=\"$PATH\":'/app'\\''s $(echo BAD) `echo BAD` path/bin'\n"
  )
})
