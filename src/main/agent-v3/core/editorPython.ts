import { serviceManager } from '../../services'
import { getTargetConnectionId } from './projectTargetContext'

/**
 * 在编辑器里跑一段 Python。
 *
 * ## 走 `cmd.run_python`，不走控制台命令
 *
 * 插件那头 `cmd.run_python` 调的是 `IPythonScriptPlugin::ExecPythonCommandEx`，
 * 是一次**带返回值**的 RPC：`print()` 的每一行都在 `logs` 里，脚本抛异常时
 * `ok=false` 且 `result` 是 Python 的异常栈。
 *
 * 之前这里走的是 `system.run_console_command` 发 `py "<临时文件>"` —— 那条路
 * 只拿得到 OK/Failed，所以才要「写脚本文件 → 脚本自己写结果 JSON → 这边轮询」，
 * 还硬编码了 30 秒 ack 超时（ 记的那个 bug：
 * 超过 30 秒的脚本必定被报成失败，哪怕它其实跑成功了）。改走 RPC 之后
 * 临时文件、轮询、那个超时一起没了。
 *
 * ## 结果为什么从 `logs` 里捞，而不是 `result`
 *
 * `ExecuteFile` 模式下 `CommandResult` 成功时是空的 —— 引擎注释写得很明确：
 * 只有 `EvaluateStatement` 模式才回填结果，其余情况一律 None。所以约定脚本把
 * `output_data` 打成**一行**带前缀的 JSON 打印出来，这边从 `logs` 里找那一行。
 *
 * 靠得住的原因：UE 在 `Engine/Plugins/.../PythonScriptPlugin/Content/Python/unreal_core.py`
 * 里把 `sys.stdout` 接到了 `unreal.log`，而 `unreal.log` 会广播给
 * `FPythonLogCapture` —— 也就是 `logs`。所以 `print()` 一定进得来。
 *
 * ## 注意
 *
 * `ExecPythonCommandEx` 是同步的，会阻塞游戏线程。脚本跑多久，编辑器就卡多久，
 * 这边的 RPC 也就等多久。默认给到 5 分钟。
 */
export interface EditorPythonResult {
  success: boolean
  error?: string
  output?: Record<string, unknown>
  /** 脚本 print 出来的东西（不含结果行），尾部截断到 8000 字符 */
  stdout?: string
  /**
   * 没拿到执行结果（超时 / 连接断了），**不是**脚本自己报错。
   *
   * 分出来是因为这两种失败的下一步完全不同：脚本报错就改脚本再跑；没确认上则
   * 连"跑没跑"都不知道，重发可能把同一个修改做两遍。调用方按这个标志决定要不要
   * 给模型补那段排查指引 —— 指引只对模型有用，而这个 `error` 还会原样进用户界面
   * （`openAsset` 走 message.warning、`reviewChanges` 进审查面板）。
   */
  unconfirmed?: boolean
  /** 调用方主动停的，不是引擎卡了 */
  aborted?: boolean
}

interface RunPythonResponse {
  ok?: boolean
  result?: string
  logs?: { type?: string; message?: string }[]
  error?: string
}

/** 结果行前缀。取一个正常脚本不会 print 出来的串。 */
const RESULT_PREFIX = '__UA_RESULT__'

const STDOUT_LIMIT = 8000

/** 清掉上次结果，再执行原脚本；compile 保留原行号和 future import。 */
function wrapScript(script: string): string {
  // cmd.run_python 共享 globals；没清理就会把上一条脚本的 output_data 当本次回读。
  return `globals().pop('output_data', None)
exec(compile(${JSON.stringify(script)}, '<ua-script>', 'exec'), globals())
import json as _ua_json
print("${RESULT_PREFIX}" + _ua_json.dumps(globals().get('output_data'), ensure_ascii=False, default=str))
`
}

