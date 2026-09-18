import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { h } from 'vue'
import i18n from '../i18n'

/**
 * FFmpeg 缺失时的统一拦截。
 *
 * 应用不再随包分发 FFmpeg（GPL-3.0，见 THIRD-PARTY-NOTICES.md），
 * 录屏导出、音频提取、视频压缩改为依赖用户自己安装的版本。
 *
 * 这里集中处理「没装」这件事，而不是让每个调用点各自 message.error 一句 ——
 * 用户需要的不是「导出失败」，而是**一条能直接粘贴执行的安装命令**。
 */

export interface FFmpegStatus {
  available: boolean
  path?: string | null
  installCommand?: string
  downloadUrl?: string
  error?: string
}

export async function getFFmpegStatus(): Promise<FFmpegStatus> {
  try {
    const result = await window.api.video.checkFFmpegAvailable()
    return {
      available: Boolean(result?.success && result?.data),
      path: result?.path,
      installCommand: result?.installCommand,
      downloadUrl: result?.downloadUrl,
      error: result?.error
    }
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 确认 FFmpeg 可用；不可用则弹出安装指引并返回 false。
 *
 * 调用方拿到 false 就直接 return，不必再自己提示。
 *
 * @example
 *   if (!(await ensureFFmpeg())) return
 */
export async function ensureFFmpeg(): Promise<boolean> {
  const status = await getFFmpegStatus()
  if (status.available) return true

  const t = i18n.global.t
  const command = status.installCommand || 'ffmpeg'

  confirmDialog({
    title: t('ffmpeg.requiredTitle'),
    width: 520,
    // 用 h 而不是 content 字符串：要在里面放可复制的命令块
    content: h('div', { style: 'line-height:1.7' }, [
      h('p', { style: 'margin:0 0 12px' }, t('ffmpeg.requiredDesc')),
      h(
        'code',
        {
          style:
            'display:block;padding:10px 12px;border-radius:8px;background:var(--color-accent-bg);' +
            'color:#e2e8f0;font-size:13px;word-break:break-all;user-select:all'
        },
        command
      ),
      h(
        'p',
        { style: 'margin:12px 0 0;color:var(--color-accent-text);font-size:12px' },
        t('ffmpeg.noRestartHint')
      )
    ]),
    okText: t('ffmpeg.copyCommand'),
    cancelText: t('common.close'),
    onOk: async () => {
      await navigator.clipboard.writeText(command)
      message.success(t('ffmpeg.commandCopied'))
      // 返回 false 会阻止弹窗关闭；这里让它关掉，用户装完再点一次功能即可
    }
  })

  return false
}
