/**
 * @vitest-environment node
 *
 * 声明的批量上限必须和服务端真认的那个数一致。
 *
 * schema 写 100、插件的 `ual.MaxBatchCreate` 默认 50 的那段时间里，发 53 个实例
 * 会被整批 413 顶回来（`{"field":"instances","requested":53,"max":50}`）——
 * 模型照着 schema 组了一个完全合法的请求，撞上一堵它无从知道的墙，只能拆成两次重发。
 *
 * 这个用例**同时读插件源码**：以后谁改了 cvar 的默认值而没改 schema（或者反过来），
 * 这里就会红，而不是等到用户那边整批被拒。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

// schema 是纯数据，但它所在的模块会拉起 WebSocket 服务（那条路一直通到 electron 的
// app.isPackaged）。这里只要 schema，所以把服务替掉 —— 同 scaleDefault.test.ts
vi.mock('../../../../services', () => ({
  serviceManager: {
    getWebSocketService: () => ({ callRequest: vi.fn(), getConnectionCount: () => 0 })
  }
}))

const { SpawnActorParamsSchema } = await import('./spawnActor')

const CVAR_SOURCE = path.resolve(
  __dirname,
  '../../../../../../plugin/UnrealAgentLink/Source/UnrealAgentLink/Private/Utils/UAL_CommandUtils.cpp'
)

/** 从插件源码里读出 `ual.MaxBatchCreate` 的默认值 */
function pluginMaxBatchCreate(): number {
  const source = readFileSync(CVAR_SOURCE, 'utf8')
  const match = source.match(/TEXT\("ual\.MaxBatchCreate"\),\s*(\d+)/)
  if (!match) throw new Error('插件源码里找不到 ual.MaxBatchCreate 的默认值')
  return Number(match[1])
}

const instance = (index: number): Record<string, unknown> => ({
  asset_id: 'cube',
  name: `UACube_${index}`
})

describe('ue_spawn_actor 的批量上限', () => {
  it('schema 的上限就是插件 cvar 的默认值', () => {
    const max = pluginMaxBatchCreate()

    const atLimit = SpawnActorParamsSchema.safeParse({
      instances: Array.from({ length: max }, (_, i) => instance(i))
    })
    const overLimit = SpawnActorParamsSchema.safeParse({
      instances: Array.from({ length: max + 1 }, (_, i) => instance(i))
    })

    expect(atLimit.success).toBe(true)
    expect(overLimit.success).toBe(false)
  })

  it('兼容字段 batch 和 instances 是同一个上限', () => {
    const max = pluginMaxBatchCreate()

    expect(
      SpawnActorParamsSchema.safeParse({
        batch: Array.from({ length: max + 1 }, (_, i) => instance(i))
      }).success
    ).toBe(false)
  })
})
