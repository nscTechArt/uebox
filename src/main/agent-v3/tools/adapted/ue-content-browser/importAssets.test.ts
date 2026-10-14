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
/** 纯动画 FBX 要靠 skeleton 才导得进来，插件认的就是这个字段名 */
describe('动画 FBX 的 skeleton', () => {
  it('给了就原样发给插件', async () => {
    await run(
      withDefaults({ files: ['C:/a/idle.fbx'], skeleton: '/Game/Body/metahuman_base_skel' })
    )

    expect(sentParams().skeleton).toBe('/Game/Body/metahuman_base_skel')
  })

  it('不给就不提', async () => {
    await run(withDefaults({ files: ['C:/a/hero.fbx'] }))

    expect('skeleton' in sentParams()).toBe(false)
    expect('fbx_import_as' in sentParams()).toBe(false)
  })

  it('网格绑现有骨架：fbx_import_as 一起发', async () => {
    await run(
      withDefaults({
        files: ['C:/a/coat.fbx'],
        skeleton: '/Game/Body/metahuman_base_skel',
        fbx_import_as: 'skeletal_mesh'
      })
    )

    expect(sentParams().fbx_import_as).toBe('skeletal_mesh')
  })
})

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

/**
 * AGENTS.md §5 第 14 条。插件回的 failed / rejected / save_warning 以前一个都没透出来，
 * 正文开头是「成功导入 3/5」—— 而那个 3 数的还是资产，不是文件。
 */
describe('部分失败与落盘', () => {
  it('第一句是部分完成（按文件数），失败原因逐条列出，落盘警告在前几行', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      // 引擎给的资产数和输入文件数对不上：一个 FBX 出了网格 + 材质 + 贴图
      imported_count: 4,
      succeeded_count: 2,
      requested_count: 5,
      imported: [],
      failed_count: 3,
      failed: [
        { file: 'C:/a/missing.png', reason: 'file not found on disk' },
        { file: 'C:/a/bad.obj', reason: 'face references vertex 9 but only 8 exist' },
        { file: 'C:/a/x.abc', reason: 'the engine imported nothing from this file' }
      ],
      rejected: [{ file: 'C:/a/bad.obj', reason: 'face references vertex 9 but only 8 exist' }],
      rejected_count: 1,
      save_warning: '2 个资产已导入但未能写入磁盘，关闭编辑器后会丢失，请在编辑器里手动保存。'
    })

    const r = await run(
      withDefaults({
        files: ['C:/a/hero.fbx', 'C:/a/wood.png', 'C:/a/missing.png', 'C:/a/bad.obj', 'C:/a/x.abc']
      })
    )

    expect(r.success).toBe(true)
    expect(r.failed_count).toBe(3)
    expect(r.save_warning).toContain('未能写入磁盘')
    const lines = String(r.message).split('\n')
    // rejected 已经在 failed 里，不能再数一遍
    expect(lines[0]).toBe('⚠️ 部分完成：2 个文件成功 / 3 个文件失败。')
    expect(lines[1]).toBe('导入了 2/5 个文件，共 4 个资产')
    expect(lines[2]).toContain('未能写入磁盘')
    expect(String(r.message)).toContain('C:/a/missing.png：file not found on disk')
    expect(String(r.message)).not.toContain('成功导入')
  })

  it('旧插件：只有 rejected，不存在的文件没报也没算 —— 按发下去的数补上', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      imported_count: 3,
      requested_count: 3,
      imported: [],
      rejected: [{ file: 'C:/a/bad.obj', reason: 'malformed' }],
      rejected_count: 1
    })

    const r = await run(
      withDefaults({ files: ['C:/a/1.png', 'C:/a/2.png', 'C:/a/bad.obj', 'C:/a/gone.png'] })
    )

    const message = String(r.message)
    expect(message.split('\n')[0]).toBe('⚠️ 部分完成：2 个文件成功 / 2 个文件失败。')
    expect(message).toContain('C:/a/bad.obj：malformed')
    expect(message).toContain('另有 1 个文件')
    expect(r.failed_count).toBe(2)
  })

  it('一个都没导成：原因逐条进 error', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: 'C:/a/gone.png: file not found on disk',
      imported_count: 0,
      succeeded_count: 0,
      requested_count: 2,
      imported: [],
      failed_count: 2,
      failed: [
        { file: 'C:/a/gone.png', reason: 'file not found on disk' },
        { file: 'C:/a/x.abc', reason: 'the engine imported nothing from this file' }
      ]
    })

    const r = await run(withDefaults({ files: ['C:/a/gone.png', 'C:/a/x.abc'] }))

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('C:/a/x.abc：the engine imported nothing')
  })

  it('全部成功时不多出 failed 字段，也不带部分完成', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      imported_count: 1,
      succeeded_count: 1,
      requested_count: 1,
      imported: []
    })

    const r = await run(withDefaults({ files: ['C:/a/wood.png'] }))

    expect('failed' in r).toBe(false)
    expect(String(r.message)).not.toContain('部分完成')
  })
})

