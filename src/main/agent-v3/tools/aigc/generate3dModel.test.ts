/** @vitest-environment node */
import { resolve } from 'path'

import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 这一组守的是「花钱的工具别把钱花错地方」，外加 3D 特有的一条：
 * **一次生成回来的是一组文件**（网格 + 贴图 + 预览图），分不出哪个是网格，
 * 下游就会把一张 png 当模型导进引擎。
 */

const generateModel3d = vi.fn()
const resumeModel3d = vi.fn()
const readSettings = vi.fn()
const downloadAndSaveAIGCAsset = vi.fn()

vi.mock('../../../ai/model3d', () => ({
  generateModel3d: (...args: unknown[]) => generateModel3d(...args),
  resumeModel3d: (...args: unknown[]) => resumeModel3d(...args),
  // 任务号的打包格式是真实现，不该 mock —— 用户要照着它复制粘贴
  encodeModel3dJob: (job: { poll: string; download: string }) => `${job.poll}~${job.download}`
}))
/**
 * 同步版单独一个 mock：入参表要不要露出 Tripo 那组开关，是**造工具时**
 * 同步决定的，异步的 `readSettings` 在那一步接不上。
 *
 * 默认给绑了 Tripo 的配置 —— 模块顶上那个 `tool` 就是照它造出来的。
 */
const readSettingsSync = vi.fn(() => tripoBoundSettings())
vi.mock('../../../ai/store', () => ({
  readSettings: () => readSettings(),
  readSettingsSync: () => readSettingsSync()
}))

/** 缓存的套餐清单。绑了套餐 3D 时按它的 options 决定暴露哪些扩展开关 */
const planOptions: { value: unknown } = { value: ['negative_prompt', 'auto_size'] }
vi.mock('../../../ai/creatorPlan/planState', () => ({
  readPlanStateSync: () => ({
    manifest: { roles: { model3d: { model: 'uebox-3d', options: planOptions.value } } }
  })
}))

function planBoundSettings(): unknown {
  return {
    version: 3,
    providers: [
      {
        id: 'creator-plan-model3d',
        kind: 'model3d',
        model3dApi: 'uebox-tasks',
        models: [{ id: 'uebox-3d' }]
      }
    ],
    roles: { model3d: { providerId: 'creator-plan-model3d', modelId: 'uebox-3d' } }
  }
}

function tripoBoundSettings(): unknown {
  return {
    version: 3,
    providers: [
      { id: 'tripo', kind: 'model3d', model3dApi: 'tripo', models: [{ id: 'v3.1-20260211' }] }
    ],
    roles: { model3d: { providerId: 'tripo', modelId: 'v3.1-20260211' } }
  }
}

function rodinBoundSettings(): unknown {
  return {
    version: 3,
    providers: [{ id: 'hyper3d', kind: 'model3d', model3dApi: 'rodin', models: [{ id: 'Gen-2' }] }],
    roles: { model3d: { providerId: 'hyper3d', modelId: 'Gen-2' } }
  }
}
vi.mock('../contextImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contextImage')>()),
  compressForContext: async () => ({ data: 'compressed-preview', mimeType: 'image/jpeg' })
}))
/** 参考图和预览图都走它。做成 vi.fn 是为了让用例能按路径给出不同的字节 */
const readFile = vi.fn<(path: string) => Promise<Buffer>>(async () => Buffer.from('preview-bytes'))
vi.mock('fs', () => ({ promises: { readFile: (path: string) => readFile(path) } }))
vi.mock('node:fs', () => ({ promises: { readFile: (path: string) => readFile(path) } }))
vi.mock('../../../services/aigc/assetSaver', () => ({
  downloadAndSaveAIGCAsset: (...args: unknown[]) => downloadAndSaveAIGCAsset(...args)
}))

import { createGenerate3dModelTool } from './generate3dModel'

const tool = createGenerate3dModelTool()

