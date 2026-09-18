/**
 * 内容浏览器整理工具集（`content.*` 里的批量 / 闭包那一半）。
 *
 * 和 `adapted/ue-content-browser/`（单资产的搜索、描述、导入、删除，V2 适配件）
 * 的分工：那边一次一个，这边一次一批，而且全都先能 dry_run。
 *
 * 走 C++ 不走 Python，理由：跨九个引擎版本的正确性
 * 由编译器在发版前保证。引擎侧在 `UAL_ContentOrganizeCommands.cpp`。
 *
 * ## 已注册
 *
 *   - `ue_content_naming_audit`  命名规范体检，给建议名（只读）
 *   - `ue_content_move`          批量移动 / 改名 / 整目录搬迁（取代原单资产版本）
 *   - `ue_content_dependencies`  依赖 / 被引用闭包、断链、无引用资产（只读）
 *   - `ue_content_migrate`       连同依赖闭包拷到另一个工程
 *
 * 安全网：
 *
 *   - `ue_project_path_refs`     扫工程 C++ / ini / csv / py 里按路径引用资产的地方（纯盒子侧，不依赖引擎）
 *   - `ue_content_rollback`      按账本把一次 ue_content_move 原路搬回
 *
 * 签出预检和 CDO 引用两道闸在插件的 `content.batch_move` 里，没有单独的工具；
 * 注册表就绪那层在 `defineUeTool.ts`，所有走 RPC 的内容工具自动带。
 *
 * 重定向器清理 `ue_fixup_redirectors` 仍在 `adapted/ue-editor/editorLifecycle.ts`，
 * 这一轮给它加了 paths / delete_broken。
 */

import { batchMoveTool } from './batchMove'
import { dependenciesTool } from './dependencies'
import { migrateTool } from './migrate'
import { namingAuditTool } from './namingAudit'
import { projectPathRefsTool } from './projectPathRefs'
import { rollbackTool } from './rollback'
import type { UnrealAgentTool } from '../defineTool'

export function contentOrganizeTools(): UnrealAgentTool<never>[] {
  // 工具带自己的 details 类型，注册表要的是统一的 never —— 与 ue-mesh 同一处理
  return [
    namingAuditTool,
    batchMoveTool,
    dependenciesTool,
    migrateTool,
    projectPathRefsTool,
    rollbackTool
  ] as unknown as UnrealAgentTool<never>[]
}
