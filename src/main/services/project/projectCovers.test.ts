import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createProject,
  deleteProjectByKey,
  getProjectByKey,
  initProjectModel
} from '../../sqliteDataBase/models/project'
import { initProjectCollectionModel } from '../../sqliteDataBase/models/projectCollection'
import { ProjectCoverService } from './projectCovers'

let directory: string
let db: Database.Database
let covers: ProjectCoverService

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'project-covers-'))
  db = new Database(':memory:')
  initProjectCollectionModel(db)
  initProjectModel(db)
  covers = new ProjectCoverService(db, directory)
})

it('migrates known imported covers to auto and preserves manual and unknown covers', async () => {
  createProject(db, {
    projectKey: 'imported',
    image: 'thumbnail-12345678-1234-1234-1234-123456789abc.png'
  })
  createProject(db, { projectKey: 'manual', image: 'project_cover_123_12345678.jpg' })
  createProject(db, { projectKey: 'unknown', image: 'my-poster.png' })
  createProject(db, { projectKey: 'empty' })
  await covers.sync()
  expect(getProjectByKey(db, 'imported')?.coverMode).toBe('auto')
  expect(getProjectByKey(db, 'manual')?.coverMode).toBe('custom')
  expect(getProjectByKey(db, 'unknown')).toMatchObject({
    coverMode: 'custom',
    image: 'my-poster.png'
  })
  expect(getProjectByKey(db, 'empty')?.coverMode).toBe('auto')
  await covers.sync()
  expect(getProjectByKey(db, 'manual')?.coverMode).toBe('custom')
})

it('recovers custom cover ownership from disk when rebuilding the project index', async () => {
  const projectPath = join(directory, 'game')
  createProject(db, { projectKey: 'old-key', projectPath })
  const image = await covers.save('old-key', Buffer.from('user artwork'))
  deleteProjectByKey(db, 'old-key')
  createProject(db, { projectKey: 'new-key', projectPath, coverMode: 'auto' })
  await new ProjectCoverService(db, directory).sync()
  expect(getProjectByKey(db, 'new-key')).toMatchObject({ image, coverMode: 'custom' })
  expect(await readFile(join(directory, image), 'utf8')).toBe('user artwork')
})

