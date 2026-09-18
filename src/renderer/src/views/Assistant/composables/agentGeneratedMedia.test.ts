import { describe, expect, it } from 'vitest'
import { collectGeneratedMediaFromAgentArtifacts } from './agentGeneratedMedia'

const SHOT = 'H:/素材库/AIGC/图片/石屋_1.png'
const SHOT_URL =
  'local-resource://H:/%E7%B4%A0%E6%9D%90%E5%BA%93/AIGC/%E5%9B%BE%E7%89%87/%E7%9F%B3%E5%B1%8B_1.png'

describe('collectGeneratedMediaFromAgentArtifacts', () => {
  it('把生图产出的路径转成渲染层能加载的地址', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      toolResults: [
        {
          toolName: 'generate_image',
          result: { success: true, image_paths: [SHOT] }
        }
      ]
    })

    expect(media.images).toEqual([SHOT_URL])
  })

  it('一次出多张时全都要', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      toolResults: [
        {
          toolName: 'generate_image',
          result: {
            success: true,
            image_paths: ['H:/a.png', 'H:/b.png']
          }
        }
      ]
    })

    expect(media.images).toEqual(['local-resource://H:/a.png', 'local-resource://H:/b.png'])
  })

  it('过程日志里再出现一次的同一张图只算一张', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      toolResults: [
        { toolName: 'generate_image', result: { success: true, image_paths: ['H:/a.png'] } }
      ],
      agentProcess: [
        {
          type: 'tool-result',
          data: {
            toolName: 'generate_image',
            result: { success: true, image_paths: ['H:/a.png'] }
          },
          timestamp: 1
        }
      ]
    })

    expect(media.images).toEqual(['local-resource://H:/a.png'])
  })

  // 结果是 JSON 字符串的情况：历史消息还原出来的 tool result 就是这个形状
  it('结果是字符串也认', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      toolResults: [
        {
          toolName: 'generate_image',
          result: JSON.stringify({ success: true, image_paths: ['H:/a.png'] })
        }
      ]
    })

    expect(media.images).toEqual(['local-resource://H:/a.png'])
  })

  it('别的工具的返回值不当生图产出', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      toolResults: [{ toolName: 'ue_screenshot', result: { success: true, path: 'H:/shot.png' } }]
    })

    expect(media.images).toEqual([])
  })

  it('失败的那次调用不显示图', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      toolResults: [
        { toolName: 'generate_image', result: { success: false, image_paths: ['H:/a.png'] } }
      ]
    })

    expect(media.images).toEqual([])
  })

  /**
   * 视频此前只在过程日志里能播 —— 那个框可以收起来，收起来正文里就什么都没有。
   * 按秒计费跑几分钟出来的东西不该藏在可折叠的框里。
   */
  it.each(['generate_video', 'render_task_video'])('%s 成片显示在会话正文中', (toolName) => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      toolResults: [
        {
          toolName,
          result: { success: true, video_path: 'H:/素材库/AIGC/视频/烛影临渊.mp4' }
        }
      ]
    })

    expect(media.videos).toEqual([
      'local-resource://H:/%E7%B4%A0%E6%9D%90%E5%BA%93/AIGC/' +
        '%E8%A7%86%E9%A2%91/%E7%83%9B%E5%BD%B1%E4%B8%B4%E6%B8%8A.mp4'
    ])
    expect(media.images).toEqual([])
  })

  it('存盘失败没有路径时不硬凑一个播放器', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      toolResults: [
        { toolName: 'generate_video', result: { success: true, save_error: '磁盘已满' } }
      ]
    })

    expect(media.videos).toEqual([])
  })

  /**
   * 这条是那个「一次都没显示出来过」的预览器的回归护栏：V3 的完成事件里
   * 没有 messages，还原出来的 toolResults 恒为空，能拿到网格的只有过程日志。
   */
  it('只有过程日志时也能拿到生成的网格', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      agentProcess: [
        {
          type: 'tool-result',
          data: {
            toolName: 'generate_3d_model',
            result: { success: true, model_path: 'H:/素材库/AIGC/模型/柯基屋.glb' }
          },
          timestamp: 1
        }
      ]
    })

    expect(media.models).toEqual([
      'local-resource://H:/%E7%B4%A0%E6%9D%90%E5%BA%93/AIGC/' +
        '%E6%A8%A1%E5%9E%8B/%E6%9F%AF%E5%9F%BA%E5%B1%8B.glb'
    ])
  })

  it('存盘失败没有网格路径时不挂一个空预览器', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      agentProcess: [
        {
          type: 'tool-result',
          data: {
            toolName: 'generate_3d_model',
            result: { success: true, save_error: '磁盘已满' }
          },
          timestamp: 1
        }
      ]
    })

    expect(media.models).toEqual([])
  })

  // 厂商附的那张预览渲染图也在产出里，它不是网格，塞进预览器只会是个黑框
  it('只认网格扩展名', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      toolResults: [
        { toolName: 'generate_3d_model', result: { success: true, model_path: 'H:/a_preview.png' } }
      ]
    })

    expect(media.models).toEqual([])
  })

  it('老会话记录里 V2 的 model_preview 结果照样能显示', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      toolResults: [{ toolName: 'model_preview', result: { filePath: 'H:/old.fbx' } }]
    })

    expect(media.models).toEqual(['local-resource://H:/old.fbx'])
  })

  it('同一个网格在两个来源里都出现时只算一个', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      toolResults: [
        { toolName: 'generate_3d_model', result: { success: true, model_path: 'H:/a.glb' } }
      ],
      agentProcess: [
        {
          type: 'tool-result',
          data: {
            toolName: 'generate_3d_model',
            result: { success: true, model_path: 'H:/a.glb' }
          },
          timestamp: 1
        }
      ]
    })

    expect(media.models).toEqual(['local-resource://H:/a.glb'])
  })

  it('过程日志里的同一段视频只算一条', () => {
    const media = collectGeneratedMediaFromAgentArtifacts({
      toolResults: [
        { toolName: 'generate_video', result: { success: true, video_path: 'H:/a.mp4' } }
      ],
      agentProcess: [
        {
          type: 'tool-result',
          data: {
            toolName: 'generate_video',
            result: { success: true, video_path: 'H:/a.mp4' }
          },
          timestamp: 1
        }
      ]
    })

    expect(media.videos).toEqual(['local-resource://H:/a.mp4'])
  })
})
