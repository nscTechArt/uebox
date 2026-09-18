<template>
  <!--
    分隔线。接替 ant-design-vue 的 `<a-menu-divider>`（11 处）。

    role="separator" 而不是只画一条线：读屏软件靠它知道菜单分了组，
    否则一串菜单项念下来是平的，用户听不出「下面这几个是另一类」。
  -->
  <li class="app-menu-divider" role="separator" />
</template>

<style scoped>
.app-menu-divider {
  height: 1px;
  margin: var(--space-1) 0;
  background: var(--color-border-subtle);
}
</style>
