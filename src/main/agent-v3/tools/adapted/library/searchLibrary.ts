/**
 * `library_search` —— 在蓝图库 / 材质库里找用户攒下的片段。
 *
 * 一个工具管两个库，靠参数区分。开两个几乎一样的检索工具的话，模型选错了
 * 只会拿到一句「没找到」，而它根本不知道自己搜错了库。
 *
 * 只读本地包目录，不碰引擎，所以不进审批门。
 */

import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { searchEntries } from '../../../../services/library/libraryEntryStore'
import { requireVaultRoot } from './vaultRoot'

const SearchSchema = z.object({
  library: z.enum(['blueprint', 'material']).optional().describe('只搜某一个库。不填就两个都搜'),
  keyword: z.string().optional().describe('按条目名模糊匹配，大小写不敏感'),
  node_class: z
    .string()
    .optional()
    .describe(
      '按图里用到的节点类型匹配，如 "Branch"、"Sequence"、"K2Node_CallFunction"。' +
        '只有片段条目有这个信息'
    ),
  limit: z.number().int().min(1).max(200).optional().describe('最多回多少条，默认 50')
})

export function createLibrarySearchTool(): V2Tool {
  return defineV2Tool({
    description: `在蓝图库 / 材质库里检索用户存下来的片段。

【什么时候用】
- 用户说「把之前存的那个受击闪红放进来」——先用这里找到条目 id。
- 想知道库里有没有现成的东西可用，而不是从零写一段逻辑。

【回什么】
每条带 id、名字、所属库、格式、节点数、用到的节点类型。
**id 是 blueprint_library_apply 的入参**，从这里抄。

【格式那一栏要注意】
- \`snippet\`：从引擎里存下来的片段，扫过外部依赖，能直接放进工程
- \`t3d\`：手工粘进库的老条目，没扫过依赖，只能在库里预览、自己复制去 UE 粘，**放不进去**

只读本地保管库，不需要连引擎。`,

    inputSchema: SearchSchema,

    execute: async (input) => {
      const vault = requireVaultRoot()
      if ('error' in vault) return { success: false, error: vault.error }

      try {
        const entries = await searchEntries({
          vaultRoot: vault.vaultRoot,
          library: input.library,
          keyword: input.keyword,
          nodeClass: input.node_class,
          limit: input.limit
        })

        return {
          success: true,
          count: entries.length,
          entries: entries.map((entry) => ({
            id: entry.id,
            name: entry.name,
            library: entry.library,
            form: entry.form,
            ...(entry.nodeCount !== undefined ? { node_count: entry.nodeCount } : {}),
            ...(entry.connectionCount !== undefined
              ? { connection_count: entry.connectionCount }
              : {}),
            ...(entry.openPortCount ? { open_port_count: entry.openPortCount } : {}),
            ...(entry.classes?.length ? { classes: entry.classes } : {})
          })),
          summary:
            entries.length === 0
              ? '库里没有匹配的条目。'
              : `找到 ${entries.length} 条。放进工程用 blueprint_library_apply，参数里的 entry_id 就是这里的 id。`
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  })
}