it.each(['save', 'remove'] as const)(
  '%s preserves covers referenced by projects not yet restored into the index',
  async (action) => {
    const image = 'project_cover_123_12345678.jpg'
    const firstPath = join(directory, 'first')
    const secondPath = join(directory, 'second')
    await writeFile(join(directory, image), 'shared cover')
    createProject(db, { projectKey: 'first', projectPath: firstPath, image })
    createProject(db, { projectKey: 'second', projectPath: secondPath, image })
    await covers.sync()

    // Rebuild only part of the index; both authoritative disk records still exist.
    deleteProjectByKey(db, 'first')
    deleteProjectByKey(db, 'second')
    createProject(db, { projectKey: 'restored-first', projectPath: firstPath })
    await covers.sync()
    if (action === 'save') await covers.save('restored-first', Buffer.from('replacement'))
    else await covers.remove('restored-first')

    createProject(db, { projectKey: 'restored-second', projectPath: secondPath })
    await covers.sync()
    expect(getProjectByKey(db, 'restored-second')).toMatchObject({ image, coverMode: 'custom' })
    expect(await readFile(join(directory, image), 'utf8')).toBe('shared cover')

    await covers.remove('restored-second')
    await expect(readFile(join(directory, image))).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

it('keeps old images when a disk record cannot be decoded, without failing the save', async () => {
  createProject(db, { projectKey: 'one' })
  const image = await covers.save('one', Buffer.from('original'))
  await writeFile(join(directory, 'project-covers', 'damaged.json'), '{')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const replacement = await covers.save('one', Buffer.from('replacement'))
    expect(getProjectByKey(db, 'one')?.image).toBe(replacement)
    expect(await readFile(join(directory, image), 'utf8')).toBe('original')
    expect(warning).toHaveBeenCalled()
  } finally {
    warning.mockRestore()
  }
})

it('does not rewrite an unchanged screenshot, even after restart or a timestamp-only change', async () => {
  const changed = vi.fn()
  const projectDir = join(directory, 'game')
  await mkdir(join(projectDir, 'Saved'), { recursive: true })
  const source = join(projectDir, 'Saved', 'AutoScreenshot.png')
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  await writeFile(source, png)
  createProject(db, { projectKey: 'one', projectPath: projectDir })
  await covers.sync()
  const original = getProjectByKey(db, 'one')?.image
  const restarted = new ProjectCoverService(db, directory, changed)
  await restarted.sync()
  await utimes(source, new Date(), new Date(Date.now() + 10000))
  await restarted.sync()
  expect(getProjectByKey(db, 'one')?.image).toBe(original)
  expect(changed).not.toHaveBeenCalled()
})

it('rebuilds a missing automatic cover without a source change or service restart', async () => {
  const changed = vi.fn()
  covers = new ProjectCoverService(db, directory, changed)
  const projectDir = join(directory, 'game')
  await mkdir(join(projectDir, 'Saved'), { recursive: true })
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  await writeFile(join(projectDir, 'Saved', 'AutoScreenshot.png'), png)
  createProject(db, { projectKey: 'one', projectPath: projectDir })
  await covers.sync()
  const original = getProjectByKey(db, 'one')?.image || ''
  changed.mockClear()

  await fs.unlink(join(directory, original))
  await covers.sync()

  const restored = getProjectByKey(db, 'one')
  expect(restored?.coverMode).toBe('auto')
  expect(restored?.image).not.toBe(original)
  expect(await readFile(join(directory, restored?.image || ''))).toEqual(png)
  expect(changed).toHaveBeenCalledTimes(1)

  await covers.sync()
  expect(getProjectByKey(db, 'one')?.image).toBe(restored?.image)
  expect(changed).toHaveBeenCalledTimes(1)
})

it('adds the cover mode index to old databases idempotently without discarding old images', () => {
  createProject(db, { projectKey: 'one', image: 'poster.png' })
  db.exec('ALTER TABLE projects DROP COLUMN coverMode')
  initProjectModel(db)
  initProjectModel(db)
  expect(getProjectByKey(db, 'one')).toMatchObject({ image: 'poster.png', coverMode: null })
})

it('removing a project clears its cover record so reimport starts in automatic mode', async () => {
  const projectPath = join(directory, 'game')
  createProject(db, { projectKey: 'one', projectPath })
  const image = await covers.save('one', Buffer.from('custom'))
  await covers.remove('one')
  expect(getProjectByKey(db, 'one')).toBeUndefined()
  await expect(readFile(join(directory, image))).rejects.toMatchObject({ code: 'ENOENT' })
  createProject(db, { projectKey: 'two', projectPath, coverMode: 'auto' })
  await covers.sync()
  expect(getProjectByKey(db, 'two')).toMatchObject({ coverMode: 'auto', image: '' })
})

it.each(['save', 'remove', 'restoreAutomatic'] as const)(
  '%s recovers from its own malformed cover record',
  async (action) => {
    createProject(db, { projectKey: 'one' })
    const original = await covers.save('one', Buffer.from('original'))
    const [record] = await readdir(join(directory, 'project-covers'))
    const recordPath = join(directory, 'project-covers', record)
    await writeFile(recordPath, '{')

    if (action === 'save') {
      const image = await covers.save('one', Buffer.from('replacement'))
      expect(getProjectByKey(db, 'one')).toMatchObject({ image, coverMode: 'custom' })
      expect(await readFile(join(directory, image), 'utf8')).toBe('replacement')
    } else if (action === 'remove') {
      await expect(covers.remove('one')).resolves.toBe(true)
      expect(getProjectByKey(db, 'one')).toBeUndefined()
      await expect(readFile(recordPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(directory, original))).rejects.toMatchObject({ code: 'ENOENT' })
      return
    } else {
      await covers.restoreAutomatic('one')
      expect(getProjectByKey(db, 'one')).toMatchObject({ image: original, coverMode: 'auto' })
    }
    expect(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({
      version: 1,
      image: getProjectByKey(db, 'one')?.image,
      mode: action === 'save' ? 'custom' : 'auto'
    })
  }
)

it.each(['', '{"version":1,"mode":"broken"}'])(
  'allows an explicit replacement of an invalid cover record: %s',
  async (contents) => {
    createProject(db, { projectKey: 'one' })
    await covers.save('one', Buffer.from('original'))
    const [record] = await readdir(join(directory, 'project-covers'))
    await writeFile(join(directory, 'project-covers', record), contents)
    await covers.restoreAutomatic('one')
    expect(getProjectByKey(db, 'one')?.coverMode).toBe('auto')
  }
)

it.each(['save', 'remove', 'restoreAutomatic'] as const)(
  '%s restores the exact malformed bytes if its database mutation fails',
  async (action) => {
    createProject(db, { projectKey: 'one' })
    const image = await covers.save('one', Buffer.from('original'))
    const [record] = await readdir(join(directory, 'project-covers'))
    const recordPath = join(directory, 'project-covers', record)
    const damaged = Buffer.from([0xff, 0x7b, 0x00])
    await writeFile(recordPath, damaged)
    const mutation = action === 'remove' ? 'DELETE' : 'UPDATE'
    db.exec(
      `CREATE TRIGGER fail_mutation BEFORE ${mutation} ON projects BEGIN SELECT RAISE(ABORT, 'mutation failed'); END`
    )
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const operation =
        action === 'save' ? covers.save('one', Buffer.from('replacement')) : covers[action]('one')
      await expect(operation).rejects.toThrow('mutation failed')
      expect(await readFile(recordPath)).toEqual(damaged)
      expect(getProjectByKey(db, 'one')).toMatchObject({ image, coverMode: 'custom' })
      expect(await readFile(join(directory, image), 'utf8')).toBe('original')
    } finally {
      warning.mockRestore()
    }
  }
)

it.each(['save', 'restoreAutomatic'] as const)(
  '%s still protects an unsupported cover record version',
  async (action) => {
    createProject(db, { projectKey: 'one' })
    const image = await covers.save('one', Buffer.from('original'))
    const [record] = await readdir(join(directory, 'project-covers'))
    const recordPath = join(directory, 'project-covers', record)
    const future = JSON.stringify({ version: 2, mode: 'custom', image })
    await writeFile(recordPath, future)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const operation =
        action === 'save' ? covers.save('one', Buffer.from('replacement')) : covers[action]('one')
      await expect(operation).rejects.toThrow()
      expect(await readFile(recordPath, 'utf8')).toBe(future)
      expect(getProjectByKey(db, 'one')).toMatchObject({ image, coverMode: 'custom' })
    } finally {
      warning.mockRestore()
    }
  }
)

