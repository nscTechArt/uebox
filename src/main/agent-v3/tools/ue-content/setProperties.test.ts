/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRequest = vi.fn()
const getConnectionCount = vi.fn(() => 1)

vi.mock('../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest, getConnectionCount })
  }
}))
vi.mock('../../core/projectTargetContext', () => ({
  getTargetConnectionId: () => 'conn-1'
}))

import {
  setPropertiesTool,
  summarizeSetProperties,
  type SetAssetPropertiesResponse
} from './setProperties'

const text = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((c) => c.text ?? '').join('')

function response(partial: Partial<SetAssetPropertiesResponse>): SetAssetPropertiesResponse {
  return {
    ok: true,
    asset_path: '/Game/Textures/T_Rock_ORM.T_Rock_ORM',
    asset_class: 'Texture2D',
    results: [],
    succeeded_count: 0,
    failed_count: 0,
    changed_count: 0,
    saved: false,
    dirty: false,
    reopened_editor: false,
    notes: [],
    ...partial
  }
}

beforeEach(() => callRequest.mockReset())

describe('ue_content_set_properties', () => {
  it('是写工具：要审批、串行、归在 ue.content', () => {
    expect(setPropertiesTool.name).toBe('ue_content_set_properties')
    expect(setPropertiesTool.unrealBox.risk).toBe('mutating')
    expect(setPropertiesTool.unrealBox.namespace).toBe('ue.content')
    expect((setPropertiesTool as { executionMode?: string }).executionMode).toBe('sequential')
  })

  it('参数原样交给 content.set_asset_properties，save 没给就不带', async () => {
    callRequest.mockResolvedValue(
      response({
        results: [{ property: 'NaniteSettings.bEnabled', requested: true, actual: true, ok: true }],
        succeeded_count: 1,
        changed_count: 1,
        saved: true
      })
    )

    await setPropertiesTool.execute('c1', {
      asset_path: '/Game/Props/SM_Rock',
      properties: { 'NaniteSettings.bEnabled': true }
    })
    expect(callRequest.mock.calls[0][0]).toBe('content.set_asset_properties')
    expect(callRequest.mock.calls[0][1]).toEqual({
      asset_path: '/Game/Props/SM_Rock',
      properties: { 'NaniteSettings.bEnabled': true }
    })

    await setPropertiesTool.execute('c2', {
      asset_path: '/Game/Textures/T_Rock_N',
      properties: { bFlipGreenChannel: true, MaxTextureSize: 2048 },
      save: false
    })
    expect(callRequest.mock.calls[1][1]).toEqual({
      asset_path: '/Game/Textures/T_Rock_N',
      properties: { bFlipGreenChannel: true, MaxTextureSize: 2048 },
      save: false
    })
  })

  it('properties 为空在盒子这边就拦下', async () => {
    await expect(
      setPropertiesTool.execute('c1', { asset_path: '/Game/T', properties: {} })
    ).rejects.toThrow()
    expect(callRequest).not.toHaveBeenCalled()
  })

  // AGENTS.md §5 第 14 条：回执跟着引擎走 —— 引擎回的值和请求写法不同时，摘要写引擎的
  it('逐条列出要的值和引擎读回的值', async () => {
    callRequest.mockResolvedValueOnce(
      response({
        results: [
          {
            property: 'CompressionSettings',
            requested: 'TextureCompressionSettings::TC_Masks',
            before: 'TC_Default',
            actual: 'TC_Masks',
            ok: true
          },
          {
            property: 'SRGB',
            requested: false,
            before: false,
            actual: false,
            ok: true,
            unchanged: true
          },
          { property: 'MaxTextureSize', requested: 2048, before: 0, actual: 2048, ok: true }
        ],
        succeeded_count: 3,
        changed_count: 2,
        saved: true
      })
    )

    const out = text(
      await setPropertiesTool.execute('c1', {
        asset_path: '/Game/Textures/T_Rock_ORM',
        properties: {
          CompressionSettings: 'TextureCompressionSettings::TC_Masks',
          SRGB: false,
          MaxTextureSize: 2048
        }
      })
    )
    const lines = out.split('\n')
    expect(lines[0]).toContain('T_Rock_ORM（Texture2D）')
    expect(lines[0]).toContain('3 个属性已按要求生效')
    expect(lines[0]).not.toContain('部分完成')
    expect(out).toContain(
      'CompressionSettings：要 TextureCompressionSettings::TC_Masks → 实际 TC_Masks'
    )
    expect(out).toContain('SRGB：已是 false，没动')
    expect(out).toContain('MaxTextureSize：要 2048 → 实际 2048')
    expect(out).toContain('已存盘')
  })

  it('部分失败时第一行先说部分完成，失败条目带实际值和原因', async () => {
    callRequest.mockResolvedValueOnce(
      response({
        asset_path: '/Game/Props/SM_Rock.SM_Rock',
        asset_class: 'StaticMesh',
        results: [
          {
            property: 'NaniteSettings.bEnabled',
            requested: true,
            before: false,
            actual: true,
            ok: true
          },
          {
            property: 'BodySetup.CollisionTraceFlag',
            requested: 'CTF_UseComplexAsSimple',
            before: 'CTF_UseDefault',
            actual: 'CTF_UseComplexAsSimple',
            ok: true
          },
          {
            property: 'LightMapResolution',
            requested: -8,
            before: 64,
            actual: 0,
            ok: false,
            reason: 'value_mismatch',
            error: 'the engine kept 0 instead of the requested value'
          },
          {
            property: 'NaniteSetings.bEnabled',
            requested: true,
            ok: false,
            reason: 'not_found',
            error: "no field 'NaniteSetings' on StaticMesh. Did you mean: NaniteSettings?"
          }
        ],
        succeeded_count: 2,
        failed_count: 2,
        changed_count: 3,
        saved: true,
        reopened_editor: true
      })
    )

    const out = text(
      await setPropertiesTool.execute('c1', {
        asset_path: '/Game/Props/SM_Rock',
        properties: {
          'NaniteSettings.bEnabled': true,
          'BodySetup.CollisionTraceFlag': 'CTF_UseComplexAsSimple',
          LightMapResolution: -8,
          'NaniteSetings.bEnabled': true
        }
      })
    )
    const lines = out.split('\n')
    expect(lines[0]).toBe('⚠️ 部分完成：2 个属性成功 / 2 个属性失败。')
    expect(out).toContain('NaniteSettings.bEnabled：要 true → 实际 true')
    expect(out).toContain(
      'BodySetup.CollisionTraceFlag：要 CTF_UseComplexAsSimple → 实际 CTF_UseComplexAsSimple'
    )
    expect(out).toContain('LightMapResolution：要 -8，实际 0；value_mismatch')
    expect(out).toContain('Did you mean: NaniteSettings?')
    expect(out).toContain('静态网格编辑器')
  })

  it('引擎整批失败时抛错，原因原样带给模型', async () => {
    callRequest.mockResolvedValueOnce({
      ok: false,
      error:
        "none of the 1 properties on /Game/T.T was set: Foo: no field 'Foo' on Texture2D. Did you mean: SRGB?"
    })
    await expect(
      setPropertiesTool.execute('c1', { asset_path: '/Game/T', properties: { Foo: 1 } })
    ).rejects.toThrow(/Did you mean: SRGB/)
  })

  it('一个都没成功却回了 ok 时，摘要也不说成功', () => {
    expect(() =>
      summarizeSetProperties(
        response({
          results: [
            {
              property: 'SRGB',
              requested: false,
              before: true,
              ok: false,
              reason: 'read_only',
              error: "'SRGB' is read-only in the Details panel"
            }
          ],
          failed_count: 1
        })
      )
    ).toThrow(/一个都没改成[\s\S]*read_only/)
  })

  it('没有真正改动时不说已存盘；save=false 时提醒之后保存', () => {
    const unchanged = summarizeSetProperties(
      response({
        results: [
          {
            property: 'SRGB',
            requested: false,
            before: false,
            actual: false,
            ok: true,
            unchanged: true
          }
        ],
        succeeded_count: 1,
        changed_count: 0
      })
    )
    expect(unchanged).toContain('本来就是这个值')
    expect(unchanged).toContain('未存盘')

    const notSaved = summarizeSetProperties(
      response({
        results: [
          { property: 'MaxTextureSize', requested: 1024, before: 0, actual: 1024, ok: true }
        ],
        succeeded_count: 1,
        changed_count: 1,
        saved: false,
        dirty: true
      })
    )
    expect(notSaved).toContain('ue_save')
  })
})
