import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'

import { checkImportCompatibility } from './projectImport'

vi.mock('@renderer/i18n', () => ({
  default: { global: { t: () => '版本没检查成' } }
}))

/**
 * 导入弹窗的版本预检，过 IPC 的参数必须是**能结构化克隆的普通数据**。
 *
 * 上一次发作在编辑器快照那条路上（见 `editorSnapshotIpcPayload.test.ts`）。这次同一个坑：
 * 弹窗手里的工程来自 `computed`、待导资产来自 `ref`，两边取出来都是 Vue 的响应式代理，
 * 直接丢进 `invoke` 就是 `An object could not be cloned.`。
 *
 * 而渲染端当时写的是 `} catch {`，异常连变量都没接 —— 界面上永远只有一句「版本没检查成」，
 * 谁也看不出真实原因。所以这里用**真的克隆**来测，不是比对象长相。
 */

/** Electron 那条通道真正做的事：结构化克隆一遍。搬不动就抛 */
function throughIpc<T>(value: T): T {
  return structuredClone(value)
}

const okResponse = { success: true, data: { projectVersion: '5.4', blocked: [] } }

let checkCompatibility: ReturnType<typeof vi.fn>

beforeEach(() => {
  checkCompatibility = vi.fn().mockResolvedValue(okResponse)
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { projectImport: { checkCompatibility } }
  }
})

describe('响应式代理不能直接过 IPC', () => {
  it('工程从 computed 里来、资产从 ref 里来，交给 IPC 的仍然是能克隆的普通数据', async () => {
    const projects = ref([
      { projectKey: 'forest', projectName: 'Forest', EngineAssociation: '5.4' }
    ])
    const selectedProject = computed(() => projects.value[0])
    const sourceAssets = ref([
      { assetKey: 'asset-1', assetName: 'M_Mountain.uasset' },
      { assetKey: 'asset-2', assetName: 'SM_Rock.uasset' }
    ])

    await checkImportCompatibility(selectedProject.value, sourceAssets.value)

    const [project, sources] = checkCompatibility.mock.calls[0]
    expect(() => throughIpc(project)).not.toThrow()
    expect(() => throughIpc(sources)).not.toThrow()
    expect(throughIpc(project)).toEqual({ EngineAssociation: '5.4' })
    expect(throughIpc(sources)).toEqual([{ assetKey: 'asset-1' }, { assetKey: 'asset-2' }])
  })

  it('只带主进程真正会读的字段，整行资产不搬过去', async () => {
    await checkImportCompatibility(
      { EngineAssociation: '5.6', projectName: 'Forest', image: 'data:image/png;base64,AAAA' } as {
        EngineAssociation: string
      },
      [{ assetKey: 'asset-1', thumbnail: 'data:image/png;base64,BBBB' } as { assetKey: string }]
    )

    const [project, sources] = checkCompatibility.mock.calls[0]
    expect(project).toEqual({ EngineAssociation: '5.6' })
    expect(sources).toEqual([{ assetKey: 'asset-1' }])
  })

  it('没有 assetKey 的条目直接丢掉，不会变成空串塞给主进程', async () => {
    await checkImportCompatibility({ EngineAssociation: null }, [
      { assetKey: 'asset-1' },
      { assetKey: '' },
      {} as { assetKey?: string }
    ])

    const [project, sources] = checkCompatibility.mock.calls[0]
    expect(project).toEqual({ EngineAssociation: null })
    expect(sources).toEqual([{ assetKey: 'asset-1' }])
  })
})