/** 一条**绝对**路径。加载器只收绝对路径，而字面量在 POSIX 上不算 */
const shotPath = (name: string): string => resolve('shots', name)

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

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks 只清调用记录，不清实现 —— 改过实现的用例会漏给下一个
  readFile.mockImplementation(async () => Buffer.from('preview-bytes'))
  readSettings.mockResolvedValue({
    version: 3,
    providers: [
      {
        id: 'tripo',
        displayName: 'Tripo（VAST AI）',
        kind: 'model3d',
        model3dApi: 'tripo',
        protocol: 'openai-completions',
        baseUrl: 'https://openapi.tripo3d.ai/v3',
        apiKey: { kind: 'none' },
        models: [{ id: 'v3.1-20260211' }]
      }
    ],
    roles: { model3d: { providerId: 'tripo', modelId: 'v3.1-20260211' } }
  })
  generateModel3d.mockResolvedValue({
    files: [
      { url: 'https://cdn/model.glb', name: 'model.glb' },
      { url: 'https://cdn/preview.png', name: 'preview.png' }
    ],
    job: { poll: 'task-1', download: 'task-1', cost: 0.5 }
  })
  downloadAndSaveAIGCAsset.mockImplementation(async (_url: string, _type: string, opts: never) => ({
    success: true,
    localPath: `C:\\vault\\AIGC\\model\\${(opts as { suggestedName: string }).suggestedName}`,
    assetKey: 'AIGC_model_1'
  }))
})

describe('参数与前置检查', () => {
  it('提示词和参考图都没有时本地就拦掉，不发请求', async () => {
    await expect(run({})).rejects.toThrow(/至少要给一句描述/)
    expect(generateModel3d).not.toHaveBeenCalled()
  })

  it('只给参考图也能跑 —— 图生 3D 比文生 3D 稳得多', async () => {
    await run({ reference_images: [shotPath('axe.png')] })

    expect(generateModel3d.mock.calls[0][0].images).toHaveLength(1)
    expect(generateModel3d.mock.calls[0][0]).not.toHaveProperty('prompt')
  })

  it('格式缺省 glb —— 单文件自带材质，虚幻侧导入器认它', async () => {
    await run({ prompt: '战斧' })
    expect(generateModel3d.mock.calls[0][0].format).toBe('glb')
  })

  it('精度、拓扑、包围盒原样传下去', async () => {
    await run({
      prompt: '战斧',
      quality: 'low',
      topology: 'quad',
      bounding_box: [30, 90, 10],
      rest_pose: true
    })

    expect(generateModel3d.mock.calls[0][0]).toMatchObject({
      quality: 'low',
      topology: 'quad',
      boundingBox: [30, 90, 10],
      restPose: true
    })
  })

  it('指定的模型不存在时把可选清单报回去', async () => {
    await expect(run({ prompt: '战斧', model: 'hunyuan' })).rejects.toThrow(/v3\.1-20260211/)
    expect(generateModel3d).not.toHaveBeenCalled()
  })

  /** 用户嘴上说「用 Tripo」，型号叫 v3.1-20260211，字面上一个字都不沾 */
  it('按厂商名也能挑中模型', async () => {
    await run({ prompt: '战斧', model: 'Tripo' })
    expect(generateModel3d.mock.calls[0][0].modelId).toBe('v3.1-20260211')
  })
})

/**
 * 参考图这一段以前是**漏的**：本地路径被原样递到厂商层，那边的 `toBytes`
 * 认不出路径，只能当裸 base64 解 —— 路径里的字母正好都在 base64 字母表里，
 * 于是解出几个垃圾字节、一句报错都没有、照常提交。
 *
 * 而这条路是**主路**：skill 教的四视图流程、用户在对话里贴的附件、
 * `ue_screenshot` 拍的白盒，给的全是本地路径。
 */