it('remove deletes the project but keeps an unsupported cover record and its image', async () => {
  createProject(db, { projectKey: 'one' })
  const image = await covers.save('one', Buffer.from('original'))
  const [record] = await readdir(join(directory, 'project-covers'))
  const recordPath = join(directory, 'project-covers', record)
  const future = JSON.stringify({ version: 2, mode: 'custom', image })
  await writeFile(recordPath, future)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await expect(covers.remove('one')).resolves.toBe(true)
    expect(getProjectByKey(db, 'one')).toBeUndefined()
    expect(await readFile(recordPath, 'utf8')).toBe(future)
    expect(await readFile(join(directory, image), 'utf8')).toBe('original')
  } finally {
    warning.mockRestore()
  }
})

it('logs a persistent sync failure once instead of on every scan', async () => {
  createProject(db, { projectKey: 'one' })
  await covers.save('one', Buffer.from('original'))
  const [record] = await readdir(join(directory, 'project-covers'))
  await writeFile(join(directory, 'project-covers', record), '{')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const restarted = new ProjectCoverService(db, directory)
    await restarted.sync()
    await restarted.sync()
    await restarted.sync()
    expect(warning).toHaveBeenCalledTimes(1)
  } finally {
    warning.mockRestore()
  }
})

it('background sync preserves a malformed record instead of repairing it from the index', async () => {
  createProject(db, { projectKey: 'one' })
  const image = await covers.save('one', Buffer.from('original'))
  const [record] = await readdir(join(directory, 'project-covers'))
  const recordPath = join(directory, 'project-covers', record)
  await writeFile(recordPath, '{')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await covers.sync()
    expect(await readFile(recordPath, 'utf8')).toBe('{')
    expect(getProjectByKey(db, 'one')).toMatchObject({ image, coverMode: 'custom' })
  } finally {
    warning.mockRestore()
  }
})

