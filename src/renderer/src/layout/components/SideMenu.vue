<script setup lang="ts">
import AppTooltip from '@renderer/components/AppTooltip.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import { Layout, Menu, Popover } from 'ant-design-vue'
import { PhDotsThree, PhNotePencil, PhPencilSimple } from '@phosphor-icons/vue'
import UserSection from './UserSection.vue'
import ChatSessionList from './ChatSessionList.vue'
import SidebarToolsCustomize from './SidebarToolsCustomize.vue'
import BrandMark from '@renderer/components/BrandMark.vue'
import { useRouter } from 'vue-router'
import {
  generateMenuFromRoutes,
  findMenuTargetByKey,
  getSelectedMenuKeys,
  getOpenMenuKeys,
  type MenuItem
} from '../../common/routeUtils'
import { chatSessionRoute } from '../../common/chatRoute'
import { useAppInfo } from '@renderer/hooks/useAppInfo'
import routes from '../../router/modules'
import { useI18n } from 'vue-i18n'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useChatMessagesStore, type ChatMessage } from '@renderer/store/modules/chatMessages'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { resolveSidebarTools, useSidebarTools } from '../composables/sidebarTools'
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  parseSidebarWidth
} from '../sidebarWidth'

import collapseIcon from '@renderer/assets/icon/ic_collapse.png'

// 鼠标悬停状态
const isMac = window.api?.platform === 'darwin'

const isHovering = ref(false)

const { Sider } = Layout
const router = useRouter()
const { formattedAppName } = useAppInfo()
const { t, locale } = useI18n()
const chatStore = useChatSessionsStore()
const chatMsgStore = useChatMessagesStore()
const tabsStore = useTabsStore()

interface Props {
  collapsed: boolean
  /**
   * 收起态下是否正在「浮出」。
   *
   * 浮出的开关由 MainLayout 握着：触发它的是标签栏那枚按钮的悬停，
   * 不在这个组件里，所以状态也放在共同的父级。
   */
  peeking: boolean
}

interface Emits {
  (e: 'menu-click', key: string): void
  (e: 'toggle-collapsed'): void
  /** 鼠标进/出面板本身，用来续上或排掉浮层的收回 */
  (e: 'peek-enter'): void
  (e: 'peek-leave'): void
  /** 点了要去的地方，浮层该立刻让开 */
  (e: 'peek-close'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const getInitialSidebarWidth = (): number => {
  try {
    return parseSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
  } catch {
    return SIDEBAR_WIDTH_DEFAULT
  }
}

const sidebarWidth = ref(getInitialSidebarWidth())
const isResizingSidebar = ref(false)
let resizeStartX = 0
let resizeStartWidth = SIDEBAR_WIDTH_DEFAULT
let pendingSidebarWidth = SIDEBAR_WIDTH_DEFAULT
let resizeFrameId: number | null = null

const saveSidebarWidth = (): void => {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth.value))
  } catch (error) {
    console.warn('[SideMenu] Failed to save sidebar width:', error)
  }
}

const removeResizeListeners = (): void => {
  document.removeEventListener('pointermove', handleSidebarResize)
  document.removeEventListener('pointerup', stopSidebarResize)
  document.removeEventListener('pointercancel', stopSidebarResize)
  window.removeEventListener('blur', stopSidebarResize)
}

function startSidebarResize(event: PointerEvent): void {
  if (event.button !== 0 || props.collapsed) return
  event.preventDefault()
  isResizingSidebar.value = true
  resizeStartX = event.clientX
  resizeStartWidth = sidebarWidth.value
  pendingSidebarWidth = sidebarWidth.value
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('pointermove', handleSidebarResize)
  document.addEventListener('pointerup', stopSidebarResize)
  document.addEventListener('pointercancel', stopSidebarResize)
  window.addEventListener('blur', stopSidebarResize)
}

function handleSidebarResize(event: PointerEvent): void {
  if (!isResizingSidebar.value) return
  pendingSidebarWidth = clampSidebarWidth(resizeStartWidth + event.clientX - resizeStartX)
  if (resizeFrameId !== null) return
  resizeFrameId = requestAnimationFrame(() => {
    resizeFrameId = null
    sidebarWidth.value = pendingSidebarWidth
  })
}

function stopSidebarResize(): void {
  if (!isResizingSidebar.value) return
  if (resizeFrameId !== null) {
    cancelAnimationFrame(resizeFrameId)
    resizeFrameId = null
    sidebarWidth.value = pendingSidebarWidth
  }
  isResizingSidebar.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  removeResizeListeners()
  saveSidebarWidth()
}

