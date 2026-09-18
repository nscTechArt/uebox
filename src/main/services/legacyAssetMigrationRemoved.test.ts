import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..')
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf-8')

const migrationChannels = [
  'uebox:check-legacy-data',
  'uebox:delete-file',
  'uebox:scan-backup',
  'uebox:select-backup-file',
  'uebox:select-library-folder',
  'uebox:start-migration',
  'uebox:migration-progress'
]

describe('旧版 UeBox 资产迁移已移除', () => {
  it('不再携带迁移服务、IPC、页面和专用图片', () => {
    for (const relative of [
      'src/main/ipc/ueboxMigration.ts',
      'src/main/services/migration/UeBoxMigrationService.ts',
      'src/renderer/src/views/MigrationAssets/index.vue',
      'src/renderer/src/assets/imgs/route.png',
      'src/renderer/src/assets/imgs/zip.png'
    ]) {
      expect(existsSync(join(ROOT, relative)), relative).toBe(false)
    }
  })

  it('主进程不注册、preload 不放行旧迁移通道', () => {
    const mainIpc = read('src/main/ipc/index.ts')
    const preload = read('src/preload/index.ts')

    expect(mainIpc).not.toContain('registerUeBoxMigrationIPC')
    for (const channel of migrationChannels) {
      expect(preload, channel).not.toContain(channel)
    }
  })

  it('资产页、偏好设置和路由表都没有迁移入口', () => {
    const sources = [
      read('src/renderer/src/views/AssetManagement/index.vue'),
      read('src/renderer/src/views/System/Preferences/panels/ProfileAsset.vue'),
      read('src/renderer/src/router/modules/mainRoutes.ts')
    ]

    for (const source of sources) {
      expect(source).not.toContain('MigrationAssets')
      expect(source).not.toContain('ignore-uebox-migration')
    }
  })

  it('不再携带旧资产迁移文案和专用依赖', () => {
    const locales = [
      read('src/renderer/src/i18n/locales/zh-CN.ts'),
      read('src/renderer/src/i18n/locales/en-US.ts')
    ]

    expect(locales[0]).not.toContain('检测到您有旧版 UeBox 资产数据')
    expect(locales[1]).not.toContain('Legacy UeBox asset data detected')
    expect(read('package.json')).not.toContain('node-stream-zip')
  })
})