describe('参考图先读成图片内容', () => {
  const dataUriOf = (text: string): string =>
    `data:image/png;base64,${Buffer.from(text).toString('base64')}`

  it('本地路径读成 data URI 再交给厂商层，不是把路径原样递过去', async () => {
    await run({ reference_images: [shotPath('axe.png')] })

    const [image] = generateModel3d.mock.calls[0][0].images as string[]
    expect(image).toBe(dataUriOf('preview-bytes'))
    expect(image, '路径本身一个字都不该出现在发出去的东西里').not.toContain('axe')
  })

  /** 顺序即朝向。读盘时打乱的话，出来的是一个左右颠倒的模型，而且不报错 */
  it('四视图整组都读，顺序保持 正面 → 左 → 背 → 右', async () => {
    readFile.mockImplementation(async (path: string) =>
      Buffer.from(`bytes-of-${path.replace(/^.*[\\/]/, '')}`)
    )

    await run({
      reference_images: ['front.png', 'left.png', 'back.png', 'right.png'].map(shotPath)
    })

    expect(generateModel3d.mock.calls[0][0].images).toEqual([
      dataUriOf('bytes-of-front.png'),
      dataUriOf('bytes-of-left.png'),
      dataUriOf('bytes-of-back.png'),
      dataUriOf('bytes-of-right.png')
    ])
  })

  it('直链和 data URI 原样递过去，不去读盘', async () => {
    const inline = dataUriOf('inline-bytes')
    await run({ reference_images: ['https://pic/ref.png', inline] })

    expect(generateModel3d.mock.calls[0][0].images).toEqual(['https://pic/ref.png', inline])
    // 唯一那次读盘是回读预览图（saveAndReport 干的），两个来源本身都没去碰盘
    const read = readFile.mock.calls.map(([path]) => path)
    expect(read, '这两种来源没有盘可读').not.toContain('https://pic/ref.png')
    expect(read).not.toContain(inline)
  })

  /** 读不到就抛。少一张参考图出来的模型看着也像模像样，只是和用户给的图无关 */
  it('参考图读不到时报错，且一次都不提交 —— 提交那一刻就扣钱了', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'))

    await expect(run({ reference_images: [shotPath('missing.png')] })).rejects.toThrow(/读不到/)
    expect(generateModel3d).not.toHaveBeenCalled()
  })

  it('相对路径明确报错并指路 ue_screenshot 的 path，不闷头猜工作目录', async () => {
    await expect(run({ reference_images: ['shots/axe.png'] })).rejects.toThrow(/不是绝对路径/)
    expect(generateModel3d).not.toHaveBeenCalled()
  })
})

describe('一组文件里分出网格', () => {
  it('网格进 model_path，贴图和预览图进 extra_paths', async () => {
    const result = await run({ prompt: '战斧' })

    expect(detailsOf(result).model_path).toContain('战斧')
    expect(detailsOf(result).extra_paths).toHaveLength(1)
    expect(downloadAndSaveAIGCAsset).toHaveBeenCalledTimes(2)
  })

  it('只回了贴图没有网格时明说，并把还没过期的地址交出去', async () => {
    generateModel3d.mockResolvedValue({
      files: [{ url: 'https://cdn/preview.png', name: 'preview.png' }],
      job: { poll: 'task-1', download: 'task-1', cost: null }
    })

    const result = await run({ prompt: '战斧' })

    expect(detailsOf(result).model_path).toBeUndefined()
    expect(textOf(result)).toContain('https://cdn/preview.png')
    // Tripo 的地址只有 5 分钟，这句话决定用户来不来得及另存
    expect(textOf(result)).toContain('很快就会失效')
  })

  it('存盘失败不算整次失败 —— 钱已经花了', async () => {
    downloadAndSaveAIGCAsset.mockResolvedValue({ success: false, error: '磁盘已满' })

    const result = await run({ prompt: '战斧' })

    expect(detailsOf(result).save_error).toBe('磁盘已满')
    expect(detailsOf(result).success).toBe(true)
  })

  /**
   * 网格本身进不了上下文，但厂商附的那张预览渲染图可以 —— 没有它的话，
   * 模型对自己刚生成的东西一无所知，连「是不是我要的物体」都答不上来。
   */
  it('把厂商的预览渲染图塞进上下文，让模型至少看得见生成的是什么', async () => {
    const result = await run({ prompt: '战斧' })

    expect(
      (result as { content: { type: string }[] }).content.some((part) => part.type === 'image')
    ).toBe(true)
  })

  /** 但要说清那张图**判断不了什么** —— 否则模型会拿它替用户下结论 */
  it('明说预览图看不出拓扑、朝向、尺寸', async () => {
    const text = textOf(await run({ prompt: '战斧' }))

    expect(text).toContain('主体、风格、大致形状')
    expect(text).toMatch(/拓扑、面数、朝向、有没有穿模、尺寸/)
  })

  it('没有预览图时不塞空图，并退回「你看不到」的措辞', async () => {
    generateModel3d.mockResolvedValue({
      files: [{ url: 'https://cdn/model.glb', name: 'model.glb' }],
      job: { poll: 'task-1', download: 'task-1', cost: null }
    })

    const result = await run({ prompt: '战斧' })

    expect(
      (result as { content: { type: string }[] }).content.some((part) => part.type === 'image')
    ).toBe(false)
    expect(textOf(result)).toContain('你看不到')
  })

  /**
   * 真机上取回 5 个任务，文件全叫 model.glb / model_1.fbx —— 名字和内容
   * 对不上号。续跑没有提示词，名字只能从任务号来。
   */
  it('续跑没有提示词时用任务号当文件名，而不是一堆同名的 model', async () => {
    resumeModel3d.mockResolvedValue({
      files: [{ url: 'https://cdn/model.glb', name: 'model.glb' }],
      job: { poll: 'abc-123', download: 'abc-123', cost: null }
    })

    await run({ resume_job_id: 'abc-123' })

    const name = downloadAndSaveAIGCAsset.mock.calls[0][2].suggestedName as string
    expect(name).toContain('abc-123')
    expect(name).not.toBe('model')
  })
})