const resetSidebarWidth = (): void => {
  sidebarWidth.value = SIDEBAR_WIDTH_DEFAULT
  saveSidebarWidth()
}

const handleResizerKeydown = (event: KeyboardEvent): void => {
  const nextWidth =
    event.key === 'ArrowLeft'
      ? sidebarWidth.value - 8
      : event.key === 'ArrowRight'
        ? sidebarWidth.value + 8
        : event.key === 'Home'
          ? SIDEBAR_WIDTH_MIN
          : event.key === 'End'
            ? SIDEBAR_WIDTH_MAX
            : null
  if (nextWidth === null) return
  event.preventDefault()
  sidebarWidth.value = clampSidebarWidth(nextWidth)
  saveSidebarWidth()
}

// 从路由生成菜单数据
const menuItems = ref<MenuItem[]>([])
const selectedKeys = ref<string[]>([])
const openKeys = ref<string[]>([])

onMounted(() => {
  menuItems.value = generateMenuFromRoutes(routes, t)
  console.log(menuItems.value)

  updateSelectedKeys()

  // 监听 MiniChat 保存会话的 IPC 事件，将数据同步到主窗口 store
  const handler = window.api?.on('chat-sessions:refresh', (...args: unknown[]) => {
    const sessionData = args[0] as { id: string; title: string; messages: ChatMessage[] }
    console.log('[SideMenu] 收到 MiniChat 会话同步事件:', sessionData.id)
    console.log('[SideMenu] 消息数量:', sessionData.messages?.length)
    console.log('[SideMenu] 消息数据:', JSON.stringify(sessionData.messages?.slice(0, 2)))
    // 创建会话
    chatStore.ensureSession(sessionData.id, sessionData.title)
    chatStore.updateTitle(sessionData.id, sessionData.title)
    // 同步消息到本地 store（使用深拷贝确保数据独立）
    if (sessionData.messages && sessionData.messages.length > 0) {
      chatMsgStore.replaceSessionMessages(sessionData.id, sessionData.messages)
      console.log('[SideMenu] 消息已存储, 验证:', chatMsgStore.getMessages(sessionData.id).length)
    }
  })
  // 保存 handler 以便清理
  if (handler) {
    ;(window as unknown as { __miniChatHandler?: unknown }).__miniChatHandler = handler
  }

  // 展开/折叠分组、加载更多会话都会改变内容高度，滚动条指示条要跟着重算
  if (menuContentRef.value && typeof ResizeObserver !== 'undefined') {
    contentResizeObserver = new ResizeObserver(() => updateScrollThumb())
    contentResizeObserver.observe(menuContentRef.value)
  }
})

onUnmounted(() => {
  stopSidebarResize()
  removeResizeListeners()
  contentResizeObserver?.disconnect()
  contentResizeObserver = null

  // 清理 IPC 监听器
  const handler = (window as unknown as { __miniChatHandler?: (...args: unknown[]) => void })
    .__miniChatHandler
  if (handler) {
    window.api?.off('chat-sessions:refresh', handler)
  }
})

// 更新选中的菜单项
const updateSelectedKeys = (): void => {
  const currentPath = router.currentRoute.value.path
  selectedKeys.value = getSelectedMenuKeys(currentPath, menuItems.value)
  openKeys.value = getOpenMenuKeys(currentPath, menuItems.value)
}

// 监听路由变化
router.afterEach(() => {
  updateSelectedKeys()
})

// 语言变了要重算菜单：菜单文案全部走 t()。
// 公开核心不按区域过滤入口，所以这里只盯语言。
watch(locale, () => {
  menuItems.value = generateMenuFromRoutes(routes, t)
})

const handleMenuClick = (info: any): void => {
  const key = info?.key as string
  const target = findMenuTargetByKey(menuItems.value, key) || key
  console.log('[SideMenu] menu target:', target)

  // 浮出状态下点了要去的地方，面板就该让开
  emit('peek-close')
  emit('menu-click', target)
}

/**
 * 计算共创市场菜单项
 */
const coCreateMarketItem = computed<MenuItem | undefined>(() => {
  return menuItems.value.find(
    (i) => i.path.includes('co-create-market') || i.label === t('menu.coCreateMarket')
  )
})

/**
 * 计算功能菜单项（剔除共创市场、个人中心、偏好设置）
 *
 * 项目库（路由 `/`）留在这条列表里，靠 meta.sort = 8 排在资产库（9）上面。
 */
const featureItems = computed<MenuItem[]>(() => {
  const exclude = new Set<string>()
  if (coCreateMarketItem.value) exclude.add(coCreateMarketItem.value.key)
  // 排除个人中心和偏好设置
  exclude.add('Profile')
  exclude.add('Preferences')
  return menuItems.value.filter((i) => !exclude.has(i.key))
})

