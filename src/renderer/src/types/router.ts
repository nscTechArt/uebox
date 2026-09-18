import 'vue-router'

// 扩展路由meta类型
declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    isShowInTab?: boolean
    fixed?: boolean
    sort?: number
    isCanDelete?: boolean
    showMenu?: boolean
    showTab?: boolean
    isShowInMenu?: boolean
    showTopInfo?: boolean
    standalone?: boolean
  }
}
