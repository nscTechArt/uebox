import type { ComputedRef, InjectionKey } from 'vue'

/**
 * 菜单把「当前选中哪几项」往下传给子项用的 key。
 *
 * 单独放一个 .ts：`<script setup>` 导不出常量，而 AppMenu 和 AppMenuItem
 * 两边都要引用同一个 InjectionKey —— 各写各的字符串会静默失配。
 */
export const MENU_SELECTED_KEYS: InjectionKey<ComputedRef<string[]>> = Symbol('app-menu-selected')
