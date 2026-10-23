/**
 * `uebox skills add <技能名或技能页地址>` —— 从官网共享库装一个技能到盒子里。
 *
 * CLI 不自己下载、不自己写盘：它调盒子的 `box_manage`，盒子弹出安装确认框给用户看全文，
 * 用户点了「安装」才写进去。所以这条命令会一直等到用户在盒子里做出选择，期限放宽到
 * 10 分钟（盒子那头也是 10 分钟没人理就按「不装」处理）。
 *
 * 用户取消不算失败：成功返回，`installed: false`。脚本据此决定下一步，不用解析中文。
 */

import { success, type Envelope } from '../envelope.js'
import { UeboxError } from '../errors.js'
import * as runtime from '../runtime.js'

const WAIT_FOR_USER_SECONDS = 600

export interface SkillsAddOptions {
  ref: string
  configPath?: string
  timeoutSeconds?: number
  env?: NodeJS.ProcessEnv
}

export async function runSkillsAdd(options: SkillsAddOptions): Promise<Envelope> {
  const ref = options.ref.trim()
  if (!ref) {
    throw new UeboxError(
      'INVALID_ARGUMENT',
      '缺少要安装的技能。',
      '用法：uebox skills add <技能名或技能页地址>，例如 uebox skills add ue-level-organize'
    )
  }

  const rt = await runtime.open({
    timeoutSeconds: options.timeoutSeconds ?? WAIT_FOR_USER_SECONDS,
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.env ? { env: options.env } : {})
  })

  try {
    const result = await runtime.callTool(rt, 'box_manage', {
      action: 'install_shared_skill',
      target: ref
    })
    const text = (result.content ?? [])
      .map((part) => (part.type === 'text' ? String(part.text ?? '') : ''))
      .join('\n')
      .trim()
    // 盒子的回执第一句就说明装没装上，见 box.ts 的 install_shared_skill
    const installed = text.startsWith('已安装')
    return success({
      data: { ref, installed, message: text },
      warnings: installed ? [] : ['用户没有确认安装。']
    })
  } finally {
    await rt.close()
  }
}
