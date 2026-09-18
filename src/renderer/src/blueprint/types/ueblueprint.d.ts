declare module 'ueblueprint' {
  export class Blueprint {
    // 根据实际API添加方法定义
  }
}

// 扩展全局HTML元素类型
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ueb-blueprint': unknown
    }
  }
}
