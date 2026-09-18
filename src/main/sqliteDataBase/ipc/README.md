# 数据库IPC模块化结构

这个目录包含了数据库相关的IPC处理函数，采用模块化的结构组织，便于维护和扩展。

## 目录结构

```
ipc/
├── index.ts       # 主入口文件，统一注册所有模块的IPC处理函数
├── user.ts        # 用户模块的IPC处理函数
├── product.ts     # 产品模块的IPC处理函数（示例）
└── README.md      # 说明文档
```

## 如何添加新模块

1. 在`ipc/`目录下创建新的模块文件，例如`order.ts`

```typescript
import { ipcMain } from 'electron'
import { getDatabase } from '../index'
import { transaction } from '../utils'

// 导入模型相关的函数和类型
// import { ... } from '../models/order';

/**
 * 注册订单相关的IPC处理函数
 */
export const registerOrderIPC = (): void => {
  // 实现订单相关的IPC处理函数
  ipcMain.handle('db:orders:getAll', async () => {
    try {
      // 实现获取所有订单的逻辑
      return { success: true, data: [] }
    } catch (error) {
      console.error('获取所有订单失败:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 添加其他订单相关的IPC处理函数
}
```

2. 在`index.ts`中导入并注册新模块

```typescript
import { registerUserIPC } from './user'
import { registerProductIPC } from './product'
import { registerOrderIPC } from './order' // 导入新模块

export const registerDatabaseIPC = (): void => {
  registerUserIPC()
  registerProductIPC()
  registerOrderIPC() // 注册新模块
}

// 导出所有模块
export * from './user'
export * from './product'
export * from './order' // 导出新模块
```

## 命名规范

- IPC事件名称使用`db:{模块名}:{操作}`的格式，例如`db:users:getAll`
- 模块文件名使用单数形式，例如`user.ts`而不是`users.ts`
- 注册函数名称使用`register{模块名}IPC`的格式，例如`registerUserIPC`

## 错误处理

所有IPC处理函数都应该包含try-catch块，并返回统一的响应格式：

```typescript
// 成功响应
{ success: true, data: ... }

// 错误响应
{ success: false, error: (error as Error).message }
```

## 事务处理

对于需要保证数据一致性的操作，应使用事务：

```typescript
import { transaction } from '../utils'

// 在IPC处理函数中
const result = transaction(db, (dbInstance) => {
  // 执行需要事务保证的操作
  return someOperation(dbInstance, data)
})
```
