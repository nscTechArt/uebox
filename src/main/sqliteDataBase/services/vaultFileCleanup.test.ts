/**
 * vaultFileCleanup.test.ts —— 「清空回收站」到底在磁盘上删了什么
 *
 * 这一层是真正动手 unlink 的地方，所以这里用真的临时目录、真的文件，
 * 只把 PathManager（保管库定位）换成假的。
 *
 * 之所以有这个文件：资产有**两个独立的缩略图字段**——
 *   imgLocalPath  = 导入时从 uasset 里抽出来的 `thumbnail-<assetKey>.jpg`
 *   customPoster  = 用户自选封面 / 视频自动抽帧，`custom-xxx.png` + `custom-xxx_thumb.jpg`
 * 以前清理只看 imgLocalPath，于是自定义封面在 thumbnails 目录里永久残留。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ThumbnailManager 在模块顶层就 import 了 electron，这里只需要它的纯函数
vi.mock('electron', () => ({ nativeImage: {} }))

const vaultPaths = { root: '' }

vi.mock('../../utils/PathManager', () => ({
  PathManager: {
    getInstance: () => ({
      getCurrentVaultPath: () => vaultPaths.root,
      getAssetDataPath: () => join(vaultPaths.root, 'assetData'),
      getThumbnailsPath: () => join(vaultPaths.root, 'thumbnails')
    })
  }
}))

const thumbs = (name: string): string => join(vaultPaths.root, 'thumbnails', name)
const assetData = (name: string): string => join(vaultPaths.root, 'assetData', name)

const touch = (path: string): string => {
  writeFileSync(path, 'x')
  return path
}

describe('deleteVaultBackupAndThumbnail', () => {
  beforeEach(() => {
    vaultPaths.root = mkdtempSync(join(tmpdir(), 'vault-cleanup-'))
    mkdirSync(join(vaultPaths.root, 'thumbnails'), { recursive: true })
    mkdirSync(join(vaultPaths.root, 'assetData'), { recursive: true })
  })

  afterEach(() => {
    rmSync(vaultPaths.root, { recursive: true, force: true })
  })

  it('自定义封面和它的 _thumb 压缩版一起删掉，不再残留', async () => {
    const { deleteVaultBackupAndThumbnail } = await import('./vaultFileCleanup')

    const backup = touch(assetData('tree.uasset'))
    const imported = touch(thumbs('thumbnail-tree.jpg'))
    const poster = touch(thumbs('custom-tree-123.png'))
    const posterThumb = touch(thumbs('custom-tree-123_thumb.jpg'))

    await deleteVaultBackupAndThumbnail({
      filePath: backup,
      imgLocalPath: 'thumbnail-tree.jpg',
      customPoster: 'custom-tree-123.png'
    })

    expect(existsSync(backup)).toBe(false)
    expect(existsSync(imported)).toBe(false)
    expect(existsSync(poster)).toBe(false)
    expect(existsSync(posterThumb)).toBe(false)
  })

  it('customPoster 是外链时不按 basename 误删同名的本地缩略图', async () => {
    const { deleteVaultBackupAndThumbnail } = await import('./vaultFileCleanup')

    const innocent = touch(thumbs('cover.png'))

    await deleteVaultBackupAndThumbnail({
      filePath: null,
      imgLocalPath: null,
      customPoster: 'https://example.com/cover.png'
    })

    expect(existsSync(innocent)).toBe(true)
  })

  it('filePath 在 assetData 目录外就是用户的原始文件，绝不碰', async () => {
    const { deleteVaultBackupAndThumbnail } = await import('./vaultFileCleanup')

    const outside = touch(join(vaultPaths.root, 'original.uasset'))

    await deleteVaultBackupAndThumbnail({ filePath: outside })

    expect(existsSync(outside)).toBe(true)
  })
})