/**
 * 侧边栏工具按用户偏好拆成两组：常驻直显 + 收进「更多」。
 *
 * 默认项目库/资产库/蓝图库/材质库常驻，知识库和 AI 创作收进「更多」，
 * 用户可以在「自定义」里改（见 layout/composables/sidebarTools.ts）。
 */
const { prefs: sidebarToolsPrefs, save: saveSidebarTools } = useSidebarTools()

const resolvedTools = computed(() =>
  resolveSidebarTools(featureItems.value, sidebarToolsPrefs.value)
)
const pinnedItems = computed(() => resolvedTools.value.pinned)
const moreItems = computed(() => resolvedTools.value.more)

// 「更多」的右侧弹层：点击触发行开合，点浮层外的任何地方自动收起（Popover 自带）
const morePopupOpen = ref(false)

// 当前路由落在「更多」里的工具时，触发行亮起 —— 弹层不自动弹出，只给视觉锚点
const isMoreActive = computed(() =>
  selectedKeys.value.some((key) => moreItems.value.some((item) => item.key === key))
)

// 侧边栏收起（且不在浮出态）时弹层必须跟着收，否则它会孤零零挂在 body 上
watch(
  () => [props.collapsed, props.peeking] as const,
  ([collapsed, peeking]) => {
    if (collapsed && !peeking) morePopupOpen.value = false
  }
)

// 「自定义」弹窗：从「更多」弹层的入口打开
const customizeOpen = ref(false)

const navigateToMoreItem = (item: MenuItem): void => {
  morePopupOpen.value = false
  emit('peek-close')
  const target = findMenuTargetByKey(menuItems.value, item.key) || item.path
  emit('menu-click', target)
}

const openCustomizeFromPopup = (): void => {
  morePopupOpen.value = false
  emit('peek-close')
  customizeOpen.value = true
}

const chatSessionListRef = ref<{ loadMore: () => boolean } | null>(null)

/**
 * 当前路由正在查看的会话，用于在列表里高亮
 */
const activeSessionId = computed<string>(() => {
  const sid = router.currentRoute.value.query?.sid
  return typeof sid === 'string' ? sid : ''
})

/**
 * 自绘的滚动条。
 *
 * 系统滚动条在 Chromium 里是要占宽度的，会把菜单文字挤窄一截；这里把它藏掉，
 * 换成一条浮在内容之上的指示条 —— 不参与布局，鼠标在侧边栏里时才显出来。
 */
const menuScrollRef = ref<HTMLElement | null>(null)
const menuContentRef = ref<HTMLElement | null>(null)
let contentResizeObserver: ResizeObserver | null = null
const scrollThumbTop = ref(0)
const scrollThumbHeight = ref(0)
const hasOverflow = ref(false)

const showScrollThumb = computed<boolean>(() => hasOverflow.value && isHovering.value)

const MIN_THUMB_HEIGHT = 24

function updateScrollThumb(): void {
  const el = menuScrollRef.value
  if (!el) return

  const { scrollTop, clientHeight, scrollHeight } = el
  if (scrollHeight <= clientHeight + 1) {
    hasOverflow.value = false
    return
  }

  hasOverflow.value = true
  const height = Math.max(MIN_THUMB_HEIGHT, (clientHeight / scrollHeight) * clientHeight)
  const maxTop = clientHeight - height
  const progress = scrollTop / (scrollHeight - clientHeight)

  scrollThumbHeight.value = height
  scrollThumbTop.value = Math.min(maxTop, Math.max(0, progress * maxTop))
}

/**
 * 处理侧边栏滚动事件，实现触底加载
 */
const handleScroll = (e: Event): void => {
  const target = e.target as HTMLElement
  updateScrollThumb()
  // 阈值设为 50px
  if (target.scrollTop + target.clientHeight >= target.scrollHeight - 50) {
    chatSessionListRef.value?.loadMore()
  }
}

/**
 * 处理鼠标进入侧边栏区域
 */
const handleMouseEnter = (): void => {
  isHovering.value = true
  emit('peek-enter')
  updateScrollThumb()
}

/**
 * 处理鼠标离开侧边栏区域
 */
const handleMouseLeave = (): void => {
  isHovering.value = false
  emit('peek-leave')
}

/**
 * 生成唯一的会话ID，用于区分独立标签
 */
function generateSessionId(): string {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `${t}${r}`
}

