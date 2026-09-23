/** @vitest-environment node */
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 这一组守的是「花钱的工具别把钱花错地方」：
 * 参考图是本地路径要在发请求**之前**拦掉、失败时要说清额度扣没扣、
 * 存盘失败不能把已经付过钱的结果扔掉。
 */

const generateVideo = vi.fn()
const resumeVideo = vi.fn()
const readSettings = vi.fn()
const downloadAndSaveAIGCAsset = vi.fn()

vi.mock('../../../ai/video', () => ({
  generateVideo: (...args: unknown[]) => generateVideo(...args),
  resumeVideo: (...args: unknown[]) => resumeVideo(...args),
  // 任务号的打包格式是真实现，不该 mock —— 用户要照着它复制粘贴
  encodeVideoJob: (job: { id: string; providerId?: string }) =>
    job.providerId ? `${job.providerId}:${job.id}` : job.id,
  supportsReferenceMedia: (api: string | undefined) => api !== 'minimax-video'
}))
const readSettingsSync = vi.fn((): unknown => ({ version: 3, providers: [], roles: {} }))
vi.mock('../../../ai/store', () => ({
  readSettings: () => readSettings(),
  readSettingsSync: () => readSettingsSync()
}))
vi.mock('../../../services/aigc/assetSaver', () => ({
  downloadAndSaveAIGCAsset: (...args: unknown[]) => downloadAndSaveAIGCAsset(...args)
}))

const isObjectStorageReady = vi.fn()
const uploadMediaFile = vi.fn()
const mediaUrlFor = vi.fn()
const readObjectStorageConfig = vi.fn()
vi.mock('../../../services/objectStorage/objectStorageService', () => ({
  isObjectStorageReady: () => isObjectStorageReady(),
  readObjectStorageConfig: () => readObjectStorageConfig(),
  uploadMediaFile: (...args: unknown[]) => uploadMediaFile(...args),
  mediaUrlFor: (...args: unknown[]) => mediaUrlFor(...args),
  isPrivateEndpoint: (url: string) => /\/\/(127\.|192\.168\.|localhost)/.test(url)
}))

import { createGenerateVideoTool } from './generateVideo'

const tool = createGenerateVideoTool()

async function run(args: Record<string, unknown>): Promise<unknown> {
  return await tool.execute('c1', args)
}

/** 工具的正文都在 content 里的 text 分片上 */
const textOf = (result: unknown): string =>
  (result as { content: { type: string; text?: string }[] }).content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')

const detailsOf = (result: unknown): Record<string, unknown> =>
  (result as { details: Record<string, unknown> }).details

const contentOf = (result: unknown): { type: string }[] =>
  (result as { content: { type: string }[] }).content

const VIDEO_PROVIDER = {
  id: 'ark-seedance',
  displayName: '火山方舟 Seedance',
  kind: 'video',
  videoApi: 'ark-video',
  protocol: 'openai-completions',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  apiKey: { kind: 'none' },
  models: [{ id: 'doubao-seedance-2-5-260628' }]
}

beforeEach(() => {
  vi.clearAllMocks()
  readSettings.mockResolvedValue({
    version: 3,
    providers: [VIDEO_PROVIDER],
    roles: { video: { providerId: 'ark-seedance', modelId: 'doubao-seedance-2-5-260628' } }
  })
  generateVideo.mockResolvedValue({
    url: 'https://cdn.example/out.mp4',
    job: { id: 'cgt-20260414-abc', providerId: 'ark-seedance' },
    usage: 411300
  })
  downloadAndSaveAIGCAsset.mockResolvedValue({
    success: true,
    localPath: 'C:\\vault\\AIGC\\video\\猫.mp4',
    assetKey: 'AIGC_video_1'
  })
})

