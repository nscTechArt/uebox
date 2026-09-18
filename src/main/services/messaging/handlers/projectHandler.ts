/**
 * 工程消息处理器
 * 处理 project.info 请求，管理工程生命周期
 */
import { MessageEnvelope, MessageType } from '../../types'
import { MessageRouter } from '../router'
import type { ReplySender } from '../replySender'
import { logger } from '../../logger'
import { projectManager } from '../../project'
import { autoRegisterConnectedProject } from '../../project/autoRegister'
import { ProjectInfoResponse } from '../../project/types'

/**
 * 工程处理器类
 * 负责处理来自 UE 插件的工程相关消息
 */
export class ProjectHandler {
  private send?: ReplySender

  setSender(send: ReplySender): void {
    this.send = send
  }

  /**
   * 注册路由
   * @param router 消息路由器
   */
  registerRoutes(router: MessageRouter): void {
    // 处理来自 UE 的 project.info 响应/事件
    // 当 UE 插件主动发送项目信息时（作为事件）或响应我们的请求时
    router.register('project.info', this.handleProjectInfo.bind(this))

    // 处理来自 UE 的 project.closed 事件
    // 当 UE 插件关闭时主动发送项目关闭消息
    router.register('project.closed', this.handleProjectClosed.bind(this))

    logger.info('[ProjectHandler] 已注册 project.info 和 project.closed 路由')
  }

  /**
   * 处理 project.info 消息
   * 当 UE 插件发送项目信息时调用
   * @param envelope 消息信封
   * @param connectionId WebSocket 连接 ID
   */
  private async handleProjectInfo(envelope: MessageEnvelope, connectionId: string): Promise<void> {
    try {
      const payload = envelope.payload as ProjectInfoResponse

      if (!payload) {
        logger.warn('[ProjectHandler] project.info 消息缺少 payload')
        return
      }

      logger.info(
        `[ProjectHandler] 收到项目信息: ${payload.projectName || 'Unknown'} (连接: ${connectionId})`
      )

      // 将项目添加到管理器
      projectManager.addProject(connectionId, payload)

      // 补登记进「我的项目」。这是三道网里的最后一道：不管这个工程当初是
      // 怎么来的（用户在 Epic 启动器建的、git clone 的、盒子装之前就有的），
      // 只要它连上来过，用户就该在首页看得见它。
      // 不 await —— 登记要读盘、写库、可能还要装插件，不该卡住连接建立
      void autoRegisterConnectedProject(payload.projectPath || '')

      // 把上次没解干净的只读位还原（资产锁 B 阶段的唯一兜底）。
      //
      // 放在连接时而不是盒子启动时：盒子启动那会儿还不知道有哪些工程，而残留的
      // 只读位恰恰是在用户开始用这个工程的时刻才咬人 —— 他会发现工程存不了，
      // 且完全查不出原因。同样不 await，读台账不该卡住连接建立。
      //
      // 顺带把锁状态整份重推一次，那一步在 `restoreOnConnect` 内部、还原之后做 ——
      // 这里不直接调，是因为消息层不该反过来 import `src/main/ipc/*`。
      void import('../../../agent-v3/core/assetLockEnforcement')
        .then(({ restoreOnConnect }) => restoreOnConnect(connectionId))
        .then((restored) => {
          if (restored > 0) {
            logger.warn(
              `[ProjectHandler] 还原了 ${restored} 个残留的只读资产（上次盒子没正常退出）`
            )
          }
        })
        .catch(() => {
          /* 兜底本身失败不该影响连接 */
        })

      // 发送确认响应（如果是请求消息）
      if (envelope.type === MessageType.COMMAND && envelope.id) {
        this.sendResponse(connectionId, envelope.id, true, {
          message: '项目信息已接收',
          projectName: payload.projectName
        })
      }
    } catch (error) {
      logger.error('[ProjectHandler] 处理 project.info 失败:', error)
    }
  }

  /**
   * 处理 project.closed 消息
   * 当 UE 插件关闭时调用，真正删除项目
   * @param envelope 消息信封
   * @param connectionId WebSocket 连接 ID
   */
  private async handleProjectClosed(
    envelope: MessageEnvelope,
    connectionId: string
  ): Promise<void> {
    try {
      const payload = envelope.payload as { projectName?: string; projectPath?: string }
      const projectName = payload?.projectName || 'Unknown'

      logger.info(`[ProjectHandler] 收到项目关闭消息: ${projectName} (连接: ${connectionId})`)

      // 真正删除项目，而不仅仅是标记为离线
      projectManager.deleteProject(connectionId)
    } catch (error) {
      logger.error('[ProjectHandler] 处理 project.closed 失败:', error)
    }
  }

  /**
   * 发送响应消息
   * @param connectionId 连接 ID
   * @param requestId 请求 ID
   * @param success 是否成功
   * @param data 响应数据
   */
  private sendResponse(
    connectionId: string,
    requestId: string,
    success: boolean,
    data?: Record<string, unknown>
  ): void {
    this.send?.(connectionId, {
      ver: '1.0',
      type: 'res',
      method: 'project.info',
      id: requestId,
      payload: { success, ...data },
      time: Date.now()
    })
  }
}
