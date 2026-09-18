<script setup lang="ts">
import { MINI_CHAT_SETTINGS_ENABLED } from '../../../../../../shared/miniChatPreferences'
/**
 * 偏好设置侧边菜单组件
 * 原型风格：极简线条指示器 + 玻璃拟态 + 分组分割线
 */
import {
  PhBookOpenText,
  PhChartBar,
  PhChatCircle,
  PhDatabase,
  PhTerminalWindow,
  PhFileText,
  PhFlask,
  PhFolders,
  PhGear,
  PhGraduationCap,
  PhIdentificationCard,
  PhInfo,
  PhLightning,
  PhMicrophone,
  PhPalette,
  PhPlugs,
  PhRobot,
  PhSquaresFour,
  PhToolbox,
  PhVideoCamera
} from '@phosphor-icons/vue'

interface MenuItem {
  key: string
  labelKey: string
  icon: unknown
}

interface MenuGroup {
  items: MenuItem[]
}

interface Props {
  activeKey: string
}

const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'change', key: string): void }>()

/**
 * 菜单分组配置
 * 通过分割线实现视觉归类
 */
/**
 * Agent V3 调试台是给开发这个 agent 的人用的内部工具（逐步执行、看原始事件、
 * 手动 steer），不是给终端用户的功能。以前它无条件挂在偏好设置里，
 * 任何用户打开设置都能看到一个自己完全用不上的「调试台」。
 *
 * 开发环境照常显示；正式包里要用就设 UEBOX_SHOW_AGENT_DEBUG=true。
 */
const showAgentDebugPanel =
  import.meta.env.DEV || String(import.meta.env.VITE_SHOW_AGENT_DEBUG || '') === 'true'

const menuGroups: MenuGroup[] = [
  // 基础设置组
  {
    items: [
      {
        key: 'general',
        labelKey: 'profile.menu.general',
        icon: PhGear
      },
      {
        key: 'appearance',
        labelKey: 'profile.menu.appearance',
        // 调色板：这一页管的是「看起来是什么样」。语言也在这页，但主导的是外观
        icon: PhPalette
      },
      {
        key: 'shortcuts',
        labelKey: 'profile.menu.shortcuts',
        icon: PhLightning
      },
      ...(MINI_CHAT_SETTINGS_ENABLED
        ? [
            {
              key: 'miniChat',
              labelKey: 'profile.menu.miniChat',
              icon: PhChatCircle
            }
          ]
        : [])
    ]
  },
  // AI 相关组
  {
    items: [
      {
        key: 'ai',
        labelKey: 'profile.menu.ai',
        icon: PhRobot
      },
      {
        key: 'models',
        labelKey: 'profile.menu.models',
        icon: PhPlugs
      },
      {
        key: 'skills',
        labelKey: 'profile.menu.skills',
        // 「学位帽」—— 这一页是「它会做哪些事」，以及它自己学会的那些。
        // 不用拼图块：那个比喻属于「往应用上加装的东西」，而技能不是加装件，
        // 是这个助手本身的能力清单（隔壁「知识库」用翻开的书，两者不混）
        icon: PhGraduationCap
      },
      {
        key: 'tools',
        labelKey: 'profile.menu.tools',
        // 「工具箱」—— 这一页是它手上有哪些家伙事，以及怎么递到它面前。
        // 不用扳手：那个比喻指的是「调整设置」，而整个偏好设置都在调整设置
        icon: PhToolbox
      },
      {
        key: 'personalization',
        labelKey: 'profile.menu.personalization',
        // 「一张写着这个人是谁的卡片」—— 这一页正是这个东西：我明说的那段说明，
        // 加上它自己记下来的那些。不用大脑图标：那只覆盖了「记忆」那一半
        icon: PhIdentificationCard
      },
      {
        key: 'voice',
        labelKey: 'profile.menu.voice',
        icon: PhMicrophone
      },
      {
        key: 'mcp',
        labelKey: 'profile.menu.mcp',
        icon: PhPlugs
      },
      {
        key: 'cli',
        labelKey: 'profile.menu.cli',
        icon: PhTerminalWindow
      },
      {
        key: 'usage',
        labelKey: 'profile.menu.usage',
        // 用量是「花了多少」，不是「跑得快不快」—— 用图表而不是仪表盘
        icon: PhChartBar
      },
      ...(showAgentDebugPanel
        ? [
            {
              key: 'agentV3Debug',
              labelKey: 'profile.menu.agentV3Debug',
              icon: PhFlask
            }
          ]
        : [])
    ]
  },
  // 工程与资产组
  {
    items: [
      {
        key: 'project',
        labelKey: 'profile.menu.project',
        icon: PhFolders
      },
      {
        key: 'asset',
        labelKey: 'profile.menu.asset',
        icon: PhDatabase
      },
      {
        key: 'notebook',
        labelKey: 'profile.menu.notebook',
        icon: PhBookOpenText
      },
      {
        key: 'plugin',
        labelKey: 'profile.menu.plugin',
        icon: PhSquaresFour
      },
      {
        key: 'screenRecorder',
        labelKey: 'profile.menu.screenRecorder',
        icon: PhVideoCamera
      },
      {
        key: 'namingRules',
        labelKey: 'profile.menu.namingRules',
        icon: PhFileText
      },
      {
        key: 'about',
        labelKey: 'profile.menu.about',
        icon: PhInfo
      }
    ]
  }
]

/**
 * 处理菜单点击
 * @param key 菜单项 Key
 */
function handleMenuClick(key: string): void {
  emit('change', key)
}
</script>

<template>
  <aside class="preferences-sidebar">
    <!-- 标题区域 -->
    <div class="sidebar-header">
      <h1 class="sidebar-title">{{ $t('common.preferences') }}</h1>
    </div>

    <!-- 导航菜单 -->
    <nav class="sidebar-nav">
      <template v-for="(group, groupIndex) in menuGroups" :key="groupIndex">
        <!-- 分割线（除第一组外） -->
        <div v-if="groupIndex > 0" class="nav-divider" />

        <!-- 菜单项 -->
        <button
          v-for="item in group.items"
          :key="item.key"
          class="nav-item"
          :class="{ active: props.activeKey === item.key }"
          @click="handleMenuClick(item.key)"
        >
          <component :is="item.icon" class="nav-icon" />
          <span class="nav-label">{{ $t(item.labelKey) }}</span>
        </button>
      </template>
    </nav>
  </aside>
</template>

<style scoped lang="less">
.preferences-sidebar {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: var(--space-4) 0;
  height: 100%;
}

.sidebar-header {
  display: flex;
  align-items: center;
  margin-bottom: var(--space-10);
  padding: 0 var(--space-4);
}

.sidebar-title {
  margin: 0;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 分割线 - 用于视觉分组 */
.nav-divider {
  height: 1px;
  margin: var(--space-2) var(--space-4);
  background: linear-gradient(to right, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.03));
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: left;
  color: var(--color-text-muted);

  /* 左侧指示条 */
  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%) scaleY(0);
    width: 3px;
    height: 16px;
    background-color: var(--color-accent-solid);
    border-radius: 0 2px 2px 0;
    transition: transform 0.2s ease;
  }

  &:hover {
    color: var(--color-text-secondary);
  }

  &.active {
    color: var(--color-text-primary);
    background: linear-gradient(to right, rgba(255, 255, 255, 0.03), transparent);

    &::before {
      transform: translateY(-50%) scaleY(1);
    }

    .nav-icon,
    .nav-label {
      color: var(--color-text-primary);
    }
  }
}

.nav-icon {
  font-size: 16px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.nav-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-normal);
  letter-spacing: 0.02em;
}
</style>
