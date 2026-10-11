/**
 * 「允许浏览器访问局域网」开关的现读。
 *
 * 给不经过浏览器服务、自己做地址校验的工具用（`web_read`、`add_notebook_source`）：
 * 它们和浏览器共用同一套地址判据（`services/agentBrowser/urlPolicy.ts`），开关也得是同一个。
 *
 * 懒加载 `appSettingsManager`（AGENTS.md §7）：工具注册表静态引它会让所有摸到
 * 注册表的测试都去加载原生模块。读不到设置就当关。
 */
export async function browserLocalNetworkAllowed(): Promise<boolean> {
  try {
    const { appSettingsManager } = await import('../../../appSettingsManager')
    return appSettingsManager.getAgentBrowserAllowLocalNetwork()
  } catch {
    return false
  }
}
