/**
 * @vitest-environment node
 *
 * 导入外部文件。
 *
 * 这里守两件事，都是「工具别把插件的默认值顶掉」和「别把坏消息藏起来」：
 *
 * scale —— 插件按格式定默认（OBJ ×100，glTF/GLB 和 FBX ×1，后两者引擎自己已经
 * 做过米→厘米，再乘一遍就是 10000 倍）。给了要透传，不给要**保持不传**。
 *
 * isolate / reused —— FBX 内嵌的同名贴图会被引擎静默复用，网格改名而贴图不改，
 * 于是多个模型共用第一份贴图，UV 不同就渲染成碎块。插件负责隔离和上报，
 * 工具这边负责别把 reuse_warning 埋在字段里 —— 只读 message 的模型也得看见。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRequest, getConnectionCount } = vi.hoisted(() => ({
  callRequest: vi.fn(),
  getConnectionCount: vi.fn()
}))

vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ getConnectionCount, callRequest })
  }
}))
vi.mock('../../../core/projectTargetContext', () => ({ getTargetConnectionId: () => undefined }))

import { createImportAssetsTool } from './importAssets'

const tool = createImportAssetsTool()
const run = (input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (tool.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, {})

/** 工具会自己补 destination_path / overwrite 的默认值，所以这里照 schema 走一遍 */
const withDefaults = (input: Record<string, unknown>): Record<string, unknown> =>
  (tool.inputSchema as unknown as { parse: (v: unknown) => Record<string, unknown> }).parse(input)

const sentParams = (): Record<string, unknown> =>
  callRequest.mock.calls[0][1] as Record<string, unknown>

beforeEach(() => {
  getConnectionCount.mockReset().mockReturnValue(1)
  callRequest
    .mockReset()
    .mockResolvedValue({ ok: true, imported_count: 1, requested_count: 1, imported: [] })
})

describe('import scale', () => {
  it('给了就透传给插件', async () => {
    await run(withDefaults({ files: ['C:/a/model.obj'], scale: 100 }))

    expect(sentParams().scale).toBe(100)
  })

  it('不给就一个字都不提 —— 让插件用它的格式默认值', async () => {
    await run(withDefaults({ files: ['C:/a/model.fbx'] }))

    expect('scale' in sentParams()).toBe(false)
  })

  it('0 和负数在 schema 层就被挡掉，不会变成一个把模型压成零的缩放', () => {
    const schema = tool.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean }
    }
    expect(schema.safeParse({ files: ['C:/a.obj'], scale: 0 }).success).toBe(false)
    expect(schema.safeParse({ files: ['C:/a.obj'], scale: -1 }).success).toBe(false)
    expect(schema.safeParse({ files: ['C:/a.obj'], scale: 0.01 }).success).toBe(true)
  })
})

describe('同名贴图隔离', () => {
  it('不填 isolate 就一个字都不提 —— 插件那边的 auto 才是默认', async () => {
    await run(withDefaults({ files: ['C:/a/model.fbx'] }))

    expect('isolate' in sentParams()).toBe(false)
  })

  it('填了就透传', async () => {
    await run(withDefaults({ files: ['C:/a/model.fbx'], isolate: 'always' }))

    expect(sentParams().isolate).toBe('always')
  })

  it('隔离到子文件夹这件事要写进 message —— 只看正文的模型也得知道东西落哪了', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      imported_count: 4,
      requested_count: 2,
      imported: [],
      isolated: [
        { file: 'C:/a/m1.fbx', destination: '/Game/Imported/Mimic/m1' },
        { file: 'C:/a/m2.fbx', destination: '/Game/Imported/Mimic/m2' }
      ],
      isolate_note: '这些网格文件各自导进了自己的子文件夹'
    })

    const r = await run(withDefaults({ files: ['C:/a/m1.fbx', 'C:/a/m2.fbx'] }))

    expect(r.success).toBe(true)
    expect(String(r.message)).toContain('/Game/Imported/Mimic/m1')
    expect(String(r.message)).toContain('/Game/Imported/Mimic/m2')
    expect(r.isolated).toHaveLength(2)
  })

  it('贴图被复用时，成功里也要带着警告 —— 别让 imported_count 把它盖过去', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      imported_count: 3,
      requested_count: 2,
      imported: [{ name: 'Color', path: '/Game/X/Color', class: 'Texture2D', reused: true }],
      reused: [
        { name: 'Color', path: '/Game/X/Color', class: 'Texture2D', source_file: 'C:/a/m2.fbx' }
      ],
      reused_count: 1,
      reuse_warning: '有同名贴图是复用工程里已有的那份，UV 不同会渲染错乱。'
    })

    const r = await run(withDefaults({ files: ['C:/a/m1.fbx', 'C:/a/m2.fbx'] }))

    expect(r.success).toBe(true)
    expect(r.reused_count).toBe(1)
    expect(String(r.message)).toContain('复用')
  })

  it('没有复用也没有隔离时，返回里不多出空字段', async () => {
    const r = await run(withDefaults({ files: ['C:/a/model.fbx'] }))

    expect('reused' in r).toBe(false)
    expect('isolated' in r).toBe(false)
  })
})