describe('参数与前置检查', () => {
  // defineTool 把 isError 的结果**抛出去**（pi 只认抛异常），所以这里断言 rejects
  it('本地路径的参考图在发请求之前就拦掉 —— 等厂商报错要几十秒', async () => {
    await expect(run({ prompt: '猫', reference_images: ['C:/shots/a.png'] })).rejects.toThrow(
      /C:\/shots\/a\.png/
    )
    expect(generateVideo).not.toHaveBeenCalled()
  })

  it('指定的模型不存在时把可选清单报回去，不拿绑定的顶上', async () => {
    await expect(run({ prompt: '猫', model: 'sora' })).rejects.toThrow(/doubao-seedance-2-5-260628/)
    expect(generateVideo).not.toHaveBeenCalled()
  })

  it('参考图的用法原样传下去 —— 首帧和风格参考出来的东西完全不同', async () => {
    await run({
      prompt: '猫',
      reference_images: [{ path: 'https://cdn/a.png', role: 'reference' }]
    })

    expect(generateVideo.mock.calls[0][0].images).toEqual([
      { url: 'https://cdn/a.png', role: 'reference' }
    ])
  })

  it('首尾帧各带自己的 role，且按首 → 尾 → 参考排好 —— 方舟靠顺序分首尾', async () => {
    await run({
      prompt: '从白天到黑夜',
      reference_images: [
        { path: 'https://cdn/style.png', role: 'reference' },
        { path: 'https://cdn/night.png', role: 'last_frame' },
        { path: 'https://cdn/day.png', role: 'first_frame' }
      ]
    })

    expect(generateVideo.mock.calls[0][0].images).toEqual([
      { url: 'https://cdn/day.png', role: 'first_frame' },
      { url: 'https://cdn/night.png', role: 'last_frame' },
      { url: 'https://cdn/style.png', role: 'reference' }
    ])
  })

  it('只给尾帧、或首/尾帧给了两张，在发请求之前拦下', async () => {
    await expect(
      run({ prompt: '猫', reference_images: [{ path: 'https://cdn/b.png', role: 'last_frame' }] })
    ).rejects.toThrow(/尾帧/)
    await expect(
      run({ prompt: '猫', reference_images: ['https://cdn/a.png', 'https://cdn/b.png'] })
    ).rejects.toThrow(/首帧只能给一张/)
    expect(generateVideo).not.toHaveBeenCalled()
  })

  it('参考视频和参考音频原样传下去', async () => {
    await run({
      prompt: '参考视频 1 的运镜',
      reference_images: [{ path: 'https://cdn/a.png', role: 'reference' }],
      reference_videos: ['https://cdn/cam.mp4', 'asset://asset-1'],
      reference_audios: ['https://cdn/bgm.mp3']
    })

    const payload = generateVideo.mock.calls[0][0]
    expect(payload.videos).toEqual(['https://cdn/cam.mp4', 'asset://asset-1'])
    expect(payload.audios).toEqual(['https://cdn/bgm.mp3'])
  })

  describe('本地参考视频走对象存储', () => {
    let dir: string
    let clip: string

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'uebox-refvideo-'))
      clip = join(dir, 'shot.mp4')
      await writeFile(clip, Buffer.alloc(1024))
      isObjectStorageReady.mockResolvedValue(true)
      readObjectStorageConfig.mockResolvedValue({
        endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
        publicBaseUrl: ''
      })
      uploadMediaFile.mockResolvedValue({ key: 'uebox-media/abc.mp4', reused: false })
      mediaUrlFor.mockResolvedValue(
        'https://bucket.oss-cn-hangzhou.aliyuncs.com/uebox-media/abc.mp4?sig'
      )
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    /** 截图里那个误会的根：模型以为视频当不了参考，只剩截图一条路。缺的其实只是一个桶 */
    it('没配对象存储时在扣费之前拦下，并引导用户去「偏好设置 → 对象存储」', async () => {
      isObjectStorageReady.mockResolvedValue(false)

      await expect(run({ prompt: '猫', reference_videos: [clip] })).rejects.toThrow(
        /偏好设置 → 对象存储[\s\S]*测试连接/
      )
      expect(uploadMediaFile).not.toHaveBeenCalled()
      expect(generateVideo).not.toHaveBeenCalled()
    })

    it('配了就先传上去，把换来的链接交给厂商；直链原样保留、顺序不变', async () => {
      await run({ prompt: '猫', reference_videos: ['https://cdn/a.mp4', clip] })

      expect(uploadMediaFile.mock.calls[0][0]).toBe(clip)
      expect(generateVideo.mock.calls[0][0].videos).toEqual([
        'https://cdn/a.mp4',
        'https://bucket.oss-cn-hangzhou.aliyuncs.com/uebox-media/abc.mp4?sig'
      ])
    })

    it('方舟不收的格式（.avi）连对象存储都不碰，直接说要转格式', async () => {
      await expect(
        run({ prompt: '猫', reference_videos: ['D:/renders/shot.avi'] })
      ).rejects.toThrow(/mp4 \/ mov/)
      expect(isObjectStorageReady).not.toHaveBeenCalled()
      expect(generateVideo).not.toHaveBeenCalled()
    })

    it('对象存储是内网地址时拦下 —— 方舟从公网拉不到，而且不白传', async () => {
      readObjectStorageConfig.mockResolvedValue({
        endpoint: 'http://192.168.1.5:9000',
        publicBaseUrl: ''
      })

      await expect(run({ prompt: '猫', reference_videos: [clip] })).rejects.toThrow(/内网/)
      expect(uploadMediaFile).not.toHaveBeenCalled()
      expect(generateVideo).not.toHaveBeenCalled()
    })

    it('套餐存储（uebox）不看留在配置里的旧桶地址：旧桶是内网也照传', async () => {
      readObjectStorageConfig.mockResolvedValue({
        preset: 'uebox',
        endpoint: 'http://192.168.1.5:9000',
        publicBaseUrl: ''
      })

      await run({ prompt: '猫', reference_videos: [clip] })
      expect(uploadMediaFile).toHaveBeenCalled()
      expect(generateVideo).toHaveBeenCalled()
    })

    it('选的是不收参考视频的厂商时，传之前就拦下', async () => {
      readSettings.mockResolvedValue({
        version: 3,
        providers: [{ ...VIDEO_PROVIDER, id: 'minimax', videoApi: 'minimax-video' }],
        roles: { video: { providerId: 'minimax', modelId: 'doubao-seedance-2-5-260628' } }
      })

      await expect(run({ prompt: '猫', reference_videos: [clip] })).rejects.toThrow(/只收图片/)
      expect(isObjectStorageReady).not.toHaveBeenCalled()
      expect(uploadMediaFile).not.toHaveBeenCalled()
    })

    it('上传途中按停止立刻放手，不说成上传失败', async () => {
      uploadMediaFile.mockReturnValue(new Promise(() => {}))
      const controller = new AbortController()
      const pending = tool.execute(
        'c1',
        { prompt: '猫', reference_videos: [clip] },
        controller.signal
      )
      await vi.waitFor(() => expect(uploadMediaFile).toHaveBeenCalled())
      controller.abort(new Error('stopped'))

      await expect(pending).rejects.not.toThrow(/测试连接/)
      expect(generateVideo).not.toHaveBeenCalled()
    })

    it('上传失败时说清没扣费，并指到测试连接', async () => {
      uploadMediaFile.mockRejectedValue(new Error('403 AccessDenied'))

      await expect(run({ prompt: '猫', reference_videos: [clip] })).rejects.toThrow(
        /没有扣费[\s\S]*403 AccessDenied[\s\S]*测试连接/
      )
      expect(generateVideo).not.toHaveBeenCalled()
    })
  })

  it('首帧和参考视频/音频不能一起给', async () => {
    await expect(
      run({
        prompt: '猫',
        reference_images: ['https://cdn/a.png'],
        reference_videos: ['https://cdn/cam.mp4']
      })
    ).rejects.toThrow(/互斥/)
    expect(generateVideo).not.toHaveBeenCalled()
  })

  it('参考音频不是 wav / mp3 时在发请求之前拦下', async () => {
    await expect(
      run({
        prompt: '猫',
        reference_videos: ['https://cdn/cam.mp4'],
        reference_audios: ['C:/a.flac']
      })
    ).rejects.toThrow(/wav \/ mp3/)
    expect(generateVideo).not.toHaveBeenCalled()
  })

  it('没给用法时按首帧走，与厂商文档的缺省一致', async () => {
    await run({ prompt: '猫', reference_images: ['https://cdn/a.png'] })

    expect(generateVideo.mock.calls[0][0].images[0].role).toBe('first_frame')
  })

  it('没指定的参数一律不传，交给厂商用自己的缺省值', async () => {
    await run({ prompt: '猫' })

    const payload = generateVideo.mock.calls[0][0]
    expect(payload).not.toHaveProperty('duration')
    expect(payload).not.toHaveProperty('resolution')
    expect(payload).not.toHaveProperty('audio')
  })
})

