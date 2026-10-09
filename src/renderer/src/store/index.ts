import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import {
  CHAT_MESSAGES_STORE_ID,
  chatMessagesPersistencePlugin
} from '../utils/chatMessagesPersistence'
import { guardPersistForChatWindow } from '../utils/chatWindowStorageGuard'
import { isChatWindow } from '../api/chatWindow'

// 创建pinia实例
const pinia = createPinia()

// chat-messages 不能走通用插件：它会在每次流式 mutation 后同步序列化整份历史。
// 专用插件把节流放在序列化之前；其他低频 Store 继续沿用原持久化方案。
pinia.use(chatMessagesPersistencePlugin)
pinia.use((context) => {
  if (context.store.$id === CHAT_MESSAGES_STORE_ID) return
  // 独立对话窗口不改写主窗口的界面状态，见 chatWindowStorageGuard.ts
  if (isChatWindow()) guardPersistForChatWindow(context.options)
  return piniaPluginPersistedstate(context)
})

export default pinia
