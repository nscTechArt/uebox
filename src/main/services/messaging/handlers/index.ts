/**
 * 消息处理器入口 —— UE → 盒子 方向的入站路由。
 *
 * ## 这里只该有插件真的会发的东西
 *
 * 曾经注册过 `file.*`、`task.*`、`plugin.*`、`system.shutdown` 四组路由，
 * 加起来 1600 行。插件源码里一次都没发过它们 —— 而它们提供的能力是
 * 「任意路径读写删文件」和「让主进程 process.exit(0)」。
 *
 * 本地 WebSocket 端口没有认证，浏览器的 WebSocket 又不受 CORS 约束，
 * 于是这些路由的实际含义是：用户打开任何一个网页，那个网页就能删他的文件、
 * 关掉盒子。它们不是「暂时没用上的功能」，是纯粹的攻击面，所以直接删掉
 * 而不是加开关 —— 留着开关就等于留着那段代码需要有人记得它默认是关的。
 *
 * 顺带一提，它们就算被调用也回不了包：回复走的是内部 `topic` 形状，
 * 而插件只认 `type`/`method`/`id`。这也是它们从未被使用过的旁证。
 *
 * 新增入站路由前先问一句：插件哪一行会发这条消息？答不上来就不要加。
 */
export { ContentHandler } from './contentHandler'
export { ProjectHandler } from './projectHandler'

import { MessageRouter } from '../router'
import type { ReplySender } from '../replySender'
import { ContentHandler } from './contentHandler'
import { ProjectHandler } from './projectHandler'
import { logger } from '../../logger'

/**
 * 注册所有消息处理器。
 *
 * 注册表本身就是允许列表 —— 路由器对没登记的 topic 直接丢弃并 warn。
 * 不再另外维护一份名单：两份表达同一件事，迟早会不一致。
 */
export function registerHandlers(router: MessageRouter, send: ReplySender): void {
  const contentHandler = new ContentHandler()
  contentHandler.setSender(send)
  contentHandler.registerRoutes(router)

  const projectHandler = new ProjectHandler()
  projectHandler.setSender(send)
  projectHandler.registerRoutes(router)

  logger.info('消息处理器注册完成')
}