/**
 * 创建新的对话会话并跳转到虚幻AI助手欢迎页（独立tab）
 * 通过附加唯一的会话ID到查询参数，触发标签key使用fullPath从而创建新标签
 */
const createNewChat = (projectName?: string): void => {
  emit('peek-close')
  const sid = generateSessionId()
  // 带上工程名时，这条新会话发第一条消息就会归到那个工程下（见 sessionProjectBinding）
  const query = projectName ? { sid, project: projectName } : { sid }
  router.push({ name: 'AssistantWelcome', query })
}

/**
 * 打开指定会话ID的聊天页
 * @param id 会话ID
 */
function openChat(id: string): void {
  emit('peek-close')
  router.push(
    chatSessionRoute(
      id,
      tabsStore.historyTabs.map((tab) => tab.path)
    )
  )
}

// 会话的重命名、删除、置顶、归入工程都在 ChatSessionList 里，这里只负责导航。
</script>

<template>
  <!-- 收起后侧边栏不占位。这块占位符负责让出展开态的宽度，宽度带过渡，内容区不会硬跳 -->
  <div
    class="sidebar-spacer"
    :class="{ 'is-hidden': props.collapsed, 'is-resizing': isResizingSidebar }"
    :style="{ '--sidebar-width': `${sidebarWidth}px` }"
  />

  <!-- 收起后要把面板叫出来，靠的是鼠标悬停标签栏那枚按钮（见 TabsHeader），
       不是碰窗口左缘 -->
  <Sider
    :collapsed="false"
    :trigger="null"
    theme="light"
    :width="sidebarWidth"
    class="side-menu"
    :class="{
      'is-floating': props.collapsed,
      'is-peeking': props.peeking,
      'is-resizing': isResizingSidebar
    }"
    :style="{ '--sidebar-width': `${sidebarWidth}px` }"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <!-- logo 和收起按钮只属于贴边的侧边栏。收起之后这一整条都不要了：
         浮出的面板是临时叫出来的，顶上再摆一遍 logo 和开关只是重复
         —— 那时开关在标签栏最左边（见 TabsHeader） -->
    <div v-if="!props.collapsed" class="sider-header" :class="{ 'mac-controls-inset': isMac }">
      <div class="logo">
        <div class="brand-lockup" role="img" :aria-label="formattedAppName">
          <BrandMark class="brand-mark" />
          <span class="brand-wordmark">{{ formattedAppName }}</span>
        </div>
      </div>
      <AppTooltip placement="bottom" :title="t('layout.hideSidebar')">
        <AppButton
          variant="text"
          size="small"
          class="header-toggle"
          @click="emit('toggle-collapsed')"
        >
          <template #icon>
            <span
              class="mono-icon collapse-icon"
              role="img"
              :aria-label="t('layout.toggleSidebar')"
              :style="{ '--mono-icon': `url(${collapseIcon})` }"
            />
          </template>
        </AppButton>
      </AppTooltip>
    </div>

    <div class="new-chat">
      <AppButton block class="new-chat-btn" @click="createNewChat()">
        <template #icon>
          <PhNotePencil class="new-chat-icon" />
        </template>
        <span>{{ t('menu.newChat') }}</span>
      </AppButton>
    </div>

    <div class="menu-fixed">
      <Menu
        :selected-keys="selectedKeys"
        :open-keys="[]"
        mode="inline"
        theme="light"
        @click="handleMenuClick"
      >
        <Menu.Item v-if="coCreateMarketItem" :key="coCreateMarketItem.key" class="home-menu-item">
          <component :is="coCreateMarketItem.icon" v-if="coCreateMarketItem.icon" />
          <span>{{ coCreateMarketItem.label }}</span>
        </Menu.Item>
        <Menu.Divider />
      </Menu>
    </div>

    <div class="menu-scroll-wrap">
      <div ref="menuScrollRef" class="menu-scroll" @scroll="handleScroll">
        <div ref="menuContentRef">
          <Menu
            :selected-keys="selectedKeys"
            :open-keys="openKeys"
            mode="inline"
            theme="light"
            @click="handleMenuClick"
          >
            <template v-for="item in pinnedItems" :key="item.key">
              <Menu.SubMenu
                v-if="item.children && item.children.length > 0"
                :key="item.key + '-sub'"
              >
                <template #title>
                  <component :is="item.icon" v-if="item.icon" />
                  <span>{{ item.label }}</span>
                </template>
                <Menu.Item v-for="child in item.children" :key="child.key">
                  <component :is="child.icon" v-if="child.icon" />
                  <span>{{ child.label }}</span>
                </Menu.Item>
              </Menu.SubMenu>
              <Menu.Item v-else :key="item.key">
                <component :is="item.icon" v-if="item.icon" />
                <span>{{ item.label }}</span>
                <span v-if="item.isBeta" class="beta-tag">Beta</span>
              </Menu.Item>
            </template>
          </Menu>

          <!-- 更多：点击后从右侧弹出的浮层，收纳不常驻的工具（默认知识库、AI 创作）。
               不用 Menu.SubMenu 内联展开 —— 那会把列表顶下去，浮层才是参考稿的形态 -->
          <Popover
            v-model:open="morePopupOpen"
            trigger="hover"
            placement="rightTop"
            :mouse-enter-delay="0.15"
            :mouse-leave-delay="0.15"
            overlay-class-name="sidebar-more-popover"
          >
            <div class="more-trigger" :class="{ 'is-active': isMoreActive }">
              <PhDotsThree />
              <span>{{ t('sidebarTools.more') }}</span>
            </div>
            <template #content>
              <div class="more-popup">
                <div
                  v-for="item in moreItems"
                  :key="item.key"
                  class="more-popup-item"
                  :class="{ 'is-active': selectedKeys.includes(item.key) }"
                  @click="navigateToMoreItem(item)"
                >
                  <component :is="item.icon" v-if="item.icon" />
                  <span>{{ item.label }}</span>
                  <span v-if="item.isBeta" class="beta-tag">Beta</span>
                </div>
                <div class="more-popup-divider" />
                <!-- 「自定义」永远在弹层末尾，哪怕所有工具都勾成常驻，入口也不会丢 -->
                <div class="more-popup-item" @click="openCustomizeFromPopup">
                  <PhPencilSimple />
                  <span>{{ t('sidebarTools.customize') }}</span>
                </div>
              </div>
            </template>
          </Popover>

          <div class="sidebar-divider" />

          <!-- 收起后是整块面板浮出，面板里永远是展开态的内容，所以这里恒为 false -->
          <ChatSessionList
            ref="chatSessionListRef"
            :collapsed="false"
            :active-session-id="activeSessionId"
            @open="openChat"
            @new-chat="createNewChat"
          />
        </div>
      </div>

      <div
        v-show="showScrollThumb"
        class="menu-scrollbar"
        :style="{ top: `${scrollThumbTop}px`, height: `${scrollThumbHeight}px` }"
      />
    </div>

    <UserSection :collapsed="false" />

    <!-- 弹窗走 Teleport 挂到 body，放这只是为了就近持有状态 -->
    <SidebarToolsCustomize
      v-model:open="customizeOpen"
      :items="[...pinnedItems, ...moreItems]"
      :pinned-keys="pinnedItems.map((i) => i.key)"
      @save="saveSidebarTools"
    />

    <div
      v-if="!props.collapsed"
      class="sidebar-resizer"
      :class="{ 'is-active': isResizingSidebar }"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('layout.resizeSidebar')"
      :aria-valuemin="SIDEBAR_WIDTH_MIN"
      :aria-valuemax="SIDEBAR_WIDTH_MAX"
      :aria-valuenow="sidebarWidth"
      tabindex="0"
      @pointerdown="startSidebarResize"
      @dblclick="resetSidebarWidth"
      @keydown="handleResizerKeydown"
    />
  </Sider>
