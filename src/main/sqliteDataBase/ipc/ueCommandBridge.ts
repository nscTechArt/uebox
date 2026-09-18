/**
 * UE 命令桥。
 * 供本地调试 HTTP 接口调用，把统一命令名映射到 UE 插件端的实际命令。
 */
import { serviceManager } from '../../services'
import { runEditorPython } from '../../agent-v3/core/editorPython'

export interface UECommandRequest {
  command: string
  params: Record<string, unknown>
  projectPath?: string
}

export interface UECommandResult {
  success: boolean
  data?: unknown
  error?: string
}

const COMMAND_MAP: Record<string, string> = {
  ping: 'system.ping',
  exec_console: 'system.exec_console',
  exec_python: 'scripting.exec_python',
  get_selected_actors: 'editor.get_selected',
  spawn_actor: 'editor.spawn_actor',
  set_transform: 'editor.set_transform',
  viewport_screenshot: 'editor.viewport_screenshot',
  build_lighting: 'editor.build_lighting',
  import_asset: 'content.import',
  rename_asset: 'content.rename',
  move_asset: 'content.move',
  delete_asset: 'content.delete',
  duplicate_asset: 'content.duplicate',
  search_assets: 'content.search',
  open_asset: 'editor.open_asset',
  open_blueprint: 'editor.open_blueprint',
  open_level: 'editor.open_level',
  reveal_path: 'editor.reveal_path',
  package_project: 'project.package'
}

async function runPythonQuery(script: string): Promise<UECommandResult> {
  // 走 runEditorPython（插件 cmd.run_python）—— 这里原来有一份和它一模一样的
  // 「写临时脚本 + 轮询结果文件」实现，连 30 秒 ack 超时那个 bug 都一样。
  const result = await runEditorPython(script, 'debug python query')
  if (!result.success) {
    return { success: false, error: result.error || 'UE Python query failed' }
  }
  return { success: true, data: result.output ?? { stdout: result.stdout } }
}

export async function executeUECommand(request: UECommandRequest): Promise<UECommandResult> {
  try {
    const wsService = serviceManager.getWebSocketService()

    if (wsService.getConnectionCount() === 0) {
      return {
        success: false,
        error:
          'No connected Unreal Engine project was found. Make sure UE is running with UnrealAgentLink enabled.'
      }
    }

    if (request.command === 'run_python_query') {
      const script = String(request.params?.script || '').trim()
      if (!script) {
        return {
          success: false,
          error: 'Python query script is required'
        }
      }
      return await runPythonQuery(script)
    }

    const wsCommand = COMMAND_MAP[request.command] || request.command
    console.log(`[UE Bridge] Executing command: ${request.command} -> ${wsCommand}`)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await wsService.callRequest<any>(
      wsCommand,
      { ...request.params },
      undefined,
      30000
    )

    if (response && response.ok !== false) {
      return {
        success: true,
        data: response
      }
    }

    return {
      success: false,
      error: response?.error || response?.message || 'UE command execution failed'
    }
  } catch (error) {
    console.error('[UE Bridge] Command execution failed:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