/**
 * 自动建材质时贴图被怎么处理了，要摆到 message 里。
 *
 * 打包遮罩（ORM/ARM/RMA/MRA）插件会认出来、关 sRGB、改 Masks 压缩，但**不接**进
 * 自动生成的材质实例 —— 母材质没有打包遮罩输入。不写出来的话模型会以为粗糙度和
 * 金属度已经接好了，然后对着一个灰蒙蒙的材质去调参数。
 */
describe('贴图处理结果 texture_setup', () => {
  const okWith = (texture_setup: unknown[]): Record<string, unknown> => ({
    ok: true,
    imported_count: texture_setup.length + 1,
    requested_count: texture_setup.length,
    imported: [],
    texture_setup
  })

  it('打包遮罩：写出通道含义，并说清没接进材质实例', async () => {
    callRequest.mockResolvedValue(
      okWith([
        {
          name: 'T_Rock_ORM',
          type: 'packed_orm',
          srgb: false,
          compression: 'TC_Masks',
          channels: { r: 'ao', g: 'roughness', b: 'metallic' }
        }
      ])
    )

    const r = await run(withDefaults({ files: ['C:/a/T_Rock_ORM.png'] }))
    const message = String(r.message)

    expect(message).toContain('T_Rock_ORM')
    expect(message).toContain('R=ao G=roughness B=metallic')
    expect(message).toContain('sRGB 关')
    expect(message).toContain('TC_Masks')
    expect(message).toContain('没接进自动生成的材质实例')
    expect(r.texture_setup).toHaveLength(1)
  })

  it('只写 Mask 的不编通道顺序', async () => {
    callRequest.mockResolvedValue(
      okWith([{ name: 'T_Leaf_Mask', type: 'packed_mask', srgb: false, compression: 'TC_Masks' }])
    )

    const message = String((await run(withDefaults({ files: ['C:/a/T_Leaf_Mask.png'] }))).message)

    expect(message).toContain('没写通道顺序')
    expect(message).not.toContain('R=')
  })

  it('按名字翻了绿通道的法线要说出来，接上的参数也写明', async () => {
    callRequest.mockResolvedValue(
      okWith([
        {
          name: 'T_Rock_Normal_GL',
          type: 'normal',
          srgb: false,
          compression: 'TC_Normalmap',
          flip_green_channel: true,
          flip_reason: 'name contains an OpenGL marker (gl / opengl)',
          material_parameter: 'Normal'
        }
      ])
    )

    const message = String(
      (await run(withDefaults({ files: ['C:/a/T_Rock_Normal_GL.png'] }))).message
    )

    expect(message).toContain('已翻转绿通道')
    expect(message).toContain('接到材质参数 Normal')
  })

  it('旧插件没有 texture_setup 时不多出这一段', async () => {
    const r = await run(withDefaults({ files: ['C:/a/wood.png'] }))

    expect('texture_setup' in r).toBe(false)
    expect(String(r.message)).not.toContain('贴图处理')
  })
})

/**
 * 导入器自己说的 Warning / Error。
 *
 * 资产建出来了不等于导入干净：平滑组缺失、切线重算、没有光照贴图 UV、骨架对不上，
 * 引擎都只在 Message Log 里留一句。插件把它们收进 import_messages，工具要把条数和
 * 前几条摆进正文 —— 只看 message 的模型才不会报一个「干净导入」。
 */
