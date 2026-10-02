/** @vitest-environment node */
import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 绑骨工具这一层守的是：钱扣没扣说得清、带骨架的网格落了盘、
 * 以及导入时要按骨骼网格导（不说的话引擎可能当成静态网格吃进去）。
 */

const rigModel3d = vi.fn()
const resumeModel3d = vi.fn()
const downloadAndSaveAIGCAsset = vi.fn()

vi.mock('../../../ai/model3d', () => ({
  rigModel3d: (...args: unknown[]) => rigModel3d(...args),
  resumeModel3d: (...args: unknown[]) => resumeModel3d(...args),
  encodeModel3dJob: (job: { poll: string; download: string; providerId?: string }) =>
    `${job.providerId ? `${job.providerId}:` : ''}${job.poll}~${job.download}`,
  MODEL3D_RIG_TYPES: ['biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic']
}))
vi.mock('../../../services/aigc/assetSaver', () => ({
  downloadAndSaveAIGCAsset: (...args: unknown[]) => downloadAndSaveAIGCAsset(...args)
}))

import { createRig3dModelTool } from './rig3dModel'

const tool = createRig3dModelTool()

async function run(args: Record<string, unknown>): Promise<unknown> {
  return await tool.execute('c1', args)
}

const textOf = (result: unknown): string =>
  (result as { content: { type: string; text?: string }[] }).content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')

const detailsOf = (result: unknown): Record<string, unknown> =>
  (result as { details: Record<string, unknown> }).details

const RIG_JOB = { poll: 'task_rig', download: 'animations/rig', cost: 30, providerId: 'tripo' }

beforeEach(() => {
  vi.clearAllMocks()
  rigModel3d.mockResolvedValue({
    files: [{ url: 'https://cdn/rigged.fbx', name: 'rigged.fbx' }],
    job: RIG_JOB,
    rigType: 'biped',
    recommendedRigType: 'biped',
    spec: 'mixamo'
  })
  downloadAndSaveAIGCAsset.mockImplementation(async (_url: string, _type: string, opts: never) => ({
    success: true,
    localPath: `C:\\vault\\AIGC\\model\\${(opts as { suggestedName: string }).suggestedName}.fbx`,
    assetKey: 'AIGC_model_1'
  }))
})

describe('rig_3d_model', () => {
  it('把生成任务号原样交给绑骨，参数按下划线名翻过去', async () => {
    await run({ source_job_id: 'tripo:task_gen~image-to-model', rig_type: 'quadruped' })

    expect(rigModel3d.mock.calls[0][0]).toMatchObject({
      sourceJobToken: 'tripo:task_gen~image-to-model',
      rigType: 'quadruped'
    })
  })

  it('落盘网格并指明按骨骼网格导入', async () => {
    const result = await run({ source_job_id: 'tripo:task_gen~image-to-model', name: 'SK_Hero' })

    expect(downloadAndSaveAIGCAsset.mock.calls[0][0]).toBe('https://cdn/rigged.fbx')
    expect(detailsOf(result)).toMatchObject({
      success: true,
      model_path: 'C:\\vault\\AIGC\\model\\SK_Hero.fbx',
      job_id: 'tripo:task_rig~animations/rig',
      rig_type: 'biped',
      cost: 30
    })
    expect(textOf(result)).toMatch(/fbx_import_as 填 skeletal_mesh/)
  })

  it('指定类型与推荐不同时说出来', async () => {
    rigModel3d.mockResolvedValue({
      files: [{ url: 'https://cdn/rigged.fbx', name: 'rigged.fbx' }],
      job: RIG_JOB,
      rigType: 'biped',
      recommendedRigType: 'quadruped',
      spec: 'mixamo'
    })
    const result = await run({ source_job_id: 'tripo:task_gen~x', rig_type: 'biped' })

    expect(textOf(result)).toMatch(/推荐的是 quadruped/)
  })

  it('续取不重新绑，走 resumeModel3d', async () => {
    resumeModel3d.mockResolvedValue({
      files: [{ url: 'https://cdn/rigged.fbx', name: 'rigged.fbx' }],
      job: { ...RIG_JOB, cost: null }
    })
    const result = await run({ resume_job_id: 'tripo:task_rig~animations/rig' })

    expect(rigModel3d).not.toHaveBeenCalled()
    expect(resumeModel3d.mock.calls[0][0]).toMatchObject({
      jobToken: 'tripo:task_rig~animations/rig'
    })
    expect(textOf(result)).toMatch(/未重新扣费/)
  })

  it('两个任务号都没给时本地就拦掉', async () => {
    await expect(run({})).rejects.toThrow(/source_job_id/)
    expect(rigModel3d).not.toHaveBeenCalled()
  })

  it('绑骨已提交后断了：挡住「再绑一次」', async () => {
    rigModel3d.mockRejectedValue(new Error('已停止等待（任务号 tripo:task_rig~animations/rig）。'))

    await expect(run({ source_job_id: 'tripo:task_gen~x' })).rejects.toThrow(/不要重新绑/)
  })

  it('检查阶段失败：只说「还没提交」，不接一句「已经扣了」', async () => {
    rigModel3d.mockRejectedValue(
      new Error(
        '绑骨前的检查没有成功：3D 生成任务失败：failed。**绑骨还没提交，没有扣绑骨的额度**，原样重试即可。'
      )
    )

    const error = await run({ source_job_id: 'tripo:task_gen~x' }).catch((e: Error) => e)
    expect(String(error)).toMatch(/绑骨还没提交/)
    expect(String(error)).not.toMatch(/多半已经扣掉/)
  })

  it('存盘失败时把还没过期的地址交出去', async () => {
    downloadAndSaveAIGCAsset.mockResolvedValue({ success: false, error: '磁盘满' })
    const result = await run({ source_job_id: 'tripo:task_gen~x' })

    expect(textOf(result)).toMatch(/https:\/\/cdn\/rigged\.fbx/)
    expect(detailsOf(result)).toMatchObject({ save_error: '磁盘满' })
    expect(detailsOf(result)).not.toHaveProperty('model_path')
  })
})
