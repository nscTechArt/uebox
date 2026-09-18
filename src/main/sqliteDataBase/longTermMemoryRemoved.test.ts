import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..')
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf-8')

describe('长期记忆功能已移除', () => {
  it('不再携带记忆模型、服务、IPC 和管理页面', () => {
    for (const relative of [
      'src/main/sqliteDataBase/models/memory.ts',
      'src/main/sqliteDataBase/services/memoryService.ts',
      'src/main/sqliteDataBase/ipc/memory.ts',
      'src/renderer/src/views/System/Preferences/panels/MemoryManager.vue',
      'src/renderer/src/views/System/Preferences/panels/MemoryTestModal.vue'
    ]) {
      expect(existsSync(join(ROOT, relative)), relative).toBe(false)
    }
  })

  it('数据库初始化、IPC 和 preload 不再注册记忆能力', () => {
    const modelIndex = read('src/main/sqliteDataBase/models/index.ts')
    const ipcIndex = read('src/main/sqliteDataBase/ipc/index.ts')
    expect(modelIndex).not.toContain('initMemoryModel')
    expect(modelIndex).not.toContain("'./memory'")
    expect(ipcIndex).not.toContain('registerMemoryIPC')
    expect(ipcIndex).not.toContain("'./memory'")
    expect(read('src/preload/index.ts')).not.toContain('db:memory:')

    const embeddingReconcile = read('src/main/sqliteDataBase/services/embeddingReconcile.ts')
    expect(embeddingReconcile).not.toContain('memory_vectors')
    expect(embeddingReconcile).not.toContain('memories')
  })

  it('Agent、设置页和持久化配置不再保留开关', () => {
    for (const relative of [
      'src/renderer/src/api/ai.ts',
      'src/renderer/src/store/modules/aiConfig.ts',
      'src/renderer/src/views/Assistant/composables/useAgentMode.ts'
    ]) {
      expect(read(relative), relative).not.toContain('longTermMemoryEnabled')
    }

    const profile = read('src/renderer/src/views/System/Preferences/panels/ProfileAI.vue')
    expect(profile).not.toContain('MemoryManager')
    expect(profile).not.toContain('MemoryTestModal')
    expect(profile).not.toContain('profile.ai.memoryTitle')
  })

  it('中英文文案、变更说明和质量基线不再宣传或追踪该功能', () => {
    const sources = [
      read('src/renderer/src/i18n/locales/zh-CN.ts'),
      read('src/renderer/src/i18n/locales/en-US.ts'),
      read('CHANGELOG.md'),
      read('src/main/ai/embedding.ts')
    ]

    expect(sources.join('\n')).not.toMatch(/长期记忆|long-term memory/i)
    expect(read('scripts/colors.baseline.json')).not.toContain('MemoryManager.vue')
    expect(read('scripts/lint.baseline.json')).not.toContain('MemoryTestModal.vue')
  })
})