/**
 * 真机上丢过三次任务：三次都在厂商那边跑成功、三次都扣了费，而我们这边因为
 * 一次网络抖动全判死了，模型还建议「再试一次」。这一组守住那条止血通道。
 */
describe('续跑已经付过钱的任务', () => {
  it('给了任务号就直接取货，一次都不重新提交', async () => {
    resumeModel3d.mockResolvedValue({
      files: [{ url: 'https://cdn/model.glb', name: 'model.glb' }],
      job: { poll: 'task-9', download: 'task-9', cost: null }
    })

    const result = await run({ resume_job_id: 'task-9~task-9' })

    expect(resumeModel3d.mock.calls[0][0].jobToken).toBe('task-9~task-9')
    expect(generateModel3d, '续跑不该再提交一次').not.toHaveBeenCalled()
    expect(detailsOf(result).model_path).toBeTruthy()
    expect(textOf(result)).toContain('未重新扣费')
  })

  it('续跑时其余生成参数一律忽略，不会顺手再生成一个', async () => {
    resumeModel3d.mockResolvedValue({
      files: [{ url: 'https://cdn/model.glb', name: 'model.glb' }],
      job: { poll: 'task-9', download: 'task-9', cost: null }
    })

    await run({ resume_job_id: 'task-9~task-9', prompt: '完全不相干的战斧', quality: 'high' })

    expect(generateModel3d).not.toHaveBeenCalled()
  })

  /** 任务号要在**成功**的返回里也给出来 —— 后面存盘再出问题还能靠它取回 */
  it('正常生成也把任务号报出来，不是只有失败时才有', async () => {
    const result = await run({ prompt: '战斧' })

    expect(detailsOf(result).job_id).toBe('task-1~task-1')
    expect(textOf(result)).toContain('task-1~task-1')
  })
})

describe('失败时的话术', () => {
  /**
   * 3D 特有的一类失败：参数组合这家不支持（要 glb 却设了 Tripo 的四边面）。
   * 那种错重试一百次都是同一个结果，要改的是参数而不是运气。
   */
  it('参数不支持时说清是参数问题，别让模型原样重试', async () => {
    generateModel3d.mockRejectedValue(
      new Error('«tripo» 不支持 glb 格式。它的四边面网格只能导出 fbx。')
    )

    await expect(run({ prompt: '战斧' })).rejects.toThrow(/原样重试是同一个结果/)
  })

  it('任务失败时提醒额度已扣、别直接重试', async () => {
    generateModel3d.mockRejectedValue(new Error('3D 生成任务失败：厂商没有给出原因'))

    await expect(run({ prompt: '战斧' })).rejects.toThrow(/不要直接重试/)
  })

  it('没配接口形状时说明是配置问题，重试没有意义', async () => {
    generateModel3d.mockRejectedValue(new Error('Provider「x」没有指定 3D 接口形状。'))

    await expect(run({ prompt: '战斧' })).rejects.toThrow(/配置问题/)
  })
})

/**
 * 厂商特供开关**只对绑了那一家的人暴露**。
 *
 * 都露出来、发错家再报错是行不通的：这些参数没有一个是通用的，而模型看见了
 * 就会想用。绑着 Rodin 却看到一个 `smart_low_poly`，最好的结果是白花一次往返。
 */