</template>

<style scoped lang="less">
// 侧边栏进出的一条曲线：占位符收宽度、面板滑出，两边必须同步，否则会看到一条缝
@sidebar-slide: 0.24s cubic-bezier(0.4, 0, 0.2, 1);

/**
 * 侧边栏始终是绝对定位的浮层，占位符负责在展开态把宽度让出来。
 *
 * 这样「收起」就是真的不占位（占位符宽度收到 0），而不是缩成一条窄轨道；
 * 收起后鼠标悬停标签栏那枚按钮，面板原样滑出来盖在内容上。
 */
.sidebar-spacer {
  flex: none;
  width: var(--sidebar-width);
  transition: width @sidebar-slide;

  &.is-hidden {
    width: 0;
  }

  &.is-resizing {
    transition: none;
  }
}

.side-menu {
  /**
   * 侧边栏行的统一度量。
   *
   * 工具列表是 ant Menu 渲染的，会话列表是我们自己的 DOM，两边靠这组变量对齐
   * ——行高、圆角、缩进、图标大小、悬停/选中色只在这里定义一次。
   * CSS 变量会往下继承，子组件（ChatSessionList / SidebarSectionHeader）直接用。
   */
  --sidebar-row-height: 32px;
  --sidebar-row-radius: var(--radius-sm);
  --sidebar-row-gap: var(--space-2);
  --sidebar-row-padding: var(--space-2);
  --sidebar-row-inset: var(--space-4);
  --sidebar-section-header-height: 32px;
  --sidebar-icon-size: 14px;
  /**
   * 三级字号，越往下越轻：
   * 分区标题（项目/对话）12px 中粗 → 工具项与工程行 14px → 具体会话 13px。
   * 层级靠字号和字重区分，不靠加箭头或加粗底色。
   */
  --sidebar-section-size: var(--font-size-sm);
  --sidebar-label-size: var(--font-size-base);
  --sidebar-item-size: 14px;
  // 侧边栏原有的两种交互底色，原来只写在工具菜单里，现在提上来给两个列表共用
  --sidebar-hover-bg: rgba(124, 92, 255, 0.08);
  --sidebar-active-bg: var(--color-accent-bg);
  --sidebar-focus-ring: var(--color-text-muted);
  --sidebar-text: var(--color-text-secondary);
  --sidebar-text-strong: var(--color-text-primary);
  --sidebar-text-muted: var(--color-text-muted);
  --sidebar-text-disabled: var(--color-text-disabled);

  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  // 高度一律由 top / bottom 推出来，不写死 height：
  // 收起时 top 要从 0 挪到标签栏下沿，写死高度会让这一下变成跳变
  // 用 left 而不是 transform 做滑动：一旦有 transform，浮出时那层
  // background-attachment: fixed 的主题底色就会改为贴着面板自己，对不上窗口背景
  transition:
    left @sidebar-slide,
    top @sidebar-slide;

  &.is-resizing {
    transition: none;
  }
  // 亮色主题从 255 轻轻过渡到 243；终点由语义表面色混合，暗色主题自动跟随。
  background: linear-gradient(
    to bottom,
    var(--color-bg-page) 0%,
    color-mix(in srgb, var(--color-bg-page) 33.333%, var(--color-bg-sunken)) 100%
  ) !important;
  box-shadow: var(--shadow-soft);
  border-radius: 0;
  overflow: hidden;
  z-index: 10;
  // 竖向是一条 flex：头部 / 新对话 / 主导航 / 滚动区（占满剩余）/ 用户区。
  // 原来用户区是绝对定位 + 给容器留 58px 内边距，用户名一长或多一枚徽章就会盖住列表最后一行。
  :deep(.ant-layout-sider-children) {
    background: transparent;
    display: flex;
    flex-direction: column;
    height: 100%;
    padding-bottom: 0;
    overflow: hidden;
  }

  :deep(.ant-menu) {
    background: transparent !important;
    border-right: none;
    border: none;
    border-radius: 0;
    margin: 0;
    padding: 0 var(--space-2);

    .ant-menu-item-divider {
      margin: var(--space-2) var(--space-2) 0;
      height: 1px;
      background: var(--color-bg-surface-hover);
    }

    // 工具行与会话行共用一套度量，两个列表在视觉上是同一条竖列
    .ant-menu-item,
    .ant-menu-submenu-title {
      width: auto;
      box-sizing: border-box;
      height: var(--sidebar-row-height);
      line-height: var(--sidebar-row-height);
      margin: 4px 0;
      padding: 0 var(--sidebar-row-padding) !important;
      display: flex;
      align-items: center;
      gap: var(--sidebar-row-gap);
      background: transparent !important;
      color: var(--sidebar-text);
      font-size: var(--sidebar-label-size);
      border-radius: var(--sidebar-row-radius);
      border: none;
      transition:
        background-color 0.2s ease,
        color 0.2s ease;

      &::after {
        display: none !important;
      }

      // 图标和文字的排版（flex 行 + 间距 + 省略号）在 antd-override.css 里统一给 ——
      // 它们的直接父级 .ant-menu-title-content 是 antd 内部渲染的，拿不到 scoped 属性，
      // 在这里写 :deep() 命中不稳。这里只管尺寸。
      svg {
        font-size: var(--sidebar-icon-size);
        margin: 0 !important;
      }

      &:hover {
        background: var(--sidebar-hover-bg) !important;
        color: var(--sidebar-text-strong);
      }

      &:focus-visible {
        outline: 2px solid var(--sidebar-focus-ring);
        outline-offset: -2px;
      }
    }

    .ant-menu-item.ant-menu-item-selected {
      background: var(--sidebar-active-bg) !important;
      color: var(--sidebar-text-strong);
    }

    .ant-menu-submenu .ant-menu-sub {
      background: transparent !important;
      padding-left: var(--space-2);
    }
  }

  // 收起态：整块推到窗口外，不留窄轨道，也不许再吃到鼠标事件。
  // 位置保持贴边时的样子（top 不动），收起就只是「原样往左滑出去」，
  // 不会在滑的过程中变成浮层的模样闪一下。
  //
  // 背景在这一态就换成不透明，而不是等到浮出：收起的那 0.24s 面板是一边滑出去
  // 一边和内容擦身而过的，半透明会让内容从它身上透过来闪一下。
  // 底层铺的是当前配色主题的窗口底色（--app-surface-bg，定义在 global.css），
  // 用 fixed 贴住视口，和窗口背景严丝合缝是同一张图，所以看起来和贴边时没有两样；
  // 上面再叠回侧边栏自己那层渐变。
  &.is-floating {
    left: calc(-1 * var(--sidebar-width));
    pointer-events: none;
    box-shadow: none;
    background-attachment: scroll, fixed !important;
    background-size: auto, cover !important;
    background-position: center, center !important;
    background-repeat: no-repeat, no-repeat !important;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    border-right: 1px solid var(--color-border-subtle);
  }

  // 浮出态：滑进来盖在内容之上，靠阴影和下面拉开层次。
  // 从标签栏下沿开始，标签栏最左边那枚开关才不会被面板压住、浮出时也点得到
  &.is-floating.is-peeking {
    left: 0;
    top: var(--app-tabs-height, 36px);
    pointer-events: auto;
    z-index: 100;
    box-shadow: var(--shadow-glass);
  }
}