it.each(['save', 'remove', 'restoreAutomatic'] as const)(
  '%s does not treat an unreadable record as malformed data',
  async (action) => {
    createProject(db, { projectKey: 'one' })
    const image = await covers.save('one', Buffer.from('original'))
    const [record] = await readdir(join(directory, 'project-covers'))
    const recordPath = join(directory, 'project-covers', record)
    const before = await readFile(recordPath)
    // A directory at the record path produces a real filesystem read failure on Windows/Linux.
    const backupPath = `${recordPath}.backup`
    await fs.rename(recordPath, backupPath)
    await mkdir(recordPath)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const operation =
        action === 'save' ? covers.save('one', Buffer.from('replacement')) : covers[action]('one')
      if (action === 'remove') {
        // Removing a project never depends on cover metadata; the unreadable record is left alone.
        await expect(operation).resolves.toBe(true)
        expect(getProjectByKey(db, 'one')).toBeUndefined()
        expect(await readFile(backupPath)).toEqual(before)
        expect(await readFile(join(directory, image), 'utf8')).toBe('original')
        return
      }
      await expect(operation).rejects.toMatchObject({ code: 'EISDIR' })
      expect(await readFile(backupPath)).toEqual(before)
      expect(getProjectByKey(db, 'one')).toMatchObject({ image, coverMode: 'custom' })
    } finally {
      warning.mockRestore()
    }
  }
)

afterEach(async () => {
  await covers?.stop()
  vi.useRealTimers()
  db?.close()
  await rm(directory, { recursive: true, force: true })
})

it('syncs immediately at startup and keeps checking without a renderer or plugin connection', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const projectDir = join(directory, 'game')
  await mkdir(join(projectDir, 'Saved'), { recursive: true })
  const source = join(projectDir, 'Saved', 'AutoScreenshot.png')
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  await writeFile(source, png)
  createProject(db, { projectKey: 'one', projectPath: projectDir })
  await covers.start()
  const first = getProjectByKey(db, 'one')?.image
  expect(first).toBeTruthy()
  const updated = await sharp(png).negate().png().toBuffer()
  await writeFile(source, updated)
  await vi.advanceTimersByTimeAsync(5000)
  await covers.stop()
  const last = getProjectByKey(db, 'one')?.image || ''
  expect(last).not.toBe(first)
  expect(await readFile(join(directory, last))).toEqual(updated)
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['success', 'failure'] as const)(
  'keeps polling other projects during a stalled read, then handles its %s without queued scans',
  async (outcome) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const slowDir = join(directory, 'slow')
    const localDir = join(directory, 'local')
    const slowSource = join(slowDir, 'Saved', 'AutoScreenshot.png')
    const localSource = join(localDir, 'Saved', 'AutoScreenshot.png')
    let png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .png()
      .toBuffer()
    for (const projectDir of [slowDir, localDir]) {
      await mkdir(join(projectDir, 'Saved'), { recursive: true })
      await writeFile(join(projectDir, 'Saved', 'AutoScreenshot.png'), png)
    }
    createProject(db, { projectKey: 'slow', projectPath: slowDir })
    createProject(db, { projectKey: 'local', projectPath: localDir })

    const stalled = Promise.withResolvers<void>()
    const realStat = fs.stat
    let slowReads = 0
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
      if (String(args[0]) === slowSource && ++slowReads === 1) {
        await stalled.promise
        if (outcome === 'failure') throw Object.assign(new Error('Offline'), { code: 'ENOENT' })
      }
      return realStat(...args)
    })
    const started = covers.start()
    try {
      await vi.waitFor(() => expect(getProjectByKey(db, 'local')?.image).toBeTruthy())
      // A parallel first scan alone is insufficient: later ticks must also keep progressing.
      for (let tick = 0; tick < 2; tick++) {
        const previous = getProjectByKey(db, 'local')?.image
        png = await sharp(png).negate().png().toBuffer()
        await writeFile(localSource, png)
        await vi.advanceTimersByTimeAsync(5000)
        await vi.waitFor(() => expect(getProjectByKey(db, 'local')?.image).not.toBe(previous))
        const image = getProjectByKey(db, 'local')?.image || ''
        expect(await readFile(join(directory, image))).toEqual(png)
      }
      expect(slowReads).toBe(1)
      expect(getProjectByKey(db, 'slow')?.image).toBe('')

      let stopped = false
      const stopping = covers.stop().then(() => {
        stopped = true
      })
      await vi.advanceTimersByTimeAsync(10000)
      expect(stopped).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      stalled.resolve()
      await Promise.all([started, stopping])
      // Successful decoding stats twice; no additional scan should have accumulated.
      expect(slowReads).toBe(outcome === 'success' ? 2 : 1)
      expect(Boolean(getProjectByKey(db, 'slow')?.image)).toBe(outcome === 'success')
      await covers.start()
      expect(getProjectByKey(db, 'slow')?.image).toBeTruthy()
    } finally {
      stalled.resolve()
      await started
      await covers.stop()
      statSpy.mockRestore()
    }
  }
)

