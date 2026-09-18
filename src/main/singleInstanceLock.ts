interface SingleInstanceLockApp {
  requestSingleInstanceLock(): boolean
  quit(): void
}

/**
 * 申请主实例锁，并明确告诉启动链是否可以继续。
 *
 * `app.quit()` 只是在 Electron 生命周期里发起退出；调用方仍然必须根据返回值
 * 停止注册 `whenReady()` 初始化，否则第二实例仍可能在退出完成前启动本地服务。
 */
export function acquireSingleInstanceLock(app: SingleInstanceLockApp, disabled: boolean): boolean {
  if (disabled) return true

  const gotTheLock = app.requestSingleInstanceLock()
  if (!gotTheLock) app.quit()
  return gotTheLock
}
