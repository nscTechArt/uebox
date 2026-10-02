/**
 * 给生成出来的 3D 模型自动绑骨。
 *
 * ## 为什么是单独一个工具
 *
 * 绑骨的输入不是提示词和图，是**上一次生成的任务号** —— 厂商那边直接拿那次的网格来绑，
 * 不用我们把文件传回去。塞进 `generate_3d_model` 当参数的话，模型会以为
 * 「生成时顺手勾一下」就能出带骨骼的角色，而实际上那是两次计费、两段等待。
 *
 * ## 边界
 *
 * - 只接了 Tripo，所以只有 Tripo 生成的任务号能绑。别家的网格在这里明确报错。
 * - 一期只出**带骨架的网格**，不套动画。要动起来走引擎那边的重定向（`anim_retarget`）。
 */

import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import {
  encodeModel3dJob,
  MODEL3D_RIG_TYPES,
  resumeModel3d,
  rigModel3d,
  type Model3dJob
} from '../../../ai/model3d'
import { downloadAndSaveAIGCAsset } from '../../../services/aigc/assetSaver'

/** 素材库文件名的长度上限，与 generate_3d_model 一致 */
const NAME_MAX_LENGTH = 40

const MESH_EXTENSION = /\.(glb|gltf|fbx|obj|usdz|stl)$/i

const Rig3dModelInput = z.object({
  source_job_id: z
    .string()
    .optional()
    .describe(
      '要绑的那个模型的任务号：`generate_3d_model` 返回里的 `job_id`，原样抄。' +
        '与 resume_job_id 二选一。'
    ),
  rig_type: z
    .enum(MODEL3D_RIG_TYPES)
    .optional()
    .describe(
      '骨骼类型。**不确定就别填** —— 厂商会先检查并推荐一种。' +
        'biped 双足人形 / quadruped 四足 / hexapod 六足 / octopod 八足 / ' +
        'avian 鸟类有翼 / serpentine 蛇形 / aquatic 鱼类水生。'
    ),
  spec: z
    .enum(['mixamo', 'tripo'])
    .optional()
    .describe(
      '骨骼命名规范，默认 mixamo（进虚幻做重定向最省事）。只有用户明确要 Tripo 原生命名时才填 tripo。'
    ),
  format: z
    .enum(['fbx', 'glb'])
    .optional()
    .describe('输出格式，默认 fbx —— 虚幻按骨骼网格导入走 FBX 最稳。'),
  name: z.string().optional().describe('存进素材库时的文件名。建议 SK_ 开头'),
  resume_job_id: z
    .string()
    .optional()
    .describe(
      '**接着取一个已经提交过的绑骨任务**，而不是重新绑。上一次中断的报错里带着这个号就用它 —— ' +
        '绑骨提交那一刻就扣了钱，重新提交是再付一次。给了它时其余参数全部忽略。'
    )
})

export interface Rigged3dModelDetails extends Record<string, unknown> {
  success: boolean
  /** 带骨架的网格的绝对路径。交给 ue_content_import */
  model_path?: string
  /** 绑骨任务号。失败时靠它对账、续取 */
  job_id: string
  rig_type?: string
  recommended_rig_type?: string | null
  spec?: string
  cost?: number | null
  save_error?: string
}