it('bounds concurrent screenshot reads and releases a slot after a read failure', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  const sources: string[] = []
  for (let index = 0; index < 6; index++) {
    const projectDir = join(directory, `game-${index}`)
    const source = join(projectDir, 'Saved', 'AutoScreenshot.png')
    await mkdir(join(projectDir, 'Saved'), { recursive: true })
    await writeFile(source, png)
    createProject(db, { projectKey: `project-${index}`, projectPath: projectDir })
    sources.push(source)
  }

  const gate = Promise.withResolvers<void>()
  const realReadFile = fs.readFile
  let activeReads = 0
  let peakReads = 0
  let failedOnce = false
  const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (!sources.includes(String(args[0]))) return realReadFile(...args)
    activeReads++
    peakReads = Math.max(peakReads, activeReads)
    try {
      await gate.promise
      if (args[0] === sources[0] && !failedOnce) {
        failedOnce = true
        throw new Error('Read failed')
      }
      return await realReadFile(...args)
    } finally {
      activeReads--
    }
  })

  const scan = covers.sync()
  try {
    await vi.waitFor(() => expect(activeReads).toBe(4))
    expect(peakReads).toBe(4)
  } finally {
    gate.resolve()
    try {
      await scan
    } finally {
      readSpy.mockRestore()
    }
  }
  expect(peakReads).toBe(4)
  expect(getProjectByKey(db, 'project-0')?.image).toBe('')
  for (let index = 1; index < 6; index++) {
    expect(getProjectByKey(db, `project-${index}`)?.image).toBeTruthy()
  }
  await covers.sync()
  expect(getProjectByKey(db, 'project-0')?.image).toBeTruthy()
})

it('serializes overlapping replacements without leaving unused images', async () => {
  createProject(db, { projectKey: 'one' })
  await Promise.all([
    covers.save('one', Buffer.from('first')),
    covers.save('one', Buffer.from('second'))
  ])
  const image = getProjectByKey(db, 'one')?.image || ''
  expect(await readFile(join(directory, image), 'utf8')).toBe('second')
  expect((await readdir(directory)).filter((name) => name !== 'project-covers')).toEqual([image])
})

it('replaces a cover and removes the previous managed image only after saving', async () => {
  const oldImage = 'project_cover_123_12345678.jpg'
  await writeFile(join(directory, oldImage), 'old')
  createProject(db, { projectKey: 'one', image: oldImage })

  const image = await covers.save('one', Buffer.from('new image'))

  expect(getProjectByKey(db, 'one')?.image).toBe(image)
  expect(await readFile(join(directory, image), 'utf8')).toBe('new image')
  expect((await readdir(directory)).filter((name) => name !== 'project-covers')).toEqual([image])
})

it('rejects a missing project without writing an image or reporting success', async () => {
  await expect(covers.save('missing', Buffer.from('new'))).rejects.toThrow(
    'Project no longer exists'
  )
  expect(await readdir(directory)).toEqual([])
})

it('rolls back the new image when the project index cannot be updated', async () => {
  const oldImage = 'project_cover_123_12345678.jpg'
  createProject(db, { projectKey: 'one', image: oldImage })
  await writeFile(join(directory, oldImage), 'old')
  db.exec(
    "CREATE TRIGGER fail_cover BEFORE UPDATE OF image ON projects BEGIN SELECT RAISE(ABORT, 'disk full'); END"
  )

  await expect(covers.save('one', Buffer.from('new'))).rejects.toThrow('disk full')
  expect(getProjectByKey(db, 'one')?.image).toBe(oldImage)
  expect((await readdir(directory)).filter((name) => name !== 'project-covers')).toEqual([oldImage])
})