describe('还是不碰 .uasset', () => {
  it('.uasset 直接拒，并指向 project_manage', async () => {
    const r = await run(withDefaults({ files: ['C:/a/SM_Chair.uasset'] }))

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('project_manage')
    expect(callRequest).not.toHaveBeenCalled()
  })
})

/**
 * 落地就叫对名字。
 *
 * 插件一直收这个映射，只有 agent 这条路没暴露 —— 于是「按规范命名」只能走
 * 导入 → naming_audit → batch_move 三步，还要再清一轮重定向器。
 *
 * 这里守的是两头：发下去的格式要对得上插件（它读的是
 * `normalized_names: [{original, normalized}]`），以及**改名到底成没成**
 * 必须回读 —— 目标名被占用时插件会跳过改名、保留原名，而响应长得和成功一样。
 */
describe('导入时命名 asset_names', () => {
  it('转成插件认的 normalized_names 数组', async () => {
    await run(
      withDefaults({
        files: ['C:/a/hero.fbx', 'C:/a/wood.png'],
        asset_names: { 'hero.fbx': 'SK_Hero', 'wood.png': 'T_Wood_D' }
      })
    )

    expect(sentParams().normalized_names).toEqual([
      { original: 'hero.fbx', normalized: 'SK_Hero' },
      { original: 'wood.png', normalized: 'T_Wood_D' }
    ])
  })

  it('不给就一个字都不提', async () => {
    await run(withDefaults({ files: ['C:/a/hero.fbx'] }))

    expect('normalized_names' in sentParams()).toBe(false)
  })

  it('改成了就不啰嗦', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      imported_count: 1,
      requested_count: 1,
      imported: [{ name: 'SK_Hero', path: '/Game/Imported/SK_Hero', class: 'SkeletalMesh' }]
    })

    const r = await run(
      withDefaults({ files: ['C:/a/hero.fbx'], asset_names: { 'hero.fbx': 'SK_Hero' } })
    )

    expect(r.success).toBe(true)
    expect('rename_failed' in r).toBe(false)
    expect(String(r.message)).not.toContain('没改成')
  })

  it('目标名被占用、插件保留原名时如实报出来', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      imported_count: 1,
      requested_count: 1,
      imported: [{ name: 'hero', path: '/Game/Imported/hero', class: 'SkeletalMesh' }]
    })

    const r = await run(
      withDefaults({ files: ['C:/a/hero.fbx'], asset_names: { 'hero.fbx': 'SK_Hero' } })
    )

    // 导入本身是成功的，不能因为改名没成就说导入失败
    expect(r.success).toBe(true)
    expect(r.rename_failed).toEqual([{ file: 'hero.fbx', wanted: 'SK_Hero' }])
    expect(String(r.message)).toContain('没改成')
  })

  it('资产名里带路径或扩展名时本地就拦下，不发请求', async () => {
    const r = await run(
      withDefaults({ files: ['C:/a/wood.png'], asset_names: { 'wood.png': 'T_Wood.png' } })
    )

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('不要带扩展名和路径')
    expect(callRequest).not.toHaveBeenCalled()
  })

  it('空名字也拦 —— 发下去插件会当没这条映射', async () => {
    const r = await run(withDefaults({ files: ['C:/a/wood.png'], asset_names: { 'wood.png': '' } }))

    expect(r.success).toBe(false)
    expect(callRequest).not.toHaveBeenCalled()
  })
})
