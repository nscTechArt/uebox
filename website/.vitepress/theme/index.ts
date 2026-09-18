import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { h } from 'vue'

import HomeEyebrow from './components/HomeEyebrow.vue'
import './style.css'

/**
 * 默认主题 + 一层配色和排版覆盖，见 ./style.css。
 *
 * 不自己写主题：默认主题的侧边栏、搜索框、移动端折叠都是现成且经过打磨的，
 * 自己重做一遍只会得到一个更差的版本。这里只改「看起来像不像虚幻盒子」那一层。
 *
 * ## 首页只插一块
 *
 * 大标题上面一行规格（这是什么、管哪几个版本），走默认主题的
 * `home-hero-info-before` 插槽，不改它的结构。
 *
 * 曾经还有一条数字带（工具数、技能数、许可证）和两张真截图，2026-09-18 撤掉了 ——
 * 首页要留白，一屏说清楚一件事就够，细节归手册。别再往首页加块。
 *
 * 插槽名是默认主题的公开约定，升级 VitePress 大版本时要回来核一遍。
 */
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'home-hero-info-before': () => h(HomeEyebrow)
    })
} satisfies Theme
