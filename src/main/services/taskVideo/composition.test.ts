/** @vitest-environment node */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { stageComposition, compositionFile, planSampleTimes, referencedAssets } from './composition'
import { VideoScene } from './schema'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true }))
  )
})
async function fixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'composition-'))
  folders.push(dir)
  return dir
}
it('snapshots declared original assets and creates a new version when an asset changes', async () => {
  const dir = await fixture()
  const source = path.join(dir, 'source.html'),
    image = path.join(dir, 'original.png')
  await fs.writeFile(source, '<html>art direction</html>')
  await fs.writeFile(image, 'original pixels')
  const scene = VideoScene.parse({
    id: 'art',
    kind: 'composition',
    source,
    sourceNote: 'original',
    title: '',
    caption: '',
    duration: 4,
    compositionAssets: [{ name: 'world.png', source: image }]
  })
  const first = await stageComposition(dir, scene)
  expect(await fs.readFile(path.join(path.dirname(first), 'assets', 'world.png'), 'utf8')).toBe(
    'original pixels'
  )
  await fs.writeFile(image, 'revised original')
  const second = await stageComposition(dir, scene)
  expect(second).not.toBe(first)
  expect(await fs.readFile(path.join(path.dirname(first), 'assets', 'world.png'), 'utf8')).toBe(
    'original pixels'
  )
})
it('rejects undeclared outside files and file links escaping the scene', async () => {
  const dir = await fixture(),
    root = path.join(dir, 'scene'),
    outside = path.join(dir, 'private.txt')
  await fs.mkdir(root)
  await fs.writeFile(outside, 'private')
  await expect(compositionFile(pathToFileURL(outside).href, root, root)).rejects.toThrow('工程之外')
  const junction = path.join(root, 'linked')
  await fs.symlink(dir, junction, 'junction')
  await expect(
    compositionFile(pathToFileURL(path.join(junction, 'private.txt')).href, root, root)
  ).rejects.toThrow('工程外')
})
it('rejects ambiguous asset names and traversal at the input boundary', async () => {
  const dir = await fixture(),
    source = path.join(dir, 'scene.html'),
    asset = path.join(dir, 'a.png')
  await fs.writeFile(source, '<html/>')
  await fs.writeFile(asset, 'pixels')
  const base = {
    id: 'art',
    kind: 'composition',
    source,
    sourceNote: 'original',
    title: '',
    caption: '',
    duration: 4
  }
  expect(
    VideoScene.safeParse({ ...base, compositionAssets: [{ name: '../escape.png', source: asset }] })
      .success
  ).toBe(false)
  await expect(
    stageComposition(
      dir,
      VideoScene.parse({
        ...base,
        compositionAssets: [
          { name: 'A.png', source: asset },
          { name: 'a.png', source: asset }
        ]
      })
    )
  ).rejects.toThrow('重复')
})

it('names the scene and the undeclared asset instead of failing later with a raw ENOENT', async () => {
  const dir = await fixture()
  const source = path.join(dir, 'hook.html')
  await fs.writeFile(source, '<video src="assets/aifilm.mp4"></video><img src="./assets/ok.png">')
  const image = path.join(dir, 'ok.png')
  await fs.writeFile(image, 'pixels')
  const scene = VideoScene.parse({
    id: 'hook',
    kind: 'composition',
    source,
    sourceNote: '',
    title: '',
    caption: '',
    duration: 4,
    compositionAssets: [{ name: 'ok.png', source: image }]
  })
  await expect(stageComposition(dir, scene)).rejects.toThrow(
    /镜头 hook 引用了 assets\/aifilm\.mp4，但没在 compositionAssets 里声明/
  )
})
it('finds asset references in attributes and CSS but not in absolute URLs', () => {
  expect(
    referencedAssets(
      `<img src="assets/a%20b.png"><div style="background:url('assets/bg.jpg')"></div>` +
        `<script src="https://cdn.example/assets/x.js"></script>` +
        `<!-- old: assets/draft.png --><p>see assets/logo.png</p>`
    )
  ).toEqual(['a b.png', 'bg.jpg'])
})
it('maps whole-film sample times into the scene that contains them and reports the rest', () => {
  const plan = planSampleTimes(
    [
      { id: 'hook', kind: 'composition', duration: 10 },
      { id: 'card', kind: 'text', duration: 5 },
      { id: 'outro', kind: 'composition', duration: 10 }
    ],
    [5, 12, 16, 40]
  )
  expect(plan.scenes.map((scene) => scene.start)).toEqual([0, 10, 15])
  expect(plan.scenes[0].local).toEqual([5])
  expect(plan.scenes[2].local).toEqual([1])
  expect(plan.dropped.map((item) => item.time)).toEqual([12, 40])
})
