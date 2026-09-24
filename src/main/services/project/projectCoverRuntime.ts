import { getPublicDatabase } from '../../sqliteDataBase'
import { PathManager } from '../../utils/PathManager'
import { sendToAppWindows } from '../../appWindows'
import { ProjectCoverService } from './projectCovers'

let service: ProjectCoverService | undefined

export function getProjectCoverService(): ProjectCoverService {
  service ??= new ProjectCoverService(
    getPublicDatabase(),
    PathManager.getInstance().getPublicThumbnailsPath(),
    () => sendToAppWindows('db:project:library-changed')
  )
  return service
}

/** Waits briefly for in-flight scans; a stat hung on an offline network drive must not hold up quitting. */
export async function stopProjectCoverSync(timeoutMs = 2000): Promise<void> {
  if (!service) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    service.stop(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  clearTimeout(timer)
}