it('reports a successful removal even when the library notification throws', async () => {
  const changed = vi.fn()
  covers = new ProjectCoverService(db, directory, changed)
  createProject(db, { projectKey: 'one' })
  const image = await covers.save('one', Buffer.from('cover'))
  const error = new Error('Web contents destroyed')
  changed.mockImplementation(() => {
    throw error
  })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await expect(covers.remove('one')).resolves.toBe(true)
    expect(getProjectByKey(db, 'one')).toBeUndefined()
    expect(await readdir(join(directory, 'project-covers'))).toEqual([])
    await expect(readFile(join(directory, image))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(warning).toHaveBeenCalledWith('[ProjectCover] Notification failed:', error)
  } finally {
    warning.mockRestore()
  }
})

it('still rejects a database deletion failure and restores the cover record', async () => {
  const changed = vi.fn()
  covers = new ProjectCoverService(db, directory, changed)
  createProject(db, { projectKey: 'one' })
  const image = await covers.save('one', Buffer.from('cover'))
  const [record] = await readdir(join(directory, 'project-covers'))
  const before = await readFile(join(directory, 'project-covers', record), 'utf8')
  changed.mockClear()
  db.exec(
    "CREATE TRIGGER fail_remove BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'delete failed'); END"
  )

  await expect(covers.remove('one')).rejects.toThrow('delete failed')
  expect(getProjectByKey(db, 'one')?.image).toBe(image)
  expect(await readFile(join(directory, 'project-covers', record), 'utf8')).toBe(before)
  expect(await readFile(join(directory, image), 'utf8')).toBe('cover')
  expect(changed).not.toHaveBeenCalled()
})

it('keeps an old image that another project still uses', async () => {
  const oldImage = 'project_cover_123_12345678.jpg'
  await writeFile(join(directory, oldImage), 'shared')
  createProject(db, { projectKey: 'one', image: oldImage })
  createProject(db, { projectKey: 'two', image: oldImage })
  await covers.save('one', Buffer.from('new'))
  expect(await readFile(join(directory, oldImage), 'utf8')).toBe('shared')
})

it('keeps a changed screenshot from replacing a custom cover', async () => {
  const projectDir = join(directory, 'game')
  await mkdir(join(projectDir, 'Saved'), { recursive: true })
  const screenshot = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'red' }
  })
    .png()
    .toBuffer()
  await writeFile(join(projectDir, 'Saved', 'AutoScreenshot.png'), screenshot)
  createProject(db, { projectKey: 'one', projectPath: projectDir })

  await covers.sync()
  const image = getProjectByKey(db, 'one')?.image || ''
  expect(await readFile(join(directory, image))).toEqual(screenshot)
  expect(getProjectByKey(db, 'one')?.coverMode).toBe('auto')

  await covers.save('one', Buffer.from('my custom cover'))
  await writeFile(
    join(projectDir, 'Saved', 'AutoScreenshot.png'),
    await sharp(screenshot).negate().png().toBuffer()
  )
  await covers.sync()
  const custom = getProjectByKey(db, 'one')
  expect(custom?.coverMode).toBe('custom')
  expect(await readFile(join(directory, custom?.image || ''), 'utf8')).toBe('my custom cover')
})

it('prefers <Name>.png over AutoScreenshot.png, like the UE project browser', async () => {
  const projectDir = join(directory, 'game')
  await mkdir(join(projectDir, 'Saved'), { recursive: true })
  const thumbnail = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  const screenshot = await sharp(thumbnail).negate().png().toBuffer()
  await writeFile(join(projectDir, 'MyGame.png'), thumbnail)
  await writeFile(join(projectDir, 'Saved', 'AutoScreenshot.png'), screenshot)
  createProject(db, {
    projectKey: 'one',
    projectPath: projectDir,
    originPath: join(projectDir, 'MyGame.uproject')
  })

  await covers.sync()
  expect(await readFile(join(directory, getProjectByKey(db, 'one')?.image || ''))).toEqual(
    thumbnail
  )

  // Without an explicit thumbnail the editor's screenshot takes over.
  await rm(join(projectDir, 'MyGame.png'))
  await covers.sync()
  expect(await readFile(join(directory, getProjectByKey(db, 'one')?.image || ''))).toEqual(
    screenshot
  )
})