export function createRig3dModelTool(): UnrealAgentTool<Rigged3dModelDetails> {
  return defineTool<typeof Rig3dModelInput, Rigged3dModelDetails>({
    name: 'rig_3d_model',
    namespace: 'aigc',
    risk: 'mutating',
    description: `给 \`generate_3d_model\` 生成的模型**自动绑骨**，出一个带骨架的网格，存进素材库。

【只有 Tripo 生成的模型能绑】入参是那次生成的任务号，厂商直接拿那次的网格来绑。
别家（Rodin、Meshy、Box Plan）生成的、或者工程里已有的网格，这个工具绑不了，如实告诉用户
要在 Blender 等 DCC 里手动绑。

【要花钱】先免费检查能不能绑，能绑才提交绑骨，**绑骨一次扣用户约 30 额度，失败也扣**。
检查说绑不了就停下，把原因告诉用户 —— 不要换个参数硬绑，也**不要自己决定重做**一次生成去「换个能绑的」：
重新生成是用户再付一次钱，选择权归他。拿不准时调 \`ask_user\` 问。用户说了「重新生成再绑」，那就直接做。

【什么样的模型能绑】造型清晰的角色或动物：四肢分明、T/A 姿势最好、没有底座和道具粘连。
所以生成要绑骨的角色时，提示词里就写 T-pose、去掉底座。

【骨骼类型不确定就别填】厂商检查时会推荐一种，按推荐的绑。

【只绑骨，不带动画】出来的网格有骨架但没有动作。

【出完之后】返回值 \`model_path\` 是带骨架的网格。交给 \`ue_content_import\` 导入，
**\`fbx_import_as\` 填 \`skeletal_mesh\`**（不填可能被当成静态网格），\`asset_names\` 给个 SK_ 开头的名字。
要让它动起来，用 \`anim_retarget\` 把工程里现有的动画重定向过来。
`,
    input: Rig3dModelInput,
    execute: async (args, ctx) => {
      const resumeToken = String(args.resume_job_id ?? '').trim()
      if (resumeToken) {
        ctx.report({ text: `正在取回绑骨任务 ${resumeToken} 的结果（不重新提交、不再扣费）…` })
        const resumed = await resumeModel3d({
          jobToken: resumeToken,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          onProgress: (note) => ctx.report({ text: `任务状态：${note}` })
        }).catch((error: unknown) => {
          throw new Error(describeRigFailure(error))
        })
        return await saveAndReport(resumed, args.name, ['续取（本次未重新扣费）'])
      }

      const source = String(args.source_job_id ?? '').trim()
      if (!source) {
        return {
          isError: true,
          text: '要给 source_job_id（generate_3d_model 返回的 job_id），或者给 resume_job_id 续取一个绑骨任务。'
        }
      }

      ctx.report({ text: '正在自动绑骨，通常要一到几分钟…' })
      const rigged = await rigModel3d({
        sourceJobToken: source,
        ...(args.rig_type ? { rigType: args.rig_type } : {}),
        ...(args.spec ? { spec: args.spec } : {}),
        ...(args.format ? { format: args.format } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (note) => ctx.report({ text: `绑骨：${note}` }),
        onSubmitted: (token) =>
          ctx.setAbortNote?.(
            () =>
              `绑骨任务 ${token} 已经提交，额度已扣、厂商那边还在跑 —— ` +
              `要结果用 resume_job_id=${token} 接着取，不要重新绑。`
          )
      }).catch((error: unknown) => {
        throw new Error(describeRigFailure(error))
      })

      const notes = [`骨骼类型 ${rigged.rigType}，命名规范 ${rigged.spec}。`]
      if (rigged.recommendedRigType && rigged.recommendedRigType !== rigged.rigType) {
        notes.push(
          `注意：厂商检查推荐的是 ${rigged.recommendedRigType}，这次按指定的 ${rigged.rigType} 绑了。`
        )
      }
      const result = await saveAndReport(rigged, args.name || baseNameOf(source), notes)
      return {
        ...result,
        details: {
          ...result.details,
          rig_type: rigged.rigType,
          recommended_rig_type: rigged.recommendedRigType,
          spec: rigged.spec
        }
      }
    }
  })
}

/**
 * 下载落盘并汇报。地址 5 分钟就过期，拿到就下。
 * 存盘失败不算整次失败 —— 钱已经花了，至少把还没过期的地址交出去。
 */
async function saveAndReport(
  rigged: { files: { url: string; name: string }[]; job: Model3dJob },
  name: string | undefined,
  notes: string[]
): Promise<{ text: string; details: Rigged3dModelDetails }> {
  const token = encodeModel3dJob(rigged.job)
  const baseName =
    String(name ?? '')
      .trim()
      .slice(0, NAME_MAX_LENGTH) || baseNameOf(token)
  const mesh = rigged.files.find((file) => MESH_EXTENSION.test(file.name)) ?? rigged.files[0]

  const saved = mesh
    ? await downloadAndSaveAIGCAsset(mesh.url, 'model', {
        suggestedName: baseName,
        defaultExt: extensionOf(mesh.name) || '.fbx',
        timeout: 300_000,
        prompt: `自动绑骨（任务号 ${token}）`
      })
    : null

  const lines = [`绑骨完成（任务号 ${token}）。`, ...notes]
  if (saved?.success && saved.localPath) {
    lines.push(`带骨架的网格已存进素材库 AIGC/模型：${saved.localPath}`)
    lines.push(
      '进工程：交给 ue_content_import，fbx_import_as 填 skeletal_mesh。要动起来用 anim_retarget 重定向现有动画。'
    )
  } else {
    lines.push(
      '没有存下网格文件。厂商返回的地址是：' +
        rigged.files.map((file) => `${file.name} → ${file.url}`).join('；') +
        ' —— **5 分钟内就会失效**，请用户立刻另存；过期了用 resume_job_id 再取一次（不重新扣费）。'
    )
  }
  if (rigged.job.cost !== null) lines.push(`本次扣了 ${rigged.job.cost} 额度。`)

  return {
    text: lines.join('\n'),
    details: {
      success: true,
      job_id: token,
      ...(saved?.success && saved.localPath ? { model_path: saved.localPath } : {}),
      cost: rigged.job.cost,
      ...(saved && !saved.success && saved.error ? { save_error: saved.error } : {})
    }
  }
}

/** 失败说明：分清「没扣绑骨的钱、可以重来」和「已经扣了、别再提交」 */
function describeRigFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const parts = [raw]
  // 检查阶段的失败：上面那句已经说清了「绑骨还没提交」，别再接一句「已经扣了」
  if (/绑骨还没提交/.test(raw)) return raw
  if (/不能自动绑骨|只接了 Tripo/.test(raw)) {
    parts.push('原样重试是同一个结果。把原因告诉用户，由他决定下一步。')
  } else if (/任务已经提交成功|已停止等待|仍未完成/.test(raw)) {
    parts.push(
      '**不要重新绑** —— 绑骨已经提交、额度已经扣了。用上面的任务号作 resume_job_id 取回结果。'
    )
  } else if (/任务失败/.test(raw)) {
    parts.push('绑骨任务已经提交，**额度多半已经扣掉**。不要直接重试，先把原因告诉用户。')
  }
  return parts.join('\n')
}

function extensionOf(fileName: string): string {
  const match = fileName.match(/(\.[a-z0-9]+)$/i)
  return match ? match[1].toLowerCase() : ''
}

/** 没给名字时用任务号：唯一，而且对得回厂商控制台那一条 */
function baseNameOf(token: string): string {
  const fromJob = token.replace(/[:~]/g, '_').slice(0, NAME_MAX_LENGTH - 7)
  return fromJob ? `SK_${fromJob}` : 'SK_rigged'
}