.sidebar-resizer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  width: var(--space-2);
  cursor: col-resize;
  touch-action: none;

  &::after {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 1px;
    background: transparent;
    content: '';
  }

  &:hover::after,
  &:focus-visible::after,
  &.is-active::after {
    background: var(--color-border-focus);
  }

  &:focus-visible {
    outline: none;
  }
}

// Beta 标签样式
.beta-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  color: var(--color-text-secondary);
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-strong);
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.menu-fixed {
  flex: none;
  padding: var(--space-1) 0 0;
}

.menu-scroll-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}

// 唯一的滚动区：工具和会话一起滚
.menu-scroll {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: var(--space-2);
  overscroll-behavior: contain;
  // 系统滚动条会占掉一列宽度，把菜单文字挤窄，所以整条藏掉，改用下面那条浮层
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.menu-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

// 浮在内容上的滚动指示条：绝对定位，不参与布局，鼠标在侧边栏里才出现
.menu-scrollbar {
  position: absolute;
  right: 2px;
  width: 4px;
  border-radius: var(--radius-full);
  background: var(--color-bg-surface-hover);
  opacity: 0.6;
  pointer-events: none;
  transition: opacity 0.2s ease;
}

// logo 右边那枚收起按钮
.header-toggle {
  flex: none;
  // 和收起后标签栏那枚开关同尺寸，折叠前后按钮不变形
  width: 28px;
  height: 28px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: var(--space-2);
  opacity: 0.8;

  // antd 给 small 的纯图标按钮加了 scale(1.143)（14px→16px 的老约定），
  // 这里图标尺寸是自己写死的 20px，缩放只会让它比折叠后那枚大一圈
  :deep(> span) {
    transform: none;
  }
  -webkit-app-region: no-drag;
  border: none !important;
  background: transparent !important;

  &:hover {
    opacity: 1;
    background: var(--color-bg-surface-hover) !important;
  }
}

.collapse-icon {
  width: 20px;
  height: 20px;
  display: block;
}

.sidebar-divider {
  height: 1px;
  margin: var(--space-2) var(--sidebar-row-inset);
  background: var(--color-bg-surface-hover);
}

// 「更多」触发行：与工具菜单行同一套度量，视觉上是列表的一部分，
// 但不进 Menu —— 它的点击行为是弹浮层，不是导航
.more-trigger {
  display: flex;
  align-items: center;
  gap: var(--sidebar-row-gap);
  height: var(--sidebar-row-height);
  line-height: var(--sidebar-row-height);
  margin: 4px var(--space-2);
  padding: 0 var(--sidebar-row-padding);
  border-radius: var(--sidebar-row-radius);
  color: var(--sidebar-text);
  font-size: var(--sidebar-label-size);
  cursor: pointer;
  user-select: none;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;

  svg {
    display: block;
    flex: none;
    font-size: var(--sidebar-icon-size);
    margin: 0;
  }

  // 注意：anticon 自己也是 span，排除它否则图标也被撑开 flex:1，
  // 整行被平分成三列（图标靠左、文字悬在中间）
  > span {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  &:hover {
    background: var(--sidebar-hover-bg);
    color: var(--sidebar-text-strong);
  }

  &.is-active {
    background: var(--sidebar-active-bg);
    color: var(--sidebar-text-strong);
  }
}

// 「更多」弹层内容被 Teleport 到 body，作用域样式仍会跟着插槽内容生效。
// 全部度量与取值逐字复刻右键 ContextMenu（components/ContextMenu/ContextMenu.vue
// 的 .context-menu）—— 那边改了这边要跟着改，两处必须长得一模一样
.more-popup {
  display: flex;
  flex-direction: column;
  min-width: 220px;
}

.more-popup-item {
  display: flex;
  align-items: center;
  margin: 2px 0;
  padding: 8px 12px;
  border-radius: 6px;
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);

  svg {
    display: block;
    flex: none;
    margin-right: 12px;
    font-size: 14px;
    opacity: 0.9;
  }

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
    transform: translateX(2px);
  }

  &.is-active {
    background: var(--color-bg-selected);
    color: var(--color-text-selected);
  }
}

