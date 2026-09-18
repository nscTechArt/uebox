export interface UEConnectedProjectSummary {
  connectionId: string
  projectName: string
  projectPath?: string
  projectVersion?: string
  engineVersion?: string
  defaultMap?: string
  enabledPlugins?: string[]
  connectedAt?: number
  isConnected?: boolean
}

export interface UEProjectInfo {
  projectName: string
  projectPath?: string
  projectFile?: string
  projectVersion?: string
  engineVersion?: string
  engineAssociation?: string
  defaultMap?: string
  editorStartupMap?: string
  transitionMap?: string
  globalDefaultGameMode?: string
  currentLevelName?: string
  currentLevelPath?: string
  naniteEnabled?: boolean
  lumenGIEnabled?: boolean
  lumenReflectionsEnabled?: boolean
  dynamicGIMethod?: string
  reflectionMethod?: string
  targetPlatforms?: string[]
  modules?: string[]
  enabledPlugins?: string[]
}

export interface UEProjectContextMessage {
  role: 'user'
  content: string
}

export interface UEProjectContextResult {
  project: UEConnectedProjectSummary | null
  detail?: UEProjectInfo | null
  contextMessage?: UEProjectContextMessage
}

type WebsocketEnvelope<T> =
  | {
      success?: boolean
      data?: T
      error?: string
      message?: string
    }
  | T

const MAX_LIST_ITEMS = 30

function normalizePluginNames(input: unknown): string[] {
  if (!Array.isArray(input)) return []

  if (input.every((item) => typeof item === 'string')) {
    return input as string[]
  }

  return input
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const plugin = item as { name?: unknown; versionName?: unknown }
      const name = typeof plugin.name === 'string' ? plugin.name : ''
      const versionName = typeof plugin.versionName === 'string' ? plugin.versionName : ''
      return name ? `${name}${versionName ? ` (${versionName})` : ''}` : ''
    })
    .filter(Boolean)
}

function truncateList(items: string[], limit = MAX_LIST_ITEMS): string[] {
  if (items.length <= limit) return items
  return [...items.slice(0, limit), `...其余 ${items.length - limit} 项已省略`]
}

function formatBooleanStatus(value: boolean | undefined): string {
  if (value === true) return '已启用'
  if (value === false) return '未启用'
  return '未知'
}

function formatRenderMethod(method: string | undefined): string {
  if (!method) return '未知'
  switch (method) {
    case '0':
      return '0 (无)'
    case '1':
      return '1 (Lumen)'
    case '2':
      return '2 (屏幕空间)'
    default:
      return method
  }
}

function unwrapWsEnvelope<T>(response: WebsocketEnvelope<T> | null | undefined): T | null {
  if (!response) return null

  if (typeof response === 'object' && response !== null && 'success' in response) {
    const envelope = response as { success?: boolean; data?: T }
    if (envelope.success === true && envelope.data !== undefined) {
      return envelope.data
    }

    if (envelope.success === false) {
      return null
    }
  }

  return response as T
}

function isUnknownMethodResponse(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false

  const envelope = response as {
    success?: boolean
    data?: unknown
    error?: string
    message?: string
  }
  const payload =
    envelope.success === true && envelope.data !== undefined ? envelope.data : response

  if (!payload || typeof payload !== 'object') return false

  const candidate = payload as {
    ok?: boolean
    success?: boolean
    code?: number
    error?: string
    message?: string
    __rpc?: { code?: number }
  }

  const code = candidate.__rpc?.code ?? candidate.code
  const message = String(
    candidate.error || candidate.message || envelope.error || envelope.message || ''
  )

  return (
    (candidate.ok === false || candidate.success === false || envelope.success === false) &&
    code === 404 &&
    message.includes('Unknown method')
  )
}

function normalizeProjectSummary(project: unknown): UEConnectedProjectSummary | null {
  if (!project || typeof project !== 'object') return null

  const source = project as {
    connectionId?: unknown
    projectName?: unknown
    projectPath?: unknown
    projectVersion?: unknown
    engineVersion?: unknown
    defaultMap?: unknown
    enabledPlugins?: unknown
    connectedAt?: unknown
    isConnected?: unknown
  }

  if (typeof source.connectionId !== 'string' || typeof source.projectName !== 'string') {
    return null
  }

  return {
    connectionId: source.connectionId,
    projectName: source.projectName,
    projectPath: typeof source.projectPath === 'string' ? source.projectPath : undefined,
    projectVersion: typeof source.projectVersion === 'string' ? source.projectVersion : undefined,
    engineVersion: typeof source.engineVersion === 'string' ? source.engineVersion : undefined,
    defaultMap: typeof source.defaultMap === 'string' ? source.defaultMap : undefined,
    enabledPlugins: normalizePluginNames(source.enabledPlugins),
    connectedAt: typeof source.connectedAt === 'number' ? source.connectedAt : undefined,
    isConnected: source.isConnected !== false
  }
}

