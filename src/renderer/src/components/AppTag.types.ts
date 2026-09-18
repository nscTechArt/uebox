/**
 * 标签的语义档。
 *
 * 单独放一个 .ts 而不是从 [AppTag.vue] 里 `export` —— `<script setup>` 导不出类型，
 * 而调用点需要它给「算出标签档位」的辅助函数标返回值（不标的话返回 string，
 * 传进去就是类型错误）。
 */
export type TagTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'
