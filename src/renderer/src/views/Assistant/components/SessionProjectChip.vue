<script setup lang="ts">
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuDivider from '@renderer/components/AppMenuDivider.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppMenuItemGroup from '@renderer/components/AppMenuItemGroup.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
import { computed } from 'vue'
import { useConnectedProjects } from '@renderer/composables/useBridgeStatus'
import { PhCaretDown, PhFolder, PhFolderOpen } from '@phosphor-icons/vue'
import { useI18n } from 'vue-i18n'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useChatSidebarStore } from '@renderer/store/modules/chatSidebarStore'
import {
  collectKnownProjects,
  listProjectChoices,
  projectPathKey,
  type ConnectedProjectRef,
  type ProjectChoice
} from '@renderer/layout/composables/chatSessionGrouping'
import { listConnectedProjects } from '../composables/ueProjectContext'
import type { ChatSessionProject } from '@renderer/store/modules/chatSessions'

interface Props {
  /** 当前对话 ID；为空时不显示 */
  chatSid?: string
  /**
   * 侧边栏在工程标题上点「+」时带过来的工程名（路由参数 `?project=`）。
   *
   * 这条对话要等第一条消息才进 store，在那之前它的归属只存在于路由上；
   * 不认这个值的话，用户明明是在某个工程下新建的对话，右上角却写着
   * 「未归属项目」，看起来就像点了没用。
   */
  pendingProjectName?: string
  /** 下拉菜单相对胶囊的位置：顶栏里靠右对齐，欢迎页里居中 */
  placement?: 'bottom' | 'bottomRight'
}

const props = withDefaults(defineProps<Props>(), {
  chatSid: '',
  pendingProjectName: '',
  placement: 'bottomRight'
})

const { t } = useI18n()
const chatStore = useChatSessionsStore()
const sidebarStore = useChatSidebarStore()

function toConnectedRefs(projects: unknown[]): ConnectedProjectRef[] {
  return listConnectedProjects(projects).map((project) => ({
    projectName: project.projectName,
    projectPath: project.projectPath,
    engineVersion: project.engineVersion
  }))
}

/**
 * 订阅 + 首拉都交给 useConnectedProjects。
 *
 * 原来是手写的：首拉不 await 就直接订阅，看着没有泄漏，但 `getProjects()`
 * 回来时会**无条件覆盖** —— 启动过程中连上的编辑器被那份更旧的快照盖掉，
 * 要等下一次连接变化才重新出现。composable 里的 `pushed` 就是挡这个的。
 * 顺带：读失败时原来会写成 `[]`，那是拿一次失败的读断言「什么都没连」。
 */
const connectedProjectsRaw = useConnectedProjects()
const connectedProjects = computed(() => toConnectedRefs(connectedProjectsRaw.value ?? []))

/** 待定归属：对话还没进 store 之前，先按侧边栏点「+」时选的工程显示 */
const pendingProject = computed<ChatSessionProject | null>(() => {
  const name = props.pendingProjectName.trim()
  return name ? { projectName: name } : null
})

/**
 * 对话上真正定过的归属。
 *
 * `undefined` 是「还没定过」，`null` 是用户明说了「不归属」—— 后者不能再回落到
 * 待定值上，否则点了「移出项目」胶囊纹丝不动。
 */
const storedProject = computed<ChatSessionProject | null | undefined>(() =>
  props.chatSid ? chatStore.sessionById(props.chatSid)?.project : undefined
)

const sessionProject = computed<ChatSessionProject | null>(() =>
  storedProject.value === undefined ? pendingProject.value : storedProject.value
)

const projectName = computed<string>(() => sessionProject.value?.projectName || '')

/**
 * 当前对话所属的那个已连接工程。
 *
 * 和主进程 `matchConnectedProject` 同一个规矩：戳上有路径就只认路径 ——
 * 同名的另一个工程连着不算；老戳没路径才退到名字。
 */
const matchedConnected = computed<ConnectedProjectRef | undefined>(() => {
  const project = sessionProject.value
  if (!project?.projectName) return undefined
  const path = projectPathKey(project.projectPath)
  if (path) {
    return connectedProjects.value.find((item) => projectPathKey(item.projectPath) === path)
  }
  const name = project.projectName.trim().toLowerCase()
  return connectedProjects.value.find((item) => item.projectName.trim().toLowerCase() === name)
})

/** 当前对话所属的工程此刻是否正连着编辑器 */
const isConnected = computed<boolean>(() => Boolean(matchedConnected.value))

const engineVersion = computed<string>(
  () => matchedConnected.value?.engineVersion || sessionProject.value?.engineVersion || ''
)