.more-popup-divider {
  height: 1px;
  margin: 6px 0;
  background: var(--color-bg-surface-hover);
}

/* 左边这段留给 macOS 的红绿灯。品牌标识照常显示，只是往右挪 —— 让位是让位，
   不是把它整个撤掉，否则 Mac 上哪儿都看不到应用名。 */
.sider-header.mac-controls-inset {
  padding-left: var(--space-20);

  .logo {
    padding-left: 0;
  }
}

.sider-header {
  -webkit-app-region: drag;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0;
  margin: auto 0;
  // 和右边标签栏同高，两条顶栏才在一条线上
  height: var(--app-tabs-height, 36px);
  border-radius: var(--radius-sm);
}
.logo {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0 16px;
  transition: all 0.3s ease;
  position: relative;
  overflow: hidden;

  .brand-lockup {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 100%;
    color: var(--color-text-primary);
    transition: all 0.3s ease;
    -webkit-app-region: drag;
  }

  .brand-mark {
    width: 20px;
    height: 20px;
    flex: none;
  }

  .brand-wordmark {
    overflow: hidden;
    font-family: 'Segoe UI Variable', 'Segoe UI', sans-serif;
    font-size: 15px;
    font-weight: 650;
    line-height: 1;
    letter-spacing: 0.06em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }
}

