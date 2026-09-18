<template>
  <div class="navigation-action">
    <button class="nav-btn" @click="handleNavigate">
      <span class="nav-icon">{{ getModuleIcon }}</span>
      <span class="nav-text">{{ buttonText }}</span>
      <PhCaretRight class="nav-arrow" />
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * NavigationButton 组件
 * 用于在 AI 消息中渲染可交互的导航按钮，引导用户跳转到应用内的各个模块
 * 设计风格：Fluent Design 毛玻璃 + 精致微动效
 */
import { computed } from 'vue'
import { PhCaretRight } from '@phosphor-icons/vue'
import { useRouter } from 'vue-router'
import { buildNotebookDetailRoute } from '@renderer/views/Notebook/utils/notebookTabRoute'

/**
 * 导航目标配置接口
 */
interface NavigationTarget {
  module: 'aigc' | 'asset' | 'notebook'
  tab?: 'image' | 'video' | 'music' | '3d'
  prompt?: string
  folderKey?: string
  assetKey?: string
  notebookId?: string
}

/**
 * 组件属性
 */
interface Props {
  /** 导航按钮显示文案 */
  buttonText: string
  /** 导航描述文案 */
  description: string
  /** 导航目标配置 */
  target: NavigationTarget
}

const props = defineProps<Props>()
const router = useRouter()

/**
 * 根据模块获取图标
 */
const getModuleIcon = computed(() => {
  const { module, tab } = props.target
  if (module === 'aigc') {
    switch (tab) {
      case 'image':
        return '🎨'
      case 'video':
        return '🎬'
      case 'music':
        return '🎵'
      case '3d':
        return '🧊'
      default:
        return '✨'
    }
  } else if (module === 'asset') {
    return '📁'
  } else if (module === 'notebook') {
    return '📚'
  }
  return '🚀'
})

/**
 * 模块路由映射
 */
const MODULE_ROUTES: Record<string, string> = {
  aigc: '/aigc-studio',
  asset: '/asset-management',
  notebook: '/notebooks'
}

/**
 * 处理导航点击事件
 * 跳转到目标模块并传递相关参数
 */
function handleNavigate(): void {
  const { module, tab, prompt, folderKey, assetKey, notebookId } = props.target
  const basePath = MODULE_ROUTES[module]

  if (!basePath) {
    console.error('[NavigationButton] 未知模块:', module)
    return
  }

  // 构建查询参数
  const query: Record<string, string> = {}

  // 为每次导航生成唯一的 _tab_id，确保创建新的标签页实例
  // 这样不会影响已打开的同类型标签页
  query._tab_id = String(Date.now())

  if (module === 'aigc') {
    if (tab) query.tab = tab
    if (prompt) query.prompt = prompt
  } else if (module === 'asset') {
    if (folderKey) query.folderKey = folderKey
    if (assetKey) query.assetKey = assetKey
  } else if (module === 'notebook' && notebookId) {
    // 知识库需要跳转到详情页
    router.push(buildNotebookDetailRoute(notebookId))
    return
  }

  console.log('[NavigationButton] 导航到:', basePath, query)

  // 执行路由跳转
  router.push({
    path: basePath,
    query
  })
}
</script>

<style scoped lang="less">
.navigation-action {
  display: inline-flex;
  margin: 12px 0;
}

.nav-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  background: var(--color-bg-surface-hover);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border);
    transform: translateY(-1px);

    .nav-arrow {
      transform: translateX(3px);
      opacity: 1;
    }
  }

  &:active {
    transform: translateY(0);
    background: var(--color-bg-surface-hover);
  }
}

.nav-icon {
  font-size: 14px;
  line-height: 1;
}

.nav-text {
  white-space: nowrap;
}

.nav-arrow {
  font-size: 12px;
  opacity: 0.6;
  transition: all 0.2s ease;
  margin-left: 2px;
}
</style>