describe('导入器消息 import_messages', () => {
  const fbxWarnings = [
    {
      severity: 'error',
      category: 'Interchange',
      text: "[C:/a/hero.fbx : 'SK_Hero', SkeletalMesh] Bone 'spine_03' is missing from the skeleton"
    },
    {
      severity: 'warning',
      category: 'FBXImport',
      text: 'No smoothing group information was found in this FBX scene.'
    },
    { severity: 'warning', category: 'LogStaticMesh', text: 'Lightmap UV channel is missing' }
  ]

  it('有消息时，正文写出条数、错误/警告各几条，并逐条带上类别', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      imported_count: 1,
      requested_count: 1,
      imported: [{ name: 'SK_Hero', path: '/Game/SK_Hero.SK_Hero', class: 'SkeletalMesh' }],
      import_messages: fbxWarnings
    })

    const r = await run(withDefaults({ files: ['C:/a/hero.fbx'] }))
    const message = String(r.message)

    expect(r.success).toBe(true)
    expect(message).toContain('导入器报了 3 条消息（1 个错误、2 个警告）')
    expect(message).toContain('import_messages')
    expect(message).toContain('[错误] Interchange:')
    expect(message).toContain('[警告] FBXImport: No smoothing group information')
    expect(r.import_messages).toEqual(fbxWarnings)
    expect('import_messages_truncated' in r).toBe(false)
  })

  it('正文只列前几条，其余和被插件截掉的数目都说清，原始列表完整留在字段里', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      severity: 'warning',
      category: 'LogFbx',
      text: `warning #${i}`
    }))
    callRequest.mockResolvedValue({
      ok: true,
      imported_count: 1,
      requested_count: 1,
      imported: [],
      import_messages: many,
      import_messages_truncated: 12
    })

    const r = await run(withDefaults({ files: ['C:/a/hero.fbx'] }))
    const message = String(r.message)

    expect(message).toContain('导入器报了 20 条消息')
    expect(message).toContain('另有 12 条超出上限没列出')
    expect(message).toContain('warning #4')
    expect(message).not.toContain('warning #5')
    expect(message).toContain('其余 3 条见 import_messages')
    expect(r.import_messages).toHaveLength(8)
    expect(r.import_messages_truncated).toBe(12)
  })

  it('不带类别的行不写空的类别前缀；超长的一条在正文里截断', async () => {
    const long = 'x'.repeat(500)
    callRequest.mockResolvedValue({
      ok: true,
      imported_count: 1,
      requested_count: 1,
      imported: [],
      import_messages: [{ severity: 'warning', category: '', text: long }]
    })

    const message = String((await run(withDefaults({ files: ['C:/a/wood.png'] }))).message)

    expect(message).toContain('  [警告] xxx')
    expect(message).not.toContain('[警告] :')
    expect(message).not.toContain(long)
  })

  it('一个都没导成时，导入器的原话也进 error', async () => {
    callRequest.mockResolvedValue({
      ok: false,
      error: 'C:/a/anim.fbx: the engine imported nothing from this FBX',
      imported_count: 0,
      succeeded_count: 0,
      requested_count: 1,
      imported: [],
      failed_count: 1,
      failed: [{ file: 'C:/a/anim.fbx', reason: 'the engine imported nothing from this FBX' }],
      import_messages: [
        { severity: 'error', category: 'FBXImport', text: 'Could not find skeleton for animation' }
      ]
    })

    const r = await run(withDefaults({ files: ['C:/a/anim.fbx'] }))

    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('[错误] FBXImport: Could not find skeleton for animation')
  })

  it('空数组（这次干净）和旧插件（没有字段）都不多出这一段', async () => {
    callRequest.mockResolvedValue({
      ok: true,
      imported_count: 1,
      requested_count: 1,
      imported: [],
      import_messages: []
    })
    const clean = await run(withDefaults({ files: ['C:/a/wood.png'] }))
    expect('import_messages' in clean).toBe(false)
    expect(String(clean.message)).not.toContain('导入器报了')

    callRequest.mockResolvedValue({ ok: true, imported_count: 1, requested_count: 1, imported: [] })
    const old = await run(withDefaults({ files: ['C:/a/wood.png'] }))
    expect('import_messages' in old).toBe(false)
    expect(String(old.message)).not.toContain('导入器报了')
  })
})