describe('产出与存盘', () => {
  it('存进素材库并把路径放进 video_path，对话窗口靠它播放', async () => {
    const result = await run({ prompt: '一只猫跳上桌子' })

    expect(downloadAndSaveAIGCAsset).toHaveBeenCalledWith(
      'https://cdn.example/out.mp4',
      'video',
      expect.objectContaining({ defaultExt: '.mp4' })
    )
    expect(detailsOf(result).video_path).toBe('C:\\vault\\AIGC\\video\\猫.mp4')
    expect(detailsOf(result).job_id).toBe('ark-seedance:cgt-20260414-abc')
  })

  /**
   * 钱已经花了，视频还在厂商那儿挂着几小时。这时候把结果扔掉换一句报错，
   * 是最差的处理 —— 至少要把那个还能用的临时地址交出去。
   */
  it('存盘失败不算整次失败，临时地址与它的时效一起报出来', async () => {
    downloadAndSaveAIGCAsset.mockResolvedValue({ success: false, error: '磁盘已满' })

    const result = await run({ prompt: '猫' })

    expect(textOf(result)).toContain('https://cdn.example/out.mp4')
    expect(textOf(result)).toContain('几小时后失效')
    expect(detailsOf(result).save_error).toBe('磁盘已满')
  })

  it('不把视频塞回上下文，但要指路 analyze_video —— 后端有这条能力，别说自己瞎', async () => {
    const result = await run({ prompt: '猫' })

    // 视频没有能进上下文的形式，content 里不该有 image 分片
    expect(contentOf(result).some((part) => part.type === 'image')).toBe(false)
    expect(textOf(result)).toContain('analyze_video')
    expect(textOf(result)).toContain('C:\\vault\\AIGC\\video\\猫.mp4')
  })
})

