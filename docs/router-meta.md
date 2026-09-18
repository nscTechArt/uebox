# 路由Meta参数文档

本文档记录了项目中路由meta参数的作用和使用说明。

## 参数列表

### title

- **类型**: `string`
- **作用**: 路由页面的标题，用于显示在标签页和菜单中
- **示例**: `title: '首页'`

### isShowInTab

- **类型**: `boolean`
- **作用**: 控制路由是否显示在标签页中
- **默认值**: `true`
- **示例**: `isShowInTab: false`

### fixed

- **类型**: `boolean`
- **作用**: 标签页是否固定，固定的标签页不能被关闭
- **默认值**: `false`
- **示例**: `fixed: true`

### sort

- **类型**: `number`
- **作用**: 标签页和菜单的排序权重，数值越小越靠前
- **示例**: `sort: 0`

### isCanDelete

- **类型**: `boolean`
- **作用**: 标签页是否可以被删除/关闭
- **默认值**: `true`
- **示例**: `isCanDelete: false`

### showMenu

- **类型**: `boolean`
- **作用**: 控制路由是否在MainLayout中显示菜单
- **默认值**: `true`
- **示例**: `showMenu: false`

### showTab

- **类型**: `boolean`
- **作用**: 控制路由是否在MainLayout中显示标签页
- **默认值**: `true`
- **示例**: `showTab: false`

### isShowInMenu

- **类型**: `boolean`
- **作用**: 控制路由是否显示在侧边栏菜单中
- **默认值**: `true`
- **示例**: `isShowInMenu: false`

### showTopInfo

- **类型**: `boolean`
- **作用**: 控制路由是否显示顶部信息区域（TopInfoArea组件）
- **默认值**: `true`
- **示例**: `showTopInfo: false`

## 使用示例

### 普通页面

```typescript
{
  path: '/test1',
  name: 'TestPage1',
  component: () => import('../../views/TestPage1.vue'),
  meta: {
    title: '测试页面1',
    isShowInTab: true,
    fixed: false,
    sort: 1,
    isCanDelete: true,
    showMenu: true,
    showTab: true,
    isShowInMenu: true,
    showTopInfo: true
  }
}
```

### 固定标签页

```typescript
{
  path: '/always-open',
  name: 'AlwaysOpen',
  component: () => import('../../views/AlwaysOpen.vue'),
  meta: {
    title: '常驻页面',
    isShowInTab: true,
    fixed: true,
    sort: 0,
    isCanDelete: false,
    showMenu: true,
    showTab: true,
    isShowInMenu: true,
    showTopInfo: true
  }
}
```

> 项目库（路由 `/`）**不是**固定标签页 —— 它能关、能拖、能取消固定。
> 「一个标签都没有时落到项目库」是 `store/modules/tabs.ts` 里 `DEFAULT_TAB_KEY`
> 那条兜底做的，不靠 `fixed`。

### 独立窗口（隐藏菜单和标签页）

Spotlight、Mini Chat、录屏选区这类窗口不是主窗口的一部分，`standalone: true`
让全局守卫直接放行，不设标题、不进标签、不参与启动落点。

```typescript
{
  path: '/spotlight',
  name: 'SpotlightWindow',
  component: () => import('@renderer/views/SpotlightWindow.vue'),
  meta: {
    title: 'Spotlight',
    standalone: true,
    showMenu: false,
    showTab: false,
    isShowInMenu: false,
    isShowInTab: false,
    showTopInfo: false
  }
}
```

> 这里**没有登录页，也没有认证门**。社区版装完就能用全部本地功能，路由层不认账号
> —— 曾经每条路由都写着的 `requiresAuth` 从来没有守卫读过，已经连同字段一起删掉。

## 注意事项

1. 所有meta参数都是可选的，未设置时会使用默认值
2. `fixed: true` 的标签页通常应该设置 `isCanDelete: false`
3. `showMenu` 和 `showTab` 控制MainLayout中的显示行为
4. `isShowInMenu` 和 `isShowInTab` 控制具体组件中的显示行为
5. `sort` 参数用于控制显示顺序，建议使用连续的数字