.new-chat {
  // 与下面两个列表用同一个左右缩进，按钮和菜单行左边缘对齐
  padding: 10px var(--space-2) 0;
  margin-bottom: var(--space-2);

  // 浮出时上面没有 logo 那一条了，自己补一点上边距，别贴着面板顶
  .side-menu.is-floating & {
    padding-top: var(--space-3);
  }
}

.new-chat-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-surface-hover) !important;
  border: none !important;
  color: var(--color-text-primary) !important;
  height: 36px;
  border-radius: var(--sidebar-row-radius) !important;

  &:hover {
    background: var(--color-bg-surface-hover) !important;
    border: none !important;
  }
}

.new-chat-icon {
  width: 20px;
  height: 16px;
  vertical-align: middle;
  object-fit: contain;
  margin-right: 1px;
}

.toggle-btn {
  opacity: 0.7;
  transition: opacity 0.3s ease;
  background: var(--color-bg-surface-hover) !important;
  border: 1px solid var(--color-border) !important;
  color: var(--color-text-secondary) !important;

  &:hover {
    opacity: 1;
    background: var(--color-bg-surface-hover) !important;
    color: var(--color-text-primary) !important;
  }
}

.user-section {
  position: relative;
  flex: none;
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--color-border-subtle);
  min-height: 56px;
  transition: none;
  justify-content: space-between;
}

.user-section.collapsed {
  justify-content: center;
  padding: 10px 0;
}

.user-section.collapsed .avatar {
  margin: 0 auto;
}

.user-section .avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
}

.user-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.user-info .name {
  font-size: 13px;
  color: var(--color-text-primary);
}

.user-info .plan {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.expand-icon {
  margin-left: auto;
  color: var(--color-text-secondary);
}
</style>

<style lang="less">
// Popover 的壳被 Teleport 到 body，不带本组件的 scope，只能开非 scoped 块调。
// 取值逐字复刻 ContextMenu.vue 的 .context-menu：半透明深色玻璃面板
.sidebar-more-popover {
  .ant-popover-inner,
  .ant-popover-inner-content {
    padding: 6px;
    border-radius: 10px;
    // 主题底色按 92% 不透明：跟主题表面色走，还留一点透气的毛玻璃感
    background: color-mix(in srgb, var(--color-bg-page) 92%, transparent) !important;
    backdrop-filter: blur(1px);
  }

  .ant-popover-arrow {
    display: none;
  }
}
</style>
