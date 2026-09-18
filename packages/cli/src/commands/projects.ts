/**
 * `uebox projects list` —— 现在有哪些 UE 工程能操作。
 *
 * 没有工程时**成功返回空数组**，不是失败（§4）。「我问一下有没有」和
 * 「我要用但没有」是两回事：前者的正确答案就是「零个」，把它报成错会让
 * 脚本里一句普通的探测变成需要 try/catch 的东西。
 *
 * 判断「能不能干活」是 `doctor` 的职责，那一头零个工程会如实报失败。
 */

import { success, type Envelope } from '../envelope.js'
import * as runtime from '../runtime.js'

export interface ProjectsOptions {
  configPath?: string
  timeoutSeconds?: number
  env?: NodeJS.ProcessEnv
}

export async function runProjectsList(options: ProjectsOptions): Promise<Envelope> {
  const rt = await runtime.open({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
    ...(options.env ? { env: options.env } : {})
  })

  try {
    const projects = await runtime.registeredProjects(rt)

    return success({
      data: {
        projects: projects.map((project) => ({
          name: project.name,
          path: project.path,
          // connectionId 一并给出来，但它是**一次连接**的 id：编辑器每重启一次
          // 就换一个。脚本里要长期指代一个工程，用 path。
          connectionId: project.connectionId
        })),
        count: projects.length
      },
      warnings:
        projects.length === 0
          ? ['当前没有 UE 工程连着。打开工程并等 UnrealAgentLink 握手完成后再试。']
          : []
    })
  } finally {
    await rt.close()
  }
}
