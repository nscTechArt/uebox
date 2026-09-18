# ContextMenu 组件使用规范

## 概述

ContextMenu 是一个全局管理的右键上下文菜单组件，基于 Ant Design Vue 的 Dropdown 组件封装，支持全局唯一显示、自定义样式和丰富的菜单项配置。

## 核心特性

- ✅ **全局唯一显示**：确保同时只有一个上下文菜单显示
- ✅ **自动位置管理**：根据鼠标位置智能定位菜单
- ✅ **丰富的菜单项类型**：支持普通项、分割线、危险项等
- ✅ **自定义样式**：支持主题色、背景色、文字色等自定义
- ✅ **快捷键显示**：支持显示菜单项快捷键
- ✅ **TypeScript 支持**：完整的类型定义

## 基本用法

### 1. 导入组件

```vue
<script setup lang="ts">
import ContextMenu from '@renderer/components/ContextMenu/ContextMenu.vue'
import type { MenuItem } from '@renderer/components/ContextMenu/ContextMenu.vue'
</script>
```

### 2. 模板使用

```vue
<template>
  <div @contextmenu="handleRightClick">
    <!-- 你的内容 -->
    <div>右键点击这里显示菜单</div>

    <!-- ContextMenu 组件 -->
    <ContextMenu
      ref="contextMenuRef"
      :menu-items="menuItems"
      @click="handleMenuClick"
      @visible-change="handleVisibleChange"
    />
  </div>
</template>
```

### 3. 脚本配置

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { CopyOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons-vue'

const contextMenuRef = ref()

// 菜单项配置
const menuItems: MenuItem[] = [
  {
    key: 'copy',
    label: '复制',
    icon: CopyOutlined,
    shortcut: 'Ctrl+C'
  },
  {
    key: 'edit',
    label: '编辑',
    icon: EditOutlined,
    shortcut: 'F2'
  },
  {
    type: 'divider' // 分割线
  },
  {
    key: 'delete',
    label: '删除',
    icon: DeleteOutlined,
    shortcut: 'Delete',
    danger: true // 危险操作样式
  }
]

// 右键事件处理
const handleRightClick = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()

  // 显示菜单
  contextMenuRef.value?.show(event.clientX, event.clientY)
}

// 菜单点击处理
const handleMenuClick = (key: string, item: MenuItem) => {
  console.log('菜单点击:', key, item)

  switch (key) {
    case 'copy':
      // 处理复制逻辑
      break
    case 'edit':
      // 处理编辑逻辑
      break
    case 'delete':
      // 处理删除逻辑
      break
  }
}

// 菜单显示状态变化
const handleVisibleChange = (visible: boolean) => {
  console.log('菜单显示状态:', visible)
}
</script>
```

## API 参考

### Props

| 属性名                 | 类型         | 默认值                          | 说明           |
| ---------------------- | ------------ | ------------------------------- | -------------- |
| `menuItems`            | `MenuItem[]` | `[]`                            | 菜单项配置数组 |
| `backgroundColor`      | `string`     | `'var(--color-surface-s0)'`     | 菜单背景色     |
| `textColor`            | `string`     | `'var(--color-text-primary)'`   | 菜单文字色     |
| `borderColor`          | `string`     | `'var(--color-border-primary)'` | 菜单边框色     |
| `hoverBackgroundColor` | `string`     | `'var(--color-brand-bg-hover)'` | 悬停背景色     |
| `hoverTextColor`       | `string`     | `'var(--color-brand-600)'`      | 悬停文字色     |

### MenuItem 接口

```typescript
interface MenuItem {
  key: string // 菜单项唯一标识
  label: string // 显示文本
  icon?: any // 图标组件
  shortcut?: string // 快捷键文本
  disabled?: boolean // 是否禁用
  danger?: boolean // 是否为危险操作
  className?: string // 自定义CSS类名
  backgroundColor?: string // 自定义背景色
  textColor?: string // 自定义文字色
  type?: 'item' | 'divider' // 类型：普通项或分割线
}
```

### Events

| 事件名           | 参数                            | 说明                 |
| ---------------- | ------------------------------- | -------------------- |
| `click`          | `(key: string, item: MenuItem)` | 菜单项点击事件       |
| `visible-change` | `(visible: boolean)`            | 菜单显示状态变化事件 |

### Methods

| 方法名 | 参数                     | 返回值 | 说明               |
| ------ | ------------------------ | ------ | ------------------ |
| `show` | `(x: number, y: number)` | `void` | 在指定位置显示菜单 |
| `hide` | -                        | `void` | 隐藏菜单           |

### Exposed Properties

| 属性名    | 类型                     | 说明         |
| --------- | ------------------------ | ------------ |
| `visible` | `Readonly<Ref<boolean>>` | 菜单显示状态 |
| `menuId`  | `Readonly<Ref<string>>`  | 菜单唯一ID   |

## 高级用法

### 1. 动态菜单项

```vue
<script setup lang="ts">
const currentFile = ref<FileInfo | null>(null)

