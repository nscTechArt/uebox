/**
 * 工程模板 API。
 *
 * 视图层不直接碰 `window.api`（AGENTS.md 硬规则 4）：错误在这里统一变成异常抛出，
 * 上层只写 try/catch，不用每处都判一遍 `result.success`。
 */
import type {
  CommunityFetchResult,
  CommunityTemplate,
  TemplateDownloadProgress,
  TemplateInfo,
  TemplateSource
} from '../../../shared/projectTemplate'

/** 统一的失败处理：主进程返回 `{ success: false, error }` 一律转成异常 */
function ensure<T extends { success: boolean; error?: string }>(result: T, fallback: string): T {
  if (!result || result.success !== true) {
    throw new Error(result?.error || fallback)
  }
  return result
}

/**
 * 把要发给主进程的模板对象拍成纯对象。
 *
 * 列表里的 `template` 来自 ref 的深响应式代理，Proxy 过不了 Electron IPC 的
 * 结构化克隆（`An object could not be cloned`），而且 `ipcRenderer.invoke`
 * 是以 reject 的形式失败的 —— 用户点「下载」，弹的就是这条英文原文。
 * `CommunityTemplate` 本来就是主进程从 JSON 清单解析出来的纯数据，
 * JSON 往返不丢信息。
 */
function toPlainTemplate(template: CommunityTemplate): CommunityTemplate {
  return JSON.parse(JSON.stringify(template)) as CommunityTemplate
}

export const projectTemplateAPI = {
  /** 列出本地可用的模板（内置 / 自制 / 已下载的社区模板） */
  list: async (): Promise<TemplateInfo[]> => {
    const result = ensure(await window.api.projectTemplate.list(), '加载模板列表失败')
    return result.templates || []
  },

  /** 从模板创建工程，返回新工程的 .uproject 路径 */
  createFromTemplate: async (params: {
    templatePath: string
    targetDir: string
    projectName: string
  }): Promise<string | undefined> => {
    const result = ensure(
      await window.api.projectTemplate.createFromTemplate(params),
      '从模板创建工程失败'
    )
    return result.uprojectPath
  },

  /** 把一个本地工程打包成自制模板 */
  addCustomTemplate: async (params: {
    sourceProjectPath: string
    templateName: string
  }): Promise<void> => {
    ensure(await window.api.projectTemplate.addCustomTemplate(params), '添加自定义模板失败')
  },

  /** 列出社区模板源 */
  listSources: async (): Promise<TemplateSource[]> => {
    const result = ensure(await window.api.projectTemplate.listSources(), '读取模板源失败')
    return result.sources || []
  },

  /**
   * 启用 / 禁用一个源。
   *
   * 启用是**用户对联网的显式表态** —— 在这之前应用不会去连任何模板源。
   */
  setSourceEnabled: async (id: string, enabled: boolean): Promise<TemplateSource[]> => {
    const result = ensure(
      await window.api.projectTemplate.setSourceEnabled({ id, enabled }),
      '切换模板源状态失败'
    )
    return result.sources || []
  },

  /** 添加自定义源 */
  addSource: async (name: string, url: string): Promise<TemplateSource[]> => {
    const result = ensure(
      await window.api.projectTemplate.addSource({ name, url }),
      '添加模板源失败'
    )
    return result.sources || []
  },

  /** 删除自定义源（内置源不可删，只能禁用） */
  removeSource: async (id: string): Promise<TemplateSource[]> => {
    const result = ensure(await window.api.projectTemplate.removeSource({ id }), '删除模板源失败')
    return result.sources || []
  },

  /** 抓取所有已启用源的清单。单个源失败不影响其它源，错误在各自的 result 里 */
  fetchCommunity: async (): Promise<CommunityFetchResult[]> => {
    const result = ensure(await window.api.projectTemplate.fetchCommunity(), '获取社区模板失败')
    return result.results || []
  },

  /** 下载一条社区模板，返回落地的 zip 路径 */
  downloadCommunity: async (
    sourceId: string,
    template: CommunityTemplate
  ): Promise<string | undefined> => {
    const result = ensure(
      await window.api.projectTemplate.downloadCommunity({
        sourceId,
        template: toPlainTemplate(template)
      }),
      '下载模板失败'
    )
    return result.templatePath
  },

  /** 取消一个进行中的下载 */
  cancelDownload: async (sourceId: string, templateId: string): Promise<boolean> => {
    const result = await window.api.projectTemplate.cancelDownload({ sourceId, templateId })
    return result?.success === true
  },

  /** 订阅下载进度，返回取消订阅函数 */
  onDownloadProgress: (listener: (payload: TemplateDownloadProgress) => void): (() => void) =>
    window.api.projectTemplate.onDownloadProgress(listener)
}
