// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getSharp } from '../../../utils/sharpLoader'
import { getListThumbnail } from '../../../utils/listThumbnail'
import { buildImportThumbnail } from './importAssetMedia'

const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }))
vi.mock('../../../utils/PathManager', () => ({
  PathManager: {
    getInstance: () => ({
      getThumbnailsPath: () => join(state.directory, 'thumbnails'),
      getThumbnailFilePath: (name: string) => join(state.directory, 'thumbnails', name),
      ensureDirectoryExists: (path: string) => mkdir(path, { recursive: true })
    })
  }
}))

beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), 'import-thumb-'))
  const sharp = await getSharp()
  sharp.cache(false)
})
afterEach(async () => {
  await rm(state.directory, { recursive: true, force: true })
})

it('imports a portable 400px thumbnail and warms the exact renderer cache without recompression', async () => {
  const sharp = await getSharp()
  const source = join(state.directory, 'original.png')
  await sharp({ create: { width: 1600, height: 800, channels: 4, background: '#ffffff00' } })
    .png()
    .toFile(source)
  const original = await readFile(source)
  const filename = await buildImportThumbnail(source, 'asset-1', 'png')
  expect(filename).toBe('thumbnail-asset-1.webp')
  const managed = join(state.directory, 'thumbnails', filename!)
  const metadata = await sharp(await readFile(managed)).metadata()
  expect([metadata.width, metadata.height, metadata.hasAlpha]).toEqual([400, 200, true])
  const cache = join(state.directory, 'list-thumbnails')
  const before = await readdir(cache)
  const cached = await getListThumbnail(managed.replace(/\\/g, '/'), cache)
  expect(await readdir(cache)).toEqual(before)
  expect(await readFile(cached)).toEqual(await readFile(managed))
  const timestamp = (await stat(cached)).mtimeMs
  await getListThumbnail(managed, cache)
  expect((await stat(cached)).mtimeMs).toBe(timestamp)
  expect(await readFile(source)).toEqual(original)
})

it('skips other files and leaves failed image imports without an original-sized thumbnail', async () => {
  expect(await buildImportThumbnail('missing.txt', 'text', 'txt')).toBeUndefined()
  const source = join(state.directory, 'broken.png')
  await writeFile(source, 'not an image')
  expect(await buildImportThumbnail(source, 'broken', 'png')).toBeUndefined()
  expect(await readdir(join(state.directory, 'thumbnails'))).toEqual([])
  expect(await readFile(source, 'utf8')).toBe('not an image')
})

it('makes a static small GIF thumbnail while preserving every frame of the original', async () => {
  const sharp = await getSharp()
  const pixels = Buffer.alloc(800 * 1600 * 3)
  pixels.fill(255, 0, pixels.length / 2)
  const original = await sharp(pixels, {
    raw: { width: 800, height: 1600, pageHeight: 800, channels: 3 }
  })
    .gif({ delay: [100, 100] })
    .toBuffer()
  const source = join(state.directory, 'animation.gif')
  await writeFile(source, original)
  const filename = await buildImportThumbnail(source, 'animated', 'gif')
  expect(filename).toBe('thumbnail-animated.webp')
  const thumbnail = await readFile(join(state.directory, 'thumbnails', filename!))
  const metadata = await sharp(thumbnail).metadata()
  expect([metadata.width, metadata.height, metadata.pages ?? 1]).toEqual([400, 400, 1])
  expect((await sharp(original).metadata()).pages).toBe(2)
  expect(await readFile(source)).toEqual(original)
})
