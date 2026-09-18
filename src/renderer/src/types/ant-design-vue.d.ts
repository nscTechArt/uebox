/**
 * ant-design-vue 类型定义修复
 * 解决 GlobalComponents 缺少索引签名导致的 TS2344 错误
 */
import '@vue/runtime-core'

declare module '@vue/runtime-core' {
  interface GlobalComponents {
    // 添加索引签名以满足 Record<string, Component> 约束
    [key: string]: unknown
  }
}

export {}
