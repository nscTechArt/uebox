# 消息管理工具使用文档

## 功能说明

全局消息管理工具 `messageManager.ts` 实现了以下功能：

1. **消息去重**：相同内容的消息只显示一个
2. **计数器显示**：重复的消息会在原内容后添加计数器，如 "操作成功 (3)"
3. **自动更新**：新的重复消息会替换旧的消息并更新计数
4. **完全兼容**：API 与 Ant Design Vue 的 message 完全兼容

## 使用方法

### 基本用法

```typescript
// 旧的导入方式
import { message } from 'ant-design-vue'

// 新的导入方式（只需要修改导入路径）
import { message } from '@/utils/messageManager'

// 使用方式完全相同
message.success('操作成功')
message.error('操作失败')
message.warning('文件已过期')
message.info('提示信息')
```

### 带持续时间

```typescript
// 显示 5 秒
message.success('操作成功', 5)
```

### 效果演示

```typescript
// 第一次调用
message.success('操作成功') // 显示: "操作成功"

// 第二次调用相同内容
message.success('操作成功') // 显示: "操作成功 (2)"

// 第三次调用相同内容
message.success('操作成功') // 显示: "操作成功 (3)"

// 不同内容会显示为新消息
message.success('其他操作完成') // 显示: "其他操作完成"
```

## 迁移指南

只需要修改每个文件中的 import 语句：

```diff
- import { message } from 'ant-design-vue'
+ import { message } from '@/utils/messageManager'
```

其他代码无需修改，完全向后兼容。

## 技术实现

- 使用 Map 存储当前显示的消息记录
- 基于 `type:content` 生成唯一 key 进行去重
- 使用定时器自动清理过期的消息记录
- 调用原生 Ant Design Vue 的 message API 进行实际展示
