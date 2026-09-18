<template>
  <div v-if="locks.length > 0 || conflicts.length > 0" class="asset-lock-indicator">
    <!--
      冲突提示。用户必须看得见 —— 他可能开着两个窗口，以为两边在干不同的活；
      静默失败的话他只会看到一条会话莫名其妙地绕开了任务。
    -->
    <div v-for="(conflict, index) in conflicts" :key="`${conflict.path}-${index}`" class="conflict">
      <PhWarning class="conflict-icon" />
      <span class="conflict-text">
        {{
          t('assetLock.conflict', {
            path: shortPath(conflict.path),
            session: sessionLabel(conflict.owner)
          })
        }}
      </span>
      <button class="dismiss" :title="t('assetLock.dismiss')" @click="dismissConflict(index)">
        <PhX />
      </button>
    </div>

    <div v-if="locks.length > 0" class="summary">
      <PhLock class="summary-icon" />
      <button class="summary-text" @click="expanded = !expanded">
        {{ t('assetLock.summary', { count: locks.length }) }}
      </button>
      <!--
        逃生口。任何锁一旦因为 bug 卡死，用户的感受是「盒子把我工程搞坏了」
        而不是「有个 bug」—— 必须永远留一个看得见、点得到的出口。
      -->
      <button class="release" @click="releaseAll">{{ t('assetLock.releaseAll') }}</button>
    </div>

    <ul v-if="expanded && locks.length > 0" class="lock-list">
      <li v-for="lock in locks" :key="`${lock.connectionId ?? ''}-${lock.path}`">
        <span class="lock-path">{{ displayPath(lock.path) }}</span>
        <span v-if="lockOwnerLabel(lock.owner)" class="lock-owner">
          {{ lockOwnerLabel(lock.owner) }}
        </span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { PhLock, PhWarning, PhX } from '@phosphor-icons/vue'

import { useI18n } from '@renderer/hooks/useI18n'
import { useAssetLocks } from '@renderer/hooks/useAssetLocks'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'

const { t } = useI18n()
const { locks, conflicts, releaseAll, dismissConflict } = useAssetLocks()

/**
 * 关卡锁用的是一个 NUL 开头的哨兵键，不是包路径 —— Actor 类工具的参数里
 * 没有资产路径，盒子并不知道被改的是哪张关卡。直接渲染会在列表里露出一串
 * 带控制字符的乱码。
 */
function displayPath(path: string): string {
  return path.charCodeAt(0) === 0 ? t('assetLock.currentLevel') : path
}
const chatSessions = useChatSessionsStore()

const expanded = ref(false)

/** 完整包路径在一行提示里太长，只留末段 —— 想看全的可以展开列表 */
const shortPath = (path: string): string => path.split('/').pop() || path

/**
 * 锁主的 sessionId → 会话标题。
 *
 * 主进程那边只有 id（会话标题存在渲染层的 chatSessions store 里），所以这一步
 * 只能在这儿做 —— 而它必须做：真机上用户看到的是「被会话 b04ba478… 占用」，
 * 一串 uuid 既不告诉他是自己哪个窗口，也不告诉他该做什么。
 *
 * **先按 `agentSessionId` 查。** 锁主是内核那边的会话 id（`agent-v3:execute`
 * 收到的那个），跟界面这边的会话 `id` 不是一回事。原来直接拿它去 `sessionById`，
 * 于是**每一把锁都查不到**，全部显示成「另一条会话」—— 包括用户自己此刻正在
 * 用的这条。再退回按界面 id 查一次，是因为小窗口那类入口两个 id 可能同源。
 */
const sessionLabel = (owner: string): string => {
  const session =
    chatSessions.sessionByAgentSessionId(owner) || chatSessions.sessionById(owner) || null
  return session?.title || t('assetLock.unknownSession')
}

/**
 * 锁列表里的锁主。
 *
 * 查不到时留空，而不是写「另一条会话」：那是在**断言**这把锁属于别人，而绝大
 * 多数时候它就是用户眼前这条会话的锁。宁可少说一句，也别说一句错的。
 * 冲突提示那边不一样 —— 那里的锁主按定义就是另一条会话，所以照旧兜底。
 */
const lockOwnerLabel = (owner: string): string =>
  chatSessions.sessionByAgentSessionId(owner)?.title || chatSessions.sessionById(owner)?.title || ''
</script>

<style scoped lang="less">
.asset-lock-indicator {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 340px;
  font-size: 12px;
}

.conflict,
.summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
}

.conflict {
  border-color: var(--color-warning-border);
}

.conflict-icon {
  color: var(--color-warning-text);
  flex-shrink: 0;
}

.conflict-text {
  color: var(--color-text-primary);
  flex: 1;
  min-width: 0;
}

.summary-icon {
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.summary-text {
  flex: 1;
  min-width: 0;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--color-text-primary);
}

.release,
.dismiss {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--color-text-secondary);
  flex-shrink: 0;

  &:hover {
    color: var(--color-text-primary);
  }
}

.lock-list {
  margin: 0;
  padding: 6px 10px;
  list-style: none;
  border-radius: 6px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  max-height: 180px;
  overflow-y: auto;
}

.lock-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
}

.lock-path {
  color: var(--color-text-secondary);
  word-break: break-all;
  flex: 1;
  min-width: 0;
}

.lock-owner {
  color: var(--color-text-muted);
  flex-shrink: 0;
  white-space: nowrap;
}
</style>
