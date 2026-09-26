import { basename, join, resolve } from 'node:path'

/**
 * 影子副本放 %LOCALAPPDATA%（不漫游、可能很大）。userData 被指到别处时
 * （开发时单独的 profile）跟着 userData 走，免得两个实例共用一份副本。
 */
export function shadowRootFor(userData: string, env: NodeJS.ProcessEnv = process.env): string {
  const roaming = env.APPDATA ? resolve(env.APPDATA) : null
  const local = env.LOCALAPPDATA ? resolve(env.LOCALAPPDATA) : null
  if (roaming && local && resolve(userData).toLowerCase().startsWith(roaming.toLowerCase())) {
    return join(local, basename(userData), 'lore-shadow')
  }
  return join(userData, 'lore-shadow')
}