it('keeps a legacy <Name>.png cover when an AutoScreenshot.png also exists', async () => {
  const projectDir = join(directory, 'game')
  await mkdir(join(projectDir, 'Saved'), { recursive: true })
  const thumbnail = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  await writeFile(join(projectDir, 'MyGame.png'), thumbnail)
  await writeFile(
    join(projectDir, 'Saved', 'AutoScreenshot.png'),
    await sharp(thumbnail).negate().png().toBuffer()
  )
  // Imported before cover modes existed: a copy of <Name>.png under a generated name.
  const legacy = 'thumbnail-12345678-1234-1234-1234-123456789abc.png'
  await writeFile(join(directory, legacy), thumbnail)
  createProject(db, {
    projectKey: 'one',
    projectPath: projectDir,
    originPath: join(projectDir, 'MyGame.uproject'),
    image: legacy
  })

  await covers.sync()
  expect(getProjectByKey(db, 'one')).toMatchObject({ image: legacy, coverMode: 'auto' })
  expect(await readFile(join(directory, legacy))).toEqual(thumbnail)
})

it.each([
  ['empty', async () => Buffer.alloc(0)],
  ['undecodable', async () => Buffer.from('not a png')]
] as const)('falls back to AutoScreenshot.png when <Name>.png is %s', async (_, thumbnail) => {
  const projectDir = join(directory, 'game')
  await mkdir(join(projectDir, 'Saved'), { recursive: true })
  const screenshot = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'red' }
  })
    .png()
    .toBuffer()
  await writeFile(join(projectDir, 'MyGame.png'), await thumbnail())
  await writeFile(join(projectDir, 'Saved', 'AutoScreenshot.png'), screenshot)
  createProject(db, {
    projectKey: 'one',
    projectPath: projectDir,
    originPath: join(projectDir, 'MyGame.uproject')
  })

  await covers.sync()
  await covers.sync()
  expect(await readFile(join(directory, getProjectByKey(db, 'one')?.image || ''))).toEqual(
    screenshot
  )
})

it('does not reread an undecodable screenshot until the file changes', async () => {
  const projectDir = join(directory, 'game')
  const source = join(projectDir, 'Saved', 'AutoScreenshot.png')
  await mkdir(join(projectDir, 'Saved'), { recursive: true })
  await writeFile(source, 'not a png')
  createProject(db, { projectKey: 'one', projectPath: projectDir })
  const readSpy = vi.spyOn(fs, 'readFile')
  const sourceReads = (): number =>
    readSpy.mock.calls.filter((args) => String(args[0]) === source).length
  try {
    await covers.sync()
    await covers.sync()
    await covers.sync()
    expect(sourceReads()).toBe(1)
    expect(getProjectByKey(db, 'one')?.image).toBe('')

    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
      .png()
      .toBuffer()
    await writeFile(source, png)
    await covers.sync()
    expect(sourceReads()).toBe(2)
    expect(await readFile(join(directory, getProjectByKey(db, 'one')?.image || ''))).toEqual(png)
  } finally {
    readSpy.mockRestore()
  }
})

it('restoring automatic mode retains the custom image until a valid screenshot is available', async () => {
  const projectDir = join(directory, 'game')
  createProject(db, { projectKey: 'one', projectPath: projectDir })
  const custom = await covers.save('one', Buffer.from('custom'))
  await covers.restoreAutomatic('one')
  expect(getProjectByKey(db, 'one')).toMatchObject({ image: custom, coverMode: 'auto' })
  await mkdir(join(projectDir, 'Saved'), { recursive: true })
  const source = join(projectDir, 'Saved', 'AutoScreenshot.png')
  await writeFile(source, 'incomplete PNG')
  await covers.sync()
  expect(getProjectByKey(db, 'one')?.image).toBe(custom)
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } })
    .png()
    .toBuffer()
  await writeFile(source, png)
  await covers.sync()
  const image = getProjectByKey(db, 'one')?.image || ''
  expect(await readFile(join(directory, image))).toEqual(png)
  await expect(readFile(join(directory, custom))).rejects.toMatchObject({ code: 'ENOENT' })
})
