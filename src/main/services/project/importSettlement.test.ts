import { describe, expect, it } from 'vitest'
import {
  isStrongerReason,
  settleImportBatch,
  type MissingDependencyFact,
  type PlannedAsset,
  type SettlementInput
} from './importSettlement'
import { isCleanImportReport } from '../../../shared/projectImport'

const CONTENT = '/proj/Content'

/** 目标路径 → 键：去掉 UE 包扩展名 + 统一斜杠 + 小写，和拷贝队列那套一致 */
const packageKeyOf = (target: string): string => {
  const unified = target.split('\\').join('/')
  return unified.replace(/\.(uasset|umap|uexp|ubulk|uptnl)$/i, '').toLowerCase()
}

const asset = (index: number, name: string, planned: PlannedAsset['planned']): PlannedAsset => ({
  index,
  assetKey: `key_${name}`,
  assetName: name,
  planned
})

const owners = (entries: Array<[string, number[]]>): Map<string, Set<number>> => {
  const map = new Map<string, Set<number>>()
  for (const [target, indexes] of entries) {
    map.set(packageKeyOf(target), new Set(indexes))
  }
  return map
}

const facts = (
  entries: Array<[string, MissingDependencyFact]>
): Map<string, MissingDependencyFact> => new Map(entries)

const settle = (patch: Partial<SettlementInput> = {}): ReturnType<typeof settleImportBatch> =>
  settleImportBatch({
    assets: [],
    contentBase: CONTENT,
    targetOwners: new Map(),
    closureIncomplete: new Set(),
    missingDependencies: new Set(),
    missingFacts: new Map(),
    queueFailures: [],
    queueConflicts: [],
    packageKeyOf,
    ...patch
  })