function normalizeProjectInfo(
  project: unknown,
  fallback?: UEConnectedProjectSummary | null
): UEProjectInfo | null {
  if (!project || typeof project !== 'object') {
    return fallback
      ? {
          projectName: fallback.projectName,
          projectPath: fallback.projectPath,
          projectVersion: fallback.projectVersion,
          engineVersion: fallback.engineVersion,
          defaultMap: fallback.defaultMap,
          enabledPlugins: fallback.enabledPlugins
        }
      : null
  }

  const source = project as {
    projectName?: unknown
    projectPath?: unknown
    projectFile?: unknown
    projectVersion?: unknown
    engineVersion?: unknown
    engineAssociation?: unknown
    defaultMap?: unknown
    editorStartupMap?: unknown
    transitionMap?: unknown
    globalDefaultGameMode?: unknown
    currentLevelName?: unknown
    currentLevelPath?: unknown
    naniteEnabled?: unknown
    lumenGIEnabled?: unknown
    lumenReflectionsEnabled?: unknown
    dynamicGIMethod?: unknown
    reflectionMethod?: unknown
    targetPlatforms?: unknown
    modules?: unknown
    enabledPlugins?: unknown
  }

  const projectName =
    typeof source.projectName === 'string' && source.projectName.trim()
      ? source.projectName
      : fallback?.projectName

  if (!projectName) {
    return null
  }

  return {
    projectName,
    projectPath:
      typeof source.projectPath === 'string' ? source.projectPath : fallback?.projectPath,
    projectFile: typeof source.projectFile === 'string' ? source.projectFile : undefined,
    projectVersion:
      typeof source.projectVersion === 'string' ? source.projectVersion : fallback?.projectVersion,
    engineVersion:
      typeof source.engineVersion === 'string' ? source.engineVersion : fallback?.engineVersion,
    engineAssociation:
      typeof source.engineAssociation === 'string' ? source.engineAssociation : undefined,
    defaultMap: typeof source.defaultMap === 'string' ? source.defaultMap : fallback?.defaultMap,
    editorStartupMap:
      typeof source.editorStartupMap === 'string' ? source.editorStartupMap : undefined,
    transitionMap: typeof source.transitionMap === 'string' ? source.transitionMap : undefined,
    globalDefaultGameMode:
      typeof source.globalDefaultGameMode === 'string' ? source.globalDefaultGameMode : undefined,
    currentLevelName:
      typeof source.currentLevelName === 'string' ? source.currentLevelName : undefined,
    currentLevelPath:
      typeof source.currentLevelPath === 'string' ? source.currentLevelPath : undefined,
    naniteEnabled: typeof source.naniteEnabled === 'boolean' ? source.naniteEnabled : undefined,
    lumenGIEnabled: typeof source.lumenGIEnabled === 'boolean' ? source.lumenGIEnabled : undefined,
    lumenReflectionsEnabled:
      typeof source.lumenReflectionsEnabled === 'boolean'
        ? source.lumenReflectionsEnabled
        : undefined,
    dynamicGIMethod:
      typeof source.dynamicGIMethod === 'string' ? source.dynamicGIMethod : undefined,
    reflectionMethod:
      typeof source.reflectionMethod === 'string' ? source.reflectionMethod : undefined,
    targetPlatforms: Array.isArray(source.targetPlatforms)
      ? source.targetPlatforms.filter((item): item is string => typeof item === 'string')
      : undefined,
    modules: Array.isArray(source.modules)
      ? source.modules.filter((item): item is string => typeof item === 'string')
      : undefined,
    enabledPlugins: (() => {
      const pluginNames = normalizePluginNames(source.enabledPlugins)
      return pluginNames.length > 0 ? pluginNames : fallback?.enabledPlugins
    })()
  }
}

export function listConnectedProjects(projects: unknown[]): UEConnectedProjectSummary[] {
  return projects
    .map((project) => normalizeProjectSummary(project))
    .filter(
      (project): project is UEConnectedProjectSummary => !!project && project.isConnected !== false
    )
}

export function pickCurrentConnectedProject(projects: unknown[]): UEConnectedProjectSummary | null {
  const normalized = listConnectedProjects(projects)

  if (normalized.length === 0) {
    return null
  }

  normalized.sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0))
  return normalized[0]
}

async function fetchProjectInfo(method: string, connectionId: string): Promise<unknown | null> {
  try {
    return await window.api.websocket.call(method, {}, connectionId, 10000)
  } catch {
    return null
  }
}