// 根据选中文件动态生成菜单项
const menuItems = computed(() => {
  const items: MenuItem[] = [
    {
      key: 'open',
      label: '打开',
      icon: FolderOpenOutlined
    }
  ]

  if (currentFile.value?.type === 'image') {
    items.push({
      key: 'preview',
      label: '预览',
      icon: EyeOutlined
    })
  }

  if (currentFile.value?.canEdit) {
    items.push({
      key: 'edit',
      label: '编辑',
      icon: EditOutlined
    })
  }

  items.push(
    { type: 'divider' },
    {
      key: 'delete',
      label: '删除',
      icon: DeleteOutlined,
      danger: true
    }
  )

  return items
})

const handleRightClick = (event: MouseEvent, file: FileInfo) => {
  currentFile.value = file
  contextMenuRef.value?.show(event.clientX, event.clientY)
}
</script>
```

### 2. 自定义样式主题

```vue
<template>
  <ContextMenu
    ref="contextMenuRef"
    :menu-items="menuItems"
    background-color="#2d3748"
    text-color="#e2e8f0"
    border-color="#4a5568"
    hover-background-color="#4a5568"
    hover-text-color="#ffffff"
    @click="handleMenuClick"
  />
</template>
```

### 3. 条件禁用菜单项

```vue
<script setup lang="ts">
const selectedItems = ref<string[]>([])

const menuItems = computed(() => [
  {
    key: 'copy',
    label: '复制',
    icon: CopyOutlined,
    disabled: selectedItems.value.length === 0
  },
  {
    key: 'paste',
    label: '粘贴',
    icon: PasteOutlined,
    disabled: !hasClipboardContent.value
  },
  {
    key: 'delete',
    label: '删除',
    icon: DeleteOutlined,
    disabled: selectedItems.value.length === 0,
    danger: true
  }
])
</script>
```

## 全局管理机制

ContextMenu 组件使用全局管理器确保同时只有一个菜单显示：

### 工作原理

1. **单例管理器**：`useContextMenuManager` Hook 使用单例模式管理所有菜单实例
2. **自动注册**：组件挂载时自动注册到全局管理器
3. **互斥显示**：显示新菜单时自动隐藏其他所有菜单
4. **自动清理**：组件卸载时自动从管理器注销

### 调试支持

```vue
<script setup lang="ts">
const contextMenuRef = ref()

// 获取菜单ID用于调试
const getMenuId = () => {
  return contextMenuRef.value?.menuId
}

// 检查是否有活跃菜单
const checkActiveMenus = () => {
  const { hasActiveMenu, getActiveMenuCount } = useContextMenuManager()
  console.log('有活跃菜单:', hasActiveMenu())
  console.log('活跃菜单数量:', getActiveMenuCount())
}
</script>
```

## 最佳实践

### 1. 事件处理

```vue
<script setup lang="ts">
// ✅ 推荐：阻止默认行为和事件冒泡
const handleRightClick = (event: MouseEvent) => {
  event.preventDefault()
  event.stopPropagation()
  contextMenuRef.value?.show(event.clientX, event.clientY)
}

// ❌ 不推荐：不处理事件冒泡可能导致意外行为
const handleRightClickBad = (event: MouseEvent) => {
  contextMenuRef.value?.show(event.clientX, event.clientY)
}
</script>
```

### 2. 菜单项组织

```vue
<script setup lang="ts">
// ✅ 推荐：使用分割线分组相关功能
const menuItems: MenuItem[] = [
  // 编辑操作组
  { key: 'cut', label: '剪切', shortcut: 'Ctrl+X' },
  { key: 'copy', label: '复制', shortcut: 'Ctrl+C' },
  { key: 'paste', label: '粘贴', shortcut: 'Ctrl+V' },

  { type: 'divider' },

  // 文件操作组
  { key: 'rename', label: '重命名', shortcut: 'F2' },
  { key: 'properties', label: '属性' },

  { type: 'divider' },

  // 危险操作组
  { key: 'delete', label: '删除', shortcut: 'Delete', danger: true }
]
</script>
```

### 3. 性能优化

```vue
<script setup lang="ts">
// ✅ 推荐：使用 computed 动态生成菜单项
const menuItems = computed(() => {
  // 根据状态动态生成
  return generateMenuItems(currentState.value)
})

// ✅ 推荐：缓存图标组件
const icons = {
  copy: CopyOutlined,
  edit: EditOutlined,
  delete: DeleteOutlined
} as const
</script>
```

## 注意事项

1. **全局唯一性**：无需手动管理多个菜单的显示状态，组件会自动处理
2. **内存管理**：组件会自动注册和注销，无需担心内存泄漏
3. **事件处理**：务必在右键事件中调用 `preventDefault()` 阻止浏览器默认菜单
4. **位置计算**：使用 `event.clientX` 和 `event.clientY` 获取准确的鼠标位置
5. **样式覆盖**：自定义样式时注意 CSS 变量的使用，保持主题一致性

## 故障排除

### 菜单不显示

- 检查是否正确调用了 `show` 方法
- 确认菜单项数组不为空
- 检查是否有 CSS 样式冲突

### 菜单位置不正确

- 确保使用 `event.clientX` 和 `event.clientY`
- 检查是否有滚动容器影响位置计算

### 多个菜单同时显示

- 这种情况不应该发生，如果出现请检查组件版本
- 确认使用的是最新版本的 ContextMenu 组件

### 菜单点击无响应

- 检查 `@click` 事件是否正确绑定
- 确认菜单项的 `key` 属性是否唯一且正确设置