/** 已连着编辑器的工程排最前 —— 多数时候要选的就是它；同名工程按路径各占一行 */
const projectOptions = computed<ProjectChoice[]>(() =>
  listProjectChoices(
    collectKnownProjects(chatStore.displayableSessions, sidebarStore.manualProjects),
    connectedProjects.value
  )
)

const tooltip = computed<string>(() => {
  if (!projectName.value) return t('assistantTopNav.sessionProject.none')

  const parts = [projectName.value]
  if (engineVersion.value) parts.push(`UE ${engineVersion.value}`)
  if (sessionProject.value?.projectPath) parts.push(sessionProject.value.projectPath)
  return parts.join('\n')
})

function assignProject(project: ConnectedProjectRef): void {
  if (!props.chatSid) return

  // 新开的对话在发第一条消息之前还没进 store，直接 setProject 会静默落空。
  // 用户点了「归入项目」就是明确表态，先把这条对话建出来再盖戳。
  // 标题用 useChatFlow 比对的同一个 key，免得首条消息的自动改名失效。
  chatStore.ensureSession(props.chatSid, t('assistant.chatFlow.unnamedChat'))

  chatStore.setProject(props.chatSid, {
    projectName: project.projectName,
    projectPath: project.projectPath,
    engineVersion: project.engineVersion
  })
}

function clearProject(): void {
  if (!props.chatSid) return

  // 和上面同理：对话还没建出来时，「移出项目」也得留下痕迹，
  // 否则待定归属还挂在路由上，首条消息一发又被盖回去。
  chatStore.ensureSession(props.chatSid, t('assistant.chatFlow.unnamedChat'))
  chatStore.clearProject(props.chatSid)
}
</script>

<template>
  <AppDropdown v-if="props.chatSid" :trigger="['click']" :placement="props.placement">
    <AppTooltip placement="bottom" :title="tooltip">
      <span
        class="session-project-chip"
        :class="{ linked: Boolean(projectName), connected: isConnected }"
        @click.stop
      >
        <PhFolderOpen v-if="isConnected" class="chip-icon" />
        <PhFolder v-else class="chip-icon" />
        <!-- 胶囊上只放工程名。引擎版本号动辄 `5.5.4-40574608+++UE5+Release-5.5`，
             放进来会把工程名整个挤没；它去提示气泡里，鼠标停一下就能看到 -->
        <span class="chip-name">
          {{ projectName || t('assistantTopNav.sessionProject.none') }}
        </span>
        <PhCaretDown class="chip-arrow" />
      </span>
    </AppTooltip>

    <template #overlay>
      <AppMenu>
        <AppMenuItemGroup :title="t('assistantTopNav.sessionProject.pick')">
          <AppMenuItem
            v-for="option in projectOptions"
            :key="option.key"
            :item-key="option.key"
            @click="assignProject(option.project)"
          >
            <span :class="{ 'option-connected': option.connected }">
              {{ option.project.projectName }}
              <template v-if="option.connected"> · {{ t('chatSidebar.connected') }} </template>
            </span>
            <span v-if="option.detail" class="option-detail">{{ option.detail }}</span>
          </AppMenuItem>
          <AppMenuItem v-if="projectOptions.length === 0" disabled>
            {{ t('assistantTopNav.noConnectedProjects') }}
          </AppMenuItem>
        </AppMenuItemGroup>
        <template v-if="projectName">
          <AppMenuDivider />
          <AppMenuItem danger @click="clearProject">
            {{ t('chatSidebar.removeFromProject') }}
          </AppMenuItem>
        </template>
      </AppMenu>
    </template>
  </AppDropdown>
</template>

<style scoped lang="less">
.session-project-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 220px;
  padding: 4px 10px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  background: var(--color-bg-surface);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease;

  &:hover {
    border-color: var(--color-border-strong);
    color: var(--color-text-primary);
  }

  &.linked {
    color: var(--color-text-secondary);
  }

  // 连着编辑器时把文件夹图标染成 UE 蓝 —— 绿点留给「任务完成」，不表示连接
  &.connected .chip-icon {
    color: var(--color-accent-text);
  }
}

.chip-icon {
  flex: none;
  font-size: var(--font-size-sm);
}

.chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  // 没有 min-width:0 的话，flex 项不肯缩到内容以下，省略号根本不会出现
  min-width: 0;
}

.option-detail {
  display: block;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.option-connected {
  color: var(--color-success-text);
}

.chip-arrow {
  flex: none;
  font-size: 10px;
  color: var(--color-text-muted);
}
</style>
