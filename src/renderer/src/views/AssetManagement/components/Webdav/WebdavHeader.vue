<template>
  <div class="webdav-header">
    <h2 class="title">{{ $t('webdavHeader.title') }}</h2>
    <p class="desc">{{ $t('webdavHeader.desc') }}</p>
  </div>
</template>

<style scoped lang="less">
.webdav-header {
  padding: 24px 16px 12px;

  .title {
    margin: 0 0 8px;
    font-size: 20px;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  .desc {
    margin: 0;
    font-size: 14px;
    color: var(--color-text-secondary);
  }
}
</style>