async function fetchCurrentProjectDetail(
  currentProject: UEConnectedProjectSummary
): Promise<UEProjectInfo | null> {
  const editorResponse = await fetchProjectInfo(
    'editor.get_project_info',
    currentProject.connectionId
  )
  if (editorResponse && !isUnknownMethodResponse(editorResponse)) {
    const editorPayload = unwrapWsEnvelope(editorResponse)
    const normalized = normalizeProjectInfo(editorPayload, currentProject)
    if (normalized) return normalized
  }

  const projectInfoResponse = await fetchProjectInfo('project.info', currentProject.connectionId)
  const projectInfoPayload = unwrapWsEnvelope(projectInfoResponse)
  return normalizeProjectInfo(projectInfoPayload, currentProject)
}

export async function buildUEProjectContextForProject(
  project: UEConnectedProjectSummary
): Promise<UEProjectContextResult> {
  const detail = await fetchCurrentProjectDetail(project)
  const projectInfo = detail || normalizeProjectInfo(project, project)

  if (!projectInfo) {
    return { project }
  }

  return {
    project,
    detail: projectInfo,
    contextMessage: {
      role: 'user',
      content:
        `【当前打开的 UE 工程上下文 - ${projectInfo.projectName}】\n` +
        `${buildProjectContextText(projectInfo)}\n\n` +
        '以上信息来自当前已打开并连接的 Unreal Engine 工程。请在回答时结合这些实时工程信息与知识库内容；如果两者冲突，请明确区分“知识库资料”和“当前工程状态”。'
    }
  }
}

function buildProjectContextText(projectInfo: UEProjectInfo): string {
  const sections: string[] = []

  sections.push(`- 项目名称: ${projectInfo.projectName}`)
  sections.push(`- 引擎版本: ${projectInfo.engineVersion || '未知'}`)

  if (projectInfo.projectVersion) {
    sections.push(`- 项目版本: ${projectInfo.projectVersion}`)
  }

  if (projectInfo.projectPath) {
    sections.push(`- 项目路径: ${projectInfo.projectPath}`)
  }

  if (projectInfo.currentLevelName || projectInfo.currentLevelPath) {
    sections.push(
      `- 当前编辑关卡: ${projectInfo.currentLevelName || '未知'}${projectInfo.currentLevelPath ? ` (${projectInfo.currentLevelPath})` : ''}`
    )
  }

  if (projectInfo.defaultMap) {
    sections.push(`- 默认地图: ${projectInfo.defaultMap}`)
  }

  if (projectInfo.editorStartupMap) {
    sections.push(`- 编辑器启动地图: ${projectInfo.editorStartupMap}`)
  }

  if (projectInfo.globalDefaultGameMode) {
    sections.push(`- 全局默认 GameMode: ${projectInfo.globalDefaultGameMode}`)
  }

  if (
    projectInfo.naniteEnabled !== undefined ||
    projectInfo.lumenGIEnabled !== undefined ||
    projectInfo.lumenReflectionsEnabled !== undefined
  ) {
    sections.push(`- Nanite: ${formatBooleanStatus(projectInfo.naniteEnabled)}`)
    sections.push(`- Lumen GI: ${formatBooleanStatus(projectInfo.lumenGIEnabled)}`)
    sections.push(
      `- Lumen Reflections: ${formatBooleanStatus(projectInfo.lumenReflectionsEnabled)}`
    )

    if (projectInfo.dynamicGIMethod) {
      sections.push(`- 动态 GI 方法: ${formatRenderMethod(projectInfo.dynamicGIMethod)}`)
    }

    if (projectInfo.reflectionMethod) {
      sections.push(`- 反射方法: ${formatRenderMethod(projectInfo.reflectionMethod)}`)
    }
  }

  if (projectInfo.targetPlatforms && projectInfo.targetPlatforms.length > 0) {
    sections.push(`- 目标平台: ${projectInfo.targetPlatforms.join(', ')}`)
  }

  if (projectInfo.modules && projectInfo.modules.length > 0) {
    sections.push(`- 项目模块: ${truncateList(projectInfo.modules).join(', ')}`)
  }

  if (projectInfo.enabledPlugins && projectInfo.enabledPlugins.length > 0) {
    sections.push(`- 已启用插件: ${truncateList(projectInfo.enabledPlugins).join(', ')}`)
  }

  return sections.join('\n')
}

export async function getCurrentConnectedUEProject(): Promise<UEConnectedProjectSummary | null> {
  try {
    const projects = (await window.api.websocket.getProjects()) as unknown[]
    return pickCurrentConnectedProject(projects)
  } catch {
    return null
  }
}

export async function buildCurrentUEProjectContext(): Promise<UEProjectContextResult> {
  const currentProject = await getCurrentConnectedUEProject()
  if (!currentProject) {
    return { project: null }
  }

  return buildUEProjectContextForProject(currentProject)
}