/** 从 logs 里分出「结果行」和「其余 print」。导出给测试用。 */
export function parsePythonLogs(logs: RunPythonResponse['logs']): {
  output?: Record<string, unknown>
  stdout?: string
  error?: string
} {
  const lines = (logs ?? []).map((entry) => entry?.message ?? '')

  // 用最后一条 —— 用户脚本自己 print 出带前缀的行时，我们追加的那条在后面。
  const resultLine = lines.filter((line) => line.startsWith(RESULT_PREFIX)).pop()
  const rest = lines.filter((line) => !line.startsWith(RESULT_PREFIX)).join('\n')

  let output: Record<string, unknown> | undefined
  let error: string | undefined
  if (resultLine) {
    try {
      const parsed: unknown = JSON.parse(resultLine.slice(RESULT_PREFIX.length))
      if (parsed && typeof parsed === 'object') output = parsed as Record<string, unknown>
    } catch {
      error = 'Python 结果无法解析，未确认执行结果；请回读校验，不要重复执行修改。'
    }
  } else {
    error = '未收到 Python 完成结果，未确认执行结果；请回读校验，不要重复执行修改。'
  }

  return {
    output,
    stdout: rest ? rest.slice(-STDOUT_LIMIT) : undefined,
    ...(error ? { error } : {})
  }
}

export async function runEditorPython(
  script: string,
  description: string,
  timeoutMs = 300_000,
  abortSignal?: AbortSignal
): Promise<EditorPythonResult> {
  // aborted 是这个结果的判别字段，发出去之前取消也要标 —— 别让调用方只能靠
  // 「我自己也查一遍 signal」才分得清「用户停的」和「引擎出事了」
  if (abortSignal?.aborted) {
    return { success: false, aborted: true, error: '已取消，脚本未发送' }
  }
  const wsService = serviceManager.getWebSocketService()
  if (wsService.getConnectionCount() === 0) {
    return { success: false, error: '没有连接的虚幻引擎项目' }
  }

  let response: RunPythonResponse
  let onAbort: (() => void) | undefined
  try {
    const call = wsService.callRequest<RunPythonResponse>(
      'cmd.run_python',
      { script: wrapScript(script) },
      getTargetConnectionId(),
      timeoutMs
    )
    // 引擎那头是同步阻塞的，取消不了；这里只是别让调用方跟着一起等。
    response = abortSignal
      ? await Promise.race([
          call,
          new Promise<never>((_, reject) => {
            onAbort = () =>
              reject(new Error('已停止等待；编辑器中的脚本可能仍在执行，请先回读再操作'))
            abortSignal.addEventListener('abort', onAbort, { once: true })
            if (abortSignal.aborted) onAbort()
          })
        ])
      : await call
  } catch (error) {
    /*
     * 这个 catch 同时接住三种东西：请求超时、连接断开，以及**调用方按了停止**
     * （上面那条 race 的拒绝）。它们不能共用一句话 —— 按停止是用户自己的动作，
     * 冲他喊「编辑器可能卡死了，请重启」是不对的。
     *
     * 排查指引也不在这里拼。这个 `error` 会原样进用户界面（`openAsset` 走
     * message.warning、`reviewChanges` 进审查面板），而那段指引是说给模型听的、
     * 还点名了一个用户根本调不到的工具。谁面对模型谁去拼：见 `unconfirmed` 的注释。
     */
    const reason = error instanceof Error ? error.message : String(error)
    if (abortSignal?.aborted) {
      return {
        success: false,
        aborted: true,
        unconfirmed: true,
        error: `已停止等待（${description}）：${reason}。编辑器里的脚本可能仍在执行，先回读再操作。`
      }
    }
    return {
      success: false,
      unconfirmed: true,
      error: `Python 执行未确认（${description}）：${reason}。请先回读，勿重复执行修改。`
    }
  } finally {
    if (onAbort) abortSignal?.removeEventListener('abort', onAbort)
  }

  const { output, stdout, error } = parsePythonLogs(response?.logs)

  if (response?.ok !== true) {
    return {
      success: false,
      // result 在失败时是 Python 异常栈，直接给出去 —— 模型要靠它改脚本
      error: response?.result || response?.error || `Python 执行失败：${description}`,
      stdout
    }
  }

  /*
   * 结果行丢了 = **没确认上**，不是「脚本写错了」。
   *
   * `parsePythonLogs` 的这两句话自己就写着「未确认执行结果」，但原来没带
   * `unconfirmed`，于是 `ue_run_python_script` 把它当普通脚本报错处理 ——
   * 回给模型的是「改改再跑」，而真相是这段脚本可能已经把关卡改了一半。
   * 触发得到：脚本自己 `sys.exit()`、把编辑器搞崩、或者这份引擎的 Python
   * 日志捕获什么都没回（插件只在 LogOutput 非空时才发 logs，ok 却照发 true）。
   */
  if (error) return { success: false, unconfirmed: true, error, stdout }
  return { success: true, output, stdout }
}