describe('Tripo 专属开关的暴露面', () => {
  const paramNames = (built: { parameters: unknown }): string[] =>
    Object.keys((built.parameters as { properties: Record<string, unknown> }).properties)

  it('绑了 Tripo 时入参表里有那组开关', () => {
    expect(paramNames(tool)).toEqual(
      expect.arrayContaining([
        'negative_prompt',
        'texture_quality',
        'geometry_quality',
        'smart_low_poly',
        'auto_size',
        'align_orientation',
        'texture_alignment',
        'image_autofix',
        'generate_parts'
      ])
    )
  })

  it('绑的是别家时整组摘掉，通用参数一个不少', () => {
    readSettingsSync.mockReturnValueOnce(rodinBoundSettings())
    const names = paramNames(createGenerate3dModelTool())

    expect(names).not.toContain('negative_prompt')
    expect(names).not.toContain('smart_low_poly')
    expect(names).toEqual(expect.arrayContaining(['prompt', 'quality', 'bounding_box', 'seed']))
  })

  // 一个 3D Provider 都没配时同样不露 —— 那时连绑定都没有
  it('没有绑定时不露', () => {
    readSettingsSync.mockReturnValueOnce({ version: 3, providers: [], roles: {} })

    expect(paramNames(createGenerate3dModelTool())).not.toContain('negative_prompt')
  })

  it('配置读不出来时按「不是 Tripo」处理，不让工具造不出来', () => {
    readSettingsSync.mockImplementationOnce(() => {
      throw new Error('配置文件坏了')
    })

    expect(paramNames(createGenerate3dModelTool())).not.toContain('negative_prompt')
  })
})

describe('Box Plan 的扩展开关', () => {
  const paramNames = (built: { parameters: unknown }): string[] =>
    Object.keys((built.parameters as { properties: Record<string, unknown> }).properties)

  it('只露清单 options 列了的键，说明不带厂商名；退额度的口径写进说明', () => {
    readSettingsSync.mockReturnValue(planBoundSettings())
    try {
      const built = createGenerate3dModelTool()
      const names = paramNames(built)
      expect(names).toEqual(expect.arrayContaining(['negative_prompt', 'auto_size', 'prompt']))
      for (const hidden of ['smart_low_poly', 'geometry_quality', 'bounding_box', 'rest_pose']) {
        expect(names).not.toContain(hidden)
      }
      const props = (built.parameters as { properties: Record<string, { description?: string }> })
        .properties
      expect(props.negative_prompt.description).not.toContain('Tripo')
      expect(built.description).toContain('失败、超时退回；提交之后取消不退')
      expect(built.description).toContain('已提交的 3D 取消后不退额度')
      expect(built.description).not.toContain('取消都退回')
      expect(built.description).not.toContain('**失败也扣**')
    } finally {
      readSettingsSync.mockImplementation(() => tripoBoundSettings())
    }
  })

  it('清单列了 bounding_box 时照常露出；别的来源说明保持「失败也扣」', () => {
    planOptions.value = ['bounding_box']
    readSettingsSync.mockReturnValue(planBoundSettings())
    try {
      expect(paramNames(createGenerate3dModelTool())).toContain('bounding_box')
    } finally {
      planOptions.value = ['negative_prompt', 'auto_size']
      readSettingsSync.mockImplementation(() => tripoBoundSettings())
    }
    readSettingsSync
      .mockReturnValueOnce(rodinBoundSettings())
      .mockReturnValueOnce(rodinBoundSettings())
    expect(createGenerate3dModelTool().description).toContain('**失败也扣**')
  })
})

describe('Tripo 专属开关的传递', () => {
  it('按通用叫法传给传输层，不是原样透传下划线名', async () => {
    await run({
      prompt: '战斧',
      negative_prompt: '底座, 支架',
      texture_quality: 'detailed',
      geometry_quality: 'detailed',
      smart_low_poly: true,
      auto_size: true,
      align_orientation: true,
      texture_alignment: 'geometry',
      image_autofix: true,
      generate_parts: false
    })

    expect(generateModel3d.mock.calls[0][0].vendor).toEqual({
      negativePrompt: '底座, 支架',
      textureQuality: 'detailed',
      geometryQuality: 'detailed',
      smartLowPoly: true,
      autoSize: true,
      alignOrientationToImage: true,
      textureAlignment: 'geometry',
      imageAutofix: true,
      generateParts: false
    })
  })

  it('一个都没给时传一个空对象，不塞一堆 undefined', async () => {
    await run({ prompt: '战斧' })

    expect(generateModel3d.mock.calls[0][0].vendor).toEqual({})
  })

  // 空字符串是模型「想不出要排除什么」时的常见写法，别把它当有效值发出去
  it('反向描述是空白时不发', async () => {
    await run({ prompt: '战斧', negative_prompt: '   ' })

    expect(generateModel3d.mock.calls[0][0].vendor).toEqual({})
  })
})
