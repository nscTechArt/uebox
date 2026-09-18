/**
 * 首批工具的公共结果（MCP `structuredContent`）。
 *
 * ## 为什么需要它
 *
 * 工具的结构化数据放在 `AgentToolResult.details` 里，而 `details` 是**给宿主
 * 界面用的**，从来没发给过 MCP 客户端。外部调用方今天只有两条路：
 *
 *   - 适配层的工具（`adaptV2Tool`）把整个返回值 `JSON.stringify` 塞进了文本块，
 *     所以数据其实在，只是没有形状，得靠调用方自己 `JSON.parse` 一段
 *     「碰巧是 JSON」的文本；
 *   - `defineTool` 原生工具（`ue_session_health`）连这条路都没有 ——
 *     `toContent()` 只转 `text`，它那份连接清单**只存在于一段中文散文里**。
 *
 * 两条都不能当接口用。这里给首批工具一份显式的、字段固定的结构化结果。
 *
 * ## 为什么是「显式挑字段」而不是把 details 整个透出去
 *
 * `details` 是宿主 UI 数据，里面有什么由各工具自便，透出去等于把内部结构
 * 变成对外接口 —— 以后改一个界面字段就是一次破坏性变更。所以一个工具一个
 * 小 serializer，字段是选出来的。没有 serializer 的工具不返回 `structuredContent`，
 * 保持现状。
 *
 * ## 缺失和「确认为空」必须分得开
 *
 * 旧插件不报某些字段（`selectedActorCount`、`world`、`camera_source` 都是
 * 后加的）。这时候一律给 `null`，**不补 0、不补空数组、不拿数组长度冒充总数**。
 * 「用户没选中任何东西」和「这个插件版本不告诉我们选了几个」是两件事，
 * 前者能下结论，后者只能去问。混成同一个 0 之后，调用方会拿一个它以为
 * 确认过的空结果继续往下做。
 *
 * ## 不做单位换算
 *
 * 位置厘米、旋转度、缩放倍数 —— 原样给出，另附一个 `units` 字段说清楚。
 * 替调用方换成米是那类「数据全程自洽、场景全程是错的」事故的源头
 * （原委见 `tools/ueUnits.ts` 文件头）。
 */

/** 有 serializer 的工具。其余工具不返回 structuredContent */
const SERIALIZERS: Record<string, (details: Record<string, unknown>) => Record<string, unknown>> = {
  ue_get_selection: serializeSelection,
  ue_get_actor: serializeActors,
  ue_screenshot: serializeScreenshot,
  ue_session_health: serializeSessionHealth,
  ue_undo_history: serializeUndoHistory,
  ue_undo: serializeUndo
}

/**
 * 把一个工具的 `details` 转成公共结构化结果。
 *
 * @returns 结构化结果；该工具没有 serializer、或 details 不是对象时为 `undefined`
 */
export function toStructuredContent(
  toolName: string,
  details: unknown
): Record<string, unknown> | undefined {
  const serialize = SERIALIZERS[toolName]
  if (!serialize) return undefined
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined

  try {
    return serialize(details as Record<string, unknown>)
  } catch (error) {
    // 序列化炸了不能把一次成功的工具调用变成失败：文本块里的结果是完整的，
    // 少一份结构化视图而已。
    console.warn(`[AgentV3][MCP-Server] ${toolName} 的公共结果序列化失败:`, error)
    return undefined
  }
}

/** 已导出的工具名，给测试和文档用 */
export const PUBLIC_RESULT_TOOLS = Object.keys(SERIALIZERS)

