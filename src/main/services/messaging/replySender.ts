import type { IMessageEnvelope } from '../websocket/types'

/**
 * 处理器给 UE 回包的方式。
 *
 * 实参是 `WebSocketService.sendToClient`。做成一个函数类型而不是让处理器
 * 持有整个服务，是为了让「处理器能对外做什么」一眼看得完：就这一件事。
 */
export type ReplySender = (connectionId: string, envelope: IMessageEnvelope) => boolean
