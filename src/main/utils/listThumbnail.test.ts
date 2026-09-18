// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, expect, it } from 'vitest'
import { getSharp } from './sharpLoader'
import { getListThumbnail } from './listThumbnail'

let directory: string
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('bounds both dimensions, preserves alpha and original, reuses cache and invalidates edits', async () => {
  directory = await mkdtemp(join(tmpdir(), 'list-thumb-'))
  const sharp = await getSharp()
  const source = join(directory, 'original.png')
  const cache = join(directory, 'cache')
  await sharp({ create: { width: 1200, height: 2400, channels: 4, background: '#ffffff00' } })
    .png()
    .toFile(source)
  const original = await readFile(source)
  const [first, duplicate] = await Promise.all([
    getListThumbnail(source, cache),
    getListThumbnail(source, cache)
  ])
  expect(duplicate).toBe(first)
  const metadata = await sharp(await readFile(first)).metadata()
  expect([metadata.width, metadata.height, metadata.hasAlpha]).toEqual([200, 400, true])
  const before = await stat(first)
  expect(await getListThumbnail(source, cache)).toBe(first)
  expect((await stat(first)).mtimeMs).toBe(before.mtimeMs)
  expect(await readFile(source)).toEqual(original)
  await sharp({ create: { width: 20, height: 10, channels: 4, background: '#ffffff00' } })
    .png()
    .toFile(source)
  const updated = await getListThumbnail(source, cache)
  expect(updated).not.toBe(first)
  const small = await sharp(await readFile(updated)).metadata()
  expect([small.width, small.height]).toEqual([20, 10])
})

it('rejects damaged images without returning originals and continues processing later images', async () => {
  directory = await mkdtemp(join(tmpdir(), 'list-thumb-'))
  const source = join(directory, 'broken.png')
  await writeFile(source, 'broken')
  await expect(getListThumbnail(source, join(directory, 'cache'))).rejects.toThrow()
  const sharp = await getSharp()
  await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ffffff' } })
    .png()
    .toFile(source)
  await expect(getListThumbnail(source, join(directory, 'cache'))).resolves.toMatch(/\.webp$/)
})