describe('settleImportBatch：三条归因路径', () => {
  it('一个字节都没问题时，规划阶段的结论原样保留', () => {
    const result = settle({
      assets: [asset(0, 'SM_A', 'imported'), asset(1, 'SM_B', 'existing')]
    })

    expect(result.succeeded).toBe(1)
    expect(result.existing).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.warnings).toEqual([])
  })

  it('文件没写进去 → 需要它的资产全部降级，不只是第一个', () => {
    // 两个动画共用一副骨骼，骨骼没写进去意味着两个动画都残
    const result = settle({
      assets: [asset(0, 'Anim_A', 'imported'), asset(1, 'Anim_B', 'imported')],
      targetOwners: owners([[`${CONTENT}/Chars/SK_Hero.uasset`, [0, 1]]]),
      queueFailures: [
        {
          source: '/vault/SK_Hero.ubulk',
          target: `${CONTENT}/Chars/SK_Hero.ubulk`,
          error: 'ENOSPC'
        }
      ]
    })

    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(2)
    expect(result.assets.every((a) => a.reason === 'file-not-written')).toBe(true)
    expect(result.report.fileFailures[0]).toMatchObject({
      name: 'SK_Hero.ubulk',
      error: 'ENOSPC',
      affectedCount: 2
    })
    expect(result.report.fileFailures[0].affectedSample).toEqual(['Anim_A', 'Anim_B'])
  })

  it('缺失依赖按依赖聚合，两个资产共用一张缺失贴图时两个都算失败', () => {
    const result = settle({
      assets: [asset(0, 'SM_A', 'imported'), asset(1, 'SM_B', 'existing')],
      targetOwners: owners([[`${CONTENT}/Textures/T_Missing.uasset`, [0, 1]]]),
      missingDependencies: new Set(['/Game/Textures/T_Missing']),
      missingFacts: facts([
        ['/Game/Textures/T_Missing', { state: 'not-in-vault', name: 'T_Missing' }]
      ])
    })

    expect(result.failed).toBe(2)
    expect(result.succeeded).toBe(0)
    expect(result.existing).toBe(0)
    // 一行，不是两行 —— 界面按依赖聚合
    expect(result.report.missingDependencies).toHaveLength(1)
    expect(result.report.missingDependencies[0]).toMatchObject({
      softPath: '/Game/Textures/T_Missing',
      state: 'not-in-vault',
      affectedCount: 2
    })
  })

  it('「库里没有」和「库里有、源文件丢了」分开报，不都说成找不到', () => {
    const result = settle({
      assets: [asset(0, 'SM_A', 'imported')],
      targetOwners: owners([
        [`${CONTENT}/Textures/T_Gone.uasset`, [0]],
        [`${CONTENT}/Textures/T_Never.uasset`, [0]]
      ]),
      missingDependencies: new Set(['/Game/Textures/T_Gone', '/Game/Textures/T_Never']),
      missingFacts: facts([
        ['/Game/Textures/T_Gone', { state: 'source-missing', name: 'T_Gone' }],
        ['/Game/Textures/T_Never', { state: 'not-in-vault', name: 'T_Never' }]
      ])
    })

    const states = Object.fromEntries(
      result.report.missingDependencies.map((row) => [row.name, row.state])
    )
    expect(states).toEqual({ T_Gone: 'source-missing', T_Never: 'not-in-vault' })
  })

  it('闭包没走完时：这批干干净净就不降级，一有问题就按「无法确认」降级', () => {
    const base = {
      assets: [asset(0, 'SM_Big', 'imported')],
      closureIncomplete: new Set([0])
    }

    // 没有任何失败、也没缺依赖 —— 没查完不等于有问题
    expect(settle(base).failed).toBe(0)

    // 这批里有依赖找不到 —— 没查完的那个也不能算「查过没事」
    const dirty = settle({
      ...base,
      missingDependencies: new Set(['/Game/Textures/T_Missing'])
    })
    expect(dirty.failed).toBe(1)
    expect(dirty.assets[0].reason).toBe('unconfirmed')
    expect(dirty.report.unconfirmed).toEqual(['SM_Big'])
  })

  it('同时踩中几条时报最有信息量的那条：无法确认 > 缺依赖 > 文件没写进去', () => {
    const result = settle({
      assets: [asset(0, 'SM_A', 'imported'), asset(1, 'SM_B', 'imported')],
      closureIncomplete: new Set([0]),
      targetOwners: owners([
        [`${CONTENT}/Textures/T_Missing.uasset`, [0, 1]],
        [`${CONTENT}/Meshes/SM_B.uasset`, [1]]
      ]),
      missingDependencies: new Set(['/Game/Textures/T_Missing']),
      queueFailures: [
        { source: '/vault/SM_B.uasset', target: `${CONTENT}/Meshes/SM_B.uasset`, error: 'EBUSY' }
      ]
    })

    const reasons = Object.fromEntries(result.assets.map((a) => [a.assetName, a.reason]))
    expect(reasons).toEqual({ SM_A: 'unconfirmed', SM_B: 'missing-dependency' })
  })

  it('优先级表本身说了算，不靠三个降级块碰巧的先后顺序', () => {
    // 这条直接打表，不经过 settleImportBatch —— 那三个块恰好按 rank 升序排，
    // 「后写覆盖先写」也能得出同样结果，于是走 settle 的用例测的其实是块的顺序
    expect(isStrongerReason('unconfirmed', 'missing-dependency')).toBe(true)
    expect(isStrongerReason('missing-dependency', 'file-not-written')).toBe(true)
    expect(isStrongerReason('file-not-written', 'plan-error')).toBe(true)

    // 反过来一律不许覆盖
    expect(isStrongerReason('missing-dependency', 'unconfirmed')).toBe(false)
    expect(isStrongerReason('file-not-written', 'missing-dependency')).toBe(false)
    // 同级也不覆盖，先定下的那条留着
    expect(isStrongerReason('unconfirmed', 'unconfirmed')).toBe(false)
  })

  it('规划阶段就失败的资产进报告的 planErrors，不然界面没东西可显示', () => {
    // 版本不符、源文件不在这些在依赖解析之前就定了，一条队列都没排 ——
    // 报告里没这一格的话，isCleanImportReport 会说「干净」，
    // 于是最常见的失败反而没有「查看详情」可点
    const result = settle({
      assets: [
        {
          index: 0,
          assetKey: 'key_a',
          assetName: 'SM_A',
          planned: 'failed',
          error: '资产引擎版本 (UE 5.6) 高于目标项目版本 (UE 5.5)'
        },
        asset(1, 'SM_B', 'imported')
      ]
    })

    expect(result.report.planErrors).toEqual([
      { assetName: 'SM_A', error: '资产引擎版本 (UE 5.6) 高于目标项目版本 (UE 5.5)' }
    ])
    expect(isCleanImportReport(result.report)).toBe(false)
  })

  it('不带 /Game 前缀的软路径照样要归属到用它的资产头上', () => {
    // deriveSoftPathFromRealPath 匹配到 `/Game/` 这个 marker 时返回的是 `/${suffix}`，
    // 不带 /Game 前缀（素材包按 <包名>/Game/... 摆的时候就是这样）。
    // 按「/Game 开头」判要不要查归属，会把这种合法软路径一起挡掉 ——
    // 用到它的资产不再被降级，界面上看着没事，底下却写「0 个资产用到它」
    const result = settle({
      assets: [asset(0, 'SM_A', 'imported')],
      targetOwners: owners([[`${CONTENT}/Textures/T_X.uasset`, [0]]]),
      missingDependencies: new Set(['/Textures/T_X']),
      missingFacts: facts([['/Textures/T_X', { state: 'source-missing', name: 'T_X' }]])
    })

    expect(result.failed).toBe(1)
    expect(result.assets[0].reason).toBe('missing-dependency')
    expect(result.report.missingDependencies[0].affectedCount).toBe(1)
    expect(result.report.unattributedMissing).toBe(0)
  })

  it('认不出软路径的缺失依赖照样报出来，但不硬凑归属', () => {
    // 保管库目录里没有 /Content/ 这一段时，登记进来的是真实磁盘路径。
    // 拿它去 path.join(contentBase, ...) 拼只会得到一个永远匹配不上的键 ——
    // 那就不认归属，但绝不能把这条依赖吞掉
    const raw = String.raw`H:\vault\assetData\1712\Textures\T_Rock.uasset`
    const result = settle({
      assets: [asset(0, 'SM_Chair', 'imported')],
      targetOwners: owners([[`${CONTENT}/Meshes/SM_Chair.uasset`, [0]]]),
      missingDependencies: new Set([raw]),
      missingFacts: facts([[raw, { state: 'unresolved', name: 'T_Rock.uasset' }]])
    })

    expect(result.report.missingDependencies).toHaveLength(1)
    expect(result.report.missingDependencies[0]).toMatchObject({
      name: 'T_Rock.uasset',
      state: 'unresolved',
      affectedCount: 0
    })
    // 摊不到人头上不等于没事：整批必须因此判成「有问题」
    expect(result.report.unattributedMissing).toBe(1)
    expect(isCleanImportReport(result.report)).toBe(false)
  })

  it('缺依赖摊不到任何资产头上时，报告不许是「干净」的', () => {
    // 归属靠软路径换算，引用它的那个资产在规划期就失败时，谁都不会被降级 ——
    // 整批要是照样报成功，就等于说「这条依赖找不到，但没人受影响」
    const result = settle({
      assets: [
        { index: 0, assetKey: 'key_a', assetName: 'SM_A', planned: 'failed', error: '源文件不在' }
      ],
      missingDependencies: new Set(['/Game/Textures/T_Missing']),
      missingFacts: facts([
        ['/Game/Textures/T_Missing', { state: 'not-in-vault', name: 'T_Missing' }]
      ])
    })

    expect(result.report.unattributedMissing).toBe(1)
    expect(isCleanImportReport(result.report)).toBe(false)
    expect(result.warnings.join(' | ')).toContain('没能确定是哪些资产在用它')
  })

  it('只有目标冲突时也不算干净 —— 那是「报了成功、字节却是别人的」', () => {
    const result = settle({
      assets: [asset(0, 'SM_A', 'imported')],
      queueConflicts: [
        {
          target: `${CONTENT}/Chars/SK_Hero.uasset`,
          keptSource: '/vault/PackA/SK_Hero.uasset',
          rejectedSource: '/vault/PackB/SK_Hero.uasset'
        }
      ]
    })

    // 结算不为冲突降级（谁也说不清该算谁的），但报告绝不能是干净的
    expect(result.failed).toBe(0)
    expect(isCleanImportReport(result.report)).toBe(false)
  })

  it('规划阶段就失败的资产不会被再降一次，原因和错误原样保留', () => {
    const result = settle({
      assets: [
        { index: 0, assetKey: 'key_a', assetName: 'SM_A', planned: 'failed', error: '版本太高' }
      ],
      targetOwners: owners([[`${CONTENT}/Meshes/SM_A.uasset`, [0]]]),
      queueFailures: [
        { source: '/vault/SM_A.uasset', target: `${CONTENT}/Meshes/SM_A.uasset`, error: 'EBUSY' }
      ]
    })

    expect(result.failed).toBe(1)
    expect(result.assets[0]).toMatchObject({ reason: 'plan-error', error: '版本太高' })
    // 降级警告只给「本来算进去了、又被拉下来」的资产，规划期的失败调用方已经报过一次
    expect(result.warnings.filter((w) => w.startsWith('导入失败（'))).toEqual([])
  })

  it('归不到任何资产头上的文件失败单独计数，不能装作整批都成功', () => {
    const result = settle({
      assets: [asset(0, 'SM_A', 'imported')],
      queueFailures: [
        {
          source: '/vault/T_Shared.uexp',
          target: `${CONTENT}/Textures/T_Shared.uexp`,
          error: 'EIO'
        }
      ]
    })

    expect(result.failed).toBe(0)
    expect(result.report.orphanFileFailures).toBe(1)
    expect(result.warnings.join(' | ')).toContain('另有 1 个依赖文件没能写入工程')
  })

  it('目标冲突原样带出来，先到的留下、后到的报出来', () => {
    const result = settle({
      assets: [asset(0, 'SM_A', 'imported')],
      queueConflicts: [
        {
          target: `${CONTENT}/Chars/SK_Hero.uasset`,
          keptSource: '/vault/PackA/SK_Hero.uasset',
          rejectedSource: '/vault/PackB/SK_Hero.uasset'
        }
      ]
    })

    expect(result.report.conflicts[0]).toMatchObject({
      name: 'SK_Hero.uasset',
      rejectedSource: '/vault/PackB/SK_Hero.uasset'
    })
    expect(result.warnings.join(' | ')).toContain('目标路径冲突')
  })

  it('失败上千条时每组封顶，超出的只留计数', () => {
    const missing = Array.from({ length: 130 }, (_, i) => `/Game/Textures/T_${i}`)
    const result = settle({
      assets: [asset(0, 'SM_A', 'imported')],
      missingDependencies: new Set(missing),
      targetOwners: owners(
        missing.map((softPath) => [`${CONTENT}/Textures/${softPath.split('/').pop()}.uasset`, [0]])
      )
    })

    expect(result.report.missingDependencies).toHaveLength(50)
    expect(result.report.truncated.missingDependencies).toBe(80)
  })
})
