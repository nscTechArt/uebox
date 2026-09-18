import { defineStore } from 'pinia'
import { ref } from 'vue'
import { usePersistOptions } from '../../hooks/usePersistOptions'
import type { ChatGroupMode, ChatSortMode } from '../../layout/composables/chatSessionGrouping'

/** 用户手动加进侧边栏的工程（还没有任何对话时也要显示） */
export interface SidebarProject {
  projectName: string
  projectPath?: string
  engineVersion?: string
}

interface ChatSidebarState {
  groupMode: ChatGroupMode
  sortMode: ChatSortMode
  collapsedGroups: string[]
  manualProjects: SidebarProject[]
  hiddenProjects: string[]
  pinnedProjects: string[]
}

/**
 * 侧边栏「AI 对话」区域的用户偏好。
 *
 * 和会话数据分开存：这些是「我想怎么看」，换台机器/清空会话都不该丢。
 */
export const useChatSidebarStore = defineStore(
  'chat-sidebar',
  () => {
    const groupMode = ref<ChatGroupMode>('project')
    const sortMode = ref<ChatSortMode>('recent')
    /** 手动折叠起来的分组 key（默认全部展开） */
    const collapsedGroups = ref<string[]>([])

    function setGroupMode(mode: ChatGroupMode): void {
      groupMode.value = mode
    }

    function setSortMode(mode: ChatSortMode): void {
      sortMode.value = mode
    }

    function isGroupCollapsed(key: string): boolean {
      return collapsedGroups.value.includes(key)
    }

    function toggleGroup(key: string): void {
      const index = collapsedGroups.value.indexOf(key)
      if (index >= 0) {
        collapsedGroups.value.splice(index, 1)
      } else {
        collapsedGroups.value.push(key)
      }
    }

    function expandGroup(key: string): void {
      const index = collapsedGroups.value.indexOf(key)
      if (index >= 0) {
        collapsedGroups.value.splice(index, 1)
      }
    }

    /**
     * 手动添加的工程分组。
     *
     * 会话上盖的工程戳是自动的；这里存的是用户自己从「+」加进来的工程，
     * 哪怕一条对话都还没有也要一直显示在「项目」下面。
     */
    const manualProjects = ref<SidebarProject[]>([])

    /** 用户主动从侧边栏移走的工程；即使编辑器仍连着，也不自动再出现。 */
    const hiddenProjects = ref<string[]>([])

    function normalizedName(name: string): string {
      return name.trim().toLowerCase()
    }

    function addManualProject(project: SidebarProject): void {
      const projectName = project.projectName.trim()
      if (!projectName) return

      showProject(projectName)

      const key = normalizedName(projectName)
      if (manualProjects.value.some((item) => normalizedName(item.projectName) === key)) {
        return
      }

      manualProjects.value.push({
        projectName,
        projectPath: project.projectPath?.trim() || undefined,
        engineVersion: project.engineVersion?.trim() || undefined
      })
    }

    function removeManualProject(projectName: string): void {
      const key = normalizedName(projectName)
      const index = manualProjects.value.findIndex(
        (item) => normalizedName(item.projectName) === key
      )
      if (index >= 0) {
        manualProjects.value.splice(index, 1)
      }
    }

    function isProjectHidden(projectName: string): boolean {
      const key = normalizedName(projectName)
      return hiddenProjects.value.some((item) => normalizedName(item) === key)
    }

    /**
     * 用户明确移走的工程不应因编辑器仍然连接而自动回到侧边栏。
     * 主动重新添加或归入工程时，才会通过 showProject 恢复它。
     */
    function hideProject(projectName: string): void {
      const name = projectName.trim()
      if (!name || isProjectHidden(name)) return
      hiddenProjects.value.push(name)
    }

    function showProject(projectName: string): void {
      const key = normalizedName(projectName)
      const index = hiddenProjects.value.findIndex((item) => normalizedName(item) === key)
      if (index >= 0) {
        hiddenProjects.value.splice(index, 1)
      }
    }

    /** 置顶的工程名：排在「项目」区最前面 */
    const pinnedProjects = ref<string[]>([])

    function isProjectPinned(projectName: string): boolean {
      const key = normalizedName(projectName)
      return pinnedProjects.value.some((item) => normalizedName(item) === key)
    }

    function toggleProjectPinned(projectName: string): boolean {
      const name = projectName.trim()
      if (!name) return false

      const key = normalizedName(name)
      const index = pinnedProjects.value.findIndex((item) => normalizedName(item) === key)
      if (index >= 0) {
        pinnedProjects.value.splice(index, 1)
        return false
      }

      pinnedProjects.value.push(name)
      return true
    }

    /** 工程改名后，手动列表和置顶列表里的名字要跟着改，否则两边对不上 */
    function renameProject(projectName: string, nextName: string): void {
      const next = nextName.trim()
      if (!next) return

      const key = normalizedName(projectName)
      const manual = manualProjects.value.find((item) => normalizedName(item.projectName) === key)
      if (manual) manual.projectName = next

      const pinnedIndex = pinnedProjects.value.findIndex((item) => normalizedName(item) === key)
      if (pinnedIndex >= 0) pinnedProjects.value[pinnedIndex] = next

      const hiddenIndex = hiddenProjects.value.findIndex((item) => normalizedName(item) === key)
      if (hiddenIndex >= 0) hiddenProjects.value[hiddenIndex] = next
    }

    function isManualProject(projectName: string): boolean {
      const key = normalizedName(projectName)
      return manualProjects.value.some((item) => normalizedName(item.projectName) === key)
    }

    return {
      groupMode,
      sortMode,
      collapsedGroups,
      manualProjects,
      hiddenProjects,
      pinnedProjects,
      setGroupMode,
      setSortMode,
      isGroupCollapsed,
      toggleGroup,
      expandGroup,
      addManualProject,
      removeManualProject,
      hideProject,
      showProject,
      isProjectHidden,
      isManualProject,
      isProjectPinned,
      toggleProjectPinned,
      renameProject
    }
  },
  {
    persist: usePersistOptions<ChatSidebarState>({
      key: 'chat-sidebar',
      paths: [
        'groupMode',
        'sortMode',
        'collapsedGroups',
        'manualProjects',
        'hiddenProjects',
        'pinnedProjects'
      ],
      storage: 'localStorage'
    })
  }
)
