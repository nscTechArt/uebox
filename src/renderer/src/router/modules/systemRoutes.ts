import { RouteRecordRaw } from 'vue-router'

// 系统相关路由（不需要布局）
const systemRoutes: RouteRecordRaw[] = [
  {
    path: '/404',
    name: 'NotFound',
    component: () => import('../../views/System/NotFound.vue'),
    meta: {
      // meta.title 是 i18n key，不是字面量（`router/index.ts` 拿它去 t()）
      title: 'systemNotFound.title',
      isShowInTab: false,
      showMenu: false,
      showTab: false,
      isShowInMenu: false
    }
  },
  // 通配符路由，匹配所有未定义的路径，重定向到404页面
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFoundRedirect',
    redirect: '/404'
  }
]

export default systemRoutes