/**
 * 与 3D 同一条止血通道，而且更迫切：视频按秒计费，一条 1080p 扔掉的钱
 * 比 3D 大一个量级。
 */
describe('续跑已经付过钱的任务', () => {
  it('给了任务号就直接取货，一次都不重新提交', async () => {
    resumeVideo.mockResolvedValue({
      url: 'https://cdn.example/out.mp4',
      job: { id: 'cgt-9', providerId: 'ark-seedance' },
      usage: null
    })

    const result = await run({ resume_job_id: 'ark-seedance:cgt-9' })

    expect(resumeVideo.mock.calls[0][0].jobId).toBe('ark-seedance:cgt-9')
    expect(generateVideo, '续跑不该再提交一次').not.toHaveBeenCalled()
    expect(textOf(result)).toContain('未重新扣费')
  })

  it('续跑时其余生成参数一律忽略', async () => {
    resumeVideo.mockResolvedValue({
      url: 'https://cdn.example/out.mp4',
      job: { id: 'cgt-9', providerId: 'ark-seedance' },
      usage: null
    })

    await run({ resume_job_id: 'ark-seedance:cgt-9', prompt: '不相干的猫', duration: 15 })

    expect(generateVideo).not.toHaveBeenCalled()
  })

  /** 任务号要在**成功**的返回里也给出来 —— 后面存盘再出问题还能靠它取回 */
  it('正常生成也把带厂商的任务号报出来', async () => {
    const result = await run({ prompt: '猫' })

    expect(detailsOf(result).job_id).toBe('ark-seedance:cgt-20260414-abc')
    expect(textOf(result)).toContain('ark-seedance:cgt-20260414-abc')
  })
})

describe('失败时的话术', () => {
  /**
   * 提交成功之后的任何失败，额度都已经扣掉了。不点破这一点，模型默认会
   * 建议「再试一次」—— 一次失败会变成三次扣费。
   */
  it('任务失败时提醒额度已扣、别直接重试', async () => {
    generateVideo.mockRejectedValue(new Error('视频生成任务失败：内容审核未通过'))

    await expect(run({ prompt: '猫' })).rejects.toThrow(/不要直接重试/)
  })

  it('超时同样提醒，因为任务已经提交出去了', async () => {
    generateVideo.mockRejectedValue(new Error('视频生成超过 30 分钟仍未完成。'))

    await expect(run({ prompt: '猫' })).rejects.toThrow(/额度多半已经扣掉/)
  })

  /** 配置问题重试没有意义，要把方向指对 */
  it('没配接口形状时说明是配置问题，不是提示词问题', async () => {
    generateVideo.mockRejectedValue(new Error('Provider「x」没有指定视频接口形状。'))

    await expect(run({ prompt: '猫' })).rejects.toThrow(/配置问题，不是提示词问题/)
  })
})

describe('说明里的扣费口径', () => {
  it('绑的是创作者 Token Plan：失败、超时退回，开始生成后取消不退；别的来源保持「失败也扣」', () => {
    expect(tool.description).toContain('**按秒 × 分辨率计费，失败也扣**')
    readSettingsSync.mockReturnValueOnce({
      version: 3,
      providers: [],
      roles: { video: { providerId: 'creator-plan-video', modelId: 'uebox-video' } }
    })
    const plan = createGenerateVideoTool()
    expect(plan.description).toContain('失败、超时退回；开始生成后取消不退')
    expect(plan.description).not.toContain('取消都退回')
    expect(plan.description).not.toContain('失败也扣')
  })
})