// ── 取值助手 ────────────────────────────────────────────────────────────────
//
// 一律「有才给、没有给 null」。见文件头：缺失不能伪装成确认为空。

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function arr(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** `{x, y, z}` 这类向量：三个分量都在才算数，缺一个就整体作废 */
function vec(value: unknown, keys: readonly string[]): Record<string, number> | null {
  const source = obj(value)
  if (!source) return null

  const out: Record<string, number> = {}
  for (const key of keys) {
    const component = num(source[key])
    if (component === null) return null
    out[key] = component
  }
  return out
}

const XYZ = ['x', 'y', 'z'] as const
const PITCH_YAW_ROLL = ['pitch', 'yaw', 'roll'] as const

// ── ue_get_selection ────────────────────────────────────────────────────────

/**
 * 用户此刻选中/打开着什么。
 *
 * 三组 `*Count` / `*Truncated` 都可能缺（旧插件），一律给 null。特别注意
 * **不能拿数组长度当总数**：数组本身就是被截断过的那 50 条。
 */
function serializeSelection(details: Record<string, unknown>): Record<string, unknown> {
  const editor = obj(details.focusedEditor)
  const graph = obj(details.focusedGraph)
  const browser = obj(details.contentBrowser)

  return {
    focusedEditor: editor
      ? {
          type: str(editor.type),
          name: str(editor.name),
          path: str(editor.path),
          isModified: bool(editor.isModified)
        }
      : null,
    focusedGraph: graph
      ? { name: str(graph.name), path: str(graph.path), nodeCount: num(graph.node_count) }
      : null,
    selectedNodes:
      arr(details.selectedNodes)?.map((entry) => {
        const node = obj(entry) ?? {}
        return {
          nodeId: str(node.node_id),
          class: str(node.class),
          title: str(node.title)
        }
      }) ?? null,
    selectedNodeCount: num(details.selectedNodeCount),
    selectedNodesTruncated: bool(details.selectedNodesTruncated),
    selectedActors:
      arr(details.selectedActors)?.map((entry) => {
        const actor = obj(entry) ?? {}
        return {
          name: str(actor.name),
          label: str(actor.label),
          class: str(actor.class),
          path: str(actor.path)
        }
      }) ?? null,
    selectedActorCount: num(details.selectedActorCount),
    selectedActorsTruncated: bool(details.selectedActorsTruncated),
    contentBrowser: browser
      ? {
          selectedAssets:
            arr(browser.selectedAssets)?.map((entry) => {
              const asset = obj(entry) ?? {}
              return { name: str(asset.name), path: str(asset.path), class: str(asset.class) }
            }) ?? null,
          selectedAssetCount: num(browser.selectedAssetCount),
          selectedAssetsTruncated: bool(browser.selectedAssetsTruncated),
          selectedFolders: arr(browser.selectedFolders)?.map((entry) => str(entry)) ?? null
        }
      : null,
    summary: str(details.summary)
  }
}

// ── ue_get_actor ────────────────────────────────────────────────────────────

/**
 * Actor 查询。
 *
 * `returnedCount` / `totalCount` / `truncated` 三个一起给，是为了堵住
 * 「前 50 条被当成全部」这条路（§4）。`total_found` 缺失时 `totalCount` 为 null，
 * `truncated` 也只能是 null —— 不知道总数就不知道有没有截断，不能猜一个 false。
 */
function serializeActors(details: Record<string, unknown>): Record<string, unknown> {
  const returnedCount = num(details.count)
  const totalCount = num(details.total_found)

  return {
    actors:
      arr(details.actors)?.map((entry) => {
        const actor = obj(entry) ?? {}
        const transform = obj(actor.transform)
        return {
          name: str(actor.name),
          path: str(actor.path),
          class: str(actor.class),
          blueprintPath: str(actor.blueprint_path),
          folderPath: str(actor.folder_path),
          transform: transform
            ? {
                location: vec(transform.location, XYZ),
                rotation: vec(transform.rotation, PITCH_YAW_ROLL),
                scale: vec(transform.scale, XYZ)
              }
            : null,
          bounds: vec(actor.bounds, XYZ),
          // 旋转翻成的人话（灯/相机必有，普通 Actor 只在 pitch/roll 非零时有）。
          // 三个裸角度对方向光等于什么都没说，见 `tools/ueOrientation.ts` 文件头
          orientation: str(actor.orientation)
        }
      }) ?? null,
    returnedCount,
    totalCount,
    truncated: returnedCount !== null && totalCount !== null ? totalCount > returnedCount : null,
    systemActorsExcluded: num(details.system_actors_excluded),
    // 单位一定要随数据走。裸数字 -19.5 按米读、按厘米读都成立
    units: { location: 'cm', rotation: 'deg', scale: 'multiplier', bounds: 'cm' },
    message: str(details.message)
  }
}

// ── ue_screenshot ───────────────────────────────────────────────────────────

/**
 * 截图。
 *
 * `path` 是**插件写出的原始 PNG**，是唯一可用的图像来源 —— 结果里那张
 * base64 已经被 `compressForContext()` 缩到 768px 并重新编码，不能拿它交付
 * 用户要的截图文件。
 *
 * `world` / `view` / `cameraSource` 缺失时给 null 而不是补一个默认值：
 * 一张图的结论对不对取决于它是从哪儿拍的，替插件编一个没确认的来源，
 * 比不说更糟。
 */
function serializeScreenshot(details: Record<string, unknown>): Record<string, unknown> {
  return {
    path: str(details.path),
    filename: str(details.filename),
    width: num(details.width),
    height: num(details.height),
    saved: bool(details.saved),
    saveError: str(details.save_error),
    world: str(details.world),
    view: str(details.view),
    cameraSource: str(details.camera_source),
    cameraLocation: vec(details.camera_location, XYZ),
    cameraRotation: vec(details.camera_rotation, PITCH_YAW_ROLL),
    // 这三个 >0 意味着画面还没到位（材质灰、贴图糊），调用方不该据此下结论
    pendingAssets: num(details.pending_assets),
    pendingShaders: num(details.pending_shaders),
    streamingInFlight: num(details.streaming_in_flight),
    units: { cameraLocation: 'cm', cameraRotation: 'deg' },
    message: str(details.message)
  }
}

// ── ue_undo_history / ue_undo ───────────────────────────────────────────────

/**
 * agent 撤销栈的当前状态。
 *
 * 外部调用方**必须**能结构化读到它，否则撤销就没法核实：这条栈是盒子内的
 * agent 和外部客户端共用的，只有比对「撤之前栈顶是什么、撤之后还剩几步」
 * 才能确认撤掉的是不是自己那一步。
 *
 * 只有一段中文摘要的时候，调用方唯一能做的就是相信工具的自述。
 */
function serializeUndoHistory(details: Record<string, unknown>): Record<string, unknown> {
  return {
    undoable: num(details.undoable),
    redoable: num(details.redoable),
    entries:
      arr(details.entries)?.map((entry) => {
        const item = obj(entry) ?? {}
        return {
          step: num(item.step),
          title: str(item.title),
          context: str(item.context),
          packages: arr(item.packages)?.map((pkg) => str(pkg)) ?? null
        }
      }) ?? null,
    summary: str(details.summary)
  }
}

/**
 * 一次撤销/重做的结果。
 *
 * `stepTitles` 是核实的关键：它说的是**具体撤掉了哪几步**，比「成功」两个字
 * 有用得多。`affectedPackages` 同样重要 —— 撤销只改内存，这些包要另外保存
 * 才会落盘，不说清楚用户会以为已经回退干净了。
 */
function serializeUndo(details: Record<string, unknown>): Record<string, unknown> {
  return {
    action: str(details.action),
    stepsApplied: num(details.steps_applied),
    stepTitles: arr(details.step_titles)?.map((title) => str(title)) ?? null,
    remaining: num(details.remaining),
    redoable: num(details.redoable),
    affectedPackages: arr(details.affected_packages)?.map((pkg) => str(pkg)) ?? null,
    summary: str(details.summary)
  }
}

// ── ue_session_health ───────────────────────────────────────────────────────

/**
 * 会话体检。
 *
 * 这个工具的连接清单原来**一个字都出不来**（`defineTool` 的 `toContent()`
 * 只转 text），而 `uebox projects list` / `uebox doctor` 要的就是这份数据。
 */
function serializeSessionHealth(details: Record<string, unknown>): Record<string, unknown> {
  return {
    state: str(details.state),
    connections:
      arr(details.connections)?.map((entry) => {
        const conn = obj(entry) ?? {}
        return {
          connectionId: str(conn.connection_id),
          projectName: str(conn.project_name),
          projectPath: str(conn.project_path),
          engineVersion: str(conn.engine_version),
          isCurrentTarget: bool(conn.is_current_target)
        }
      }) ?? null,
    editorProcesses:
      arr(details.editor_processes)?.map((entry) => {
        const proc = obj(entry) ?? {}
        return {
          pid: num(proc.pid),
          projectName: str(proc.project_name),
          projectPath: str(proc.project_path),
          engineVersion: str(proc.engine_version),
          connected: bool(proc.connected)
        }
      }) ?? null,
    currentTargetConnectionId: str(details.current_target_connection_id),
    sessionProjectNotConnected: str(details.session_project_not_connected),
    waitedSeconds: num(details.waited_seconds),
    summary: str(details.summary)
  }
}
