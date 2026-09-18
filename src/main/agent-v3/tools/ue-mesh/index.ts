/**
 * 静态 / 骨骼网格工具集。
 *
 * 覆盖 UE 5.0–5.8 —— Epic 官方的 38 个网格工具只有 5.8 才有，
 * 而今天在产的国内项目绝大多数还在 5.0–5.4。
 *
 * 设计与边界。两条关键裁决：
 *
 * 1. **走 C++ 不走 Python**（§2）。判据不是「哪个好写」，是跨九个引擎版本的
 *    正确性由谁保证 —— C++ 在我们发版前编译失败，Python 在用户机器上抛异常。
 * 2. **不做 38 个工具**（§5）。Epic 那 38 个里 24 个是纯 getter，
 *    模型问一句「这模型能不能优化」要连着调七八次。我们合成一个 `mesh_describe`。
 *
 * ## 已注册
 *
 *   - `mesh_describe` —— 一次读完一个网格的全部信息，并给出判断
 *
 * 未实现（见文档 §7 的顺序）：`mesh_audit`（批量体检，走 AssetRegistry 标签不加载资产）、
 * `mesh_optimize`（生成 LOD/碰撞）、`mesh_sockets`。
 */

import { z } from 'zod'

import { defineUeTool } from '../defineUeTool'
import { summarizeMesh } from './summarize'
import type { MeshDescribeResponse } from './types'
import type { UnrealAgentTool } from '../defineTool'

const NAMESPACE = 'ue.mesh'

const describeMesh = defineUeTool<z.ZodTypeAny, MeshDescribeResponse>({
  name: 'mesh_describe',
  namespace: NAMESPACE,
  method: 'mesh.describe',
  // 只读 —— 不触发审批
  risk: 'safe',
  description: `读取一个静态网格或骨骼网格资产的全部信息，一次问清楚。

**静态网格**：每级 LOD 的面数/顶点/分段/UV 通道/屏占比、这级 LOD 是导入的还是引擎生成的、
材质槽、碰撞（图元数、凸包数、复杂度）、Nanite 开关、光照贴图 UV 通道及其是否有效、
包围盒、原点位置（居中/贴底面/在角点，拼模块化套件靠它算坐标）、Socket。

**骨骼网格**：每级 LOD 的面数/顶点/分段、材质槽、骨架、骨骼摘要（数量/根/层级深度）、
物理资产、Socket、Morph Target、包围盒。

返回里 ⚠️ 开头的是**已经判定出来的问题**（没有碰撞、光照贴图通道索引无效、
骨骼网格缺物理资产、LOD 屏占比不递减），不用自己再去比对数字。
这几类问题引擎都不会报错，只会表现为「没反应」或渲染出问题。

骨骼**只返回摘要不返回全表** —— 几百根骨骼没有信息量。要找某根骨头请另行询问。`,
  input: z.object({
    path: z.string().describe('网格资产路径，如 /Game/Meshes/SM_Rock 或 /Game/Characters/SK_Hero')
  }),
  toOutcome: (response) => ({
    text: summarizeMesh(response),
    details: {
      ...response,
      ...(response.bounds ? { bounds: { ...response.bounds, space: 'asset', unit: 'cm' } } : {})
    }
  })
})

export function meshTools(): UnrealAgentTool<never>[] {
  // 工具带自己的 details 类型，注册表要的是统一的 never —— 与 ue-material / ue-sequencer 同一处理
  return [describeMesh] as unknown as UnrealAgentTool<never>[]
}
