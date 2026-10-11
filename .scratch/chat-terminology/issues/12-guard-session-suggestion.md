# 12: 守卫 session 替换建议

Status: done
Blocked by: None (can start immediately)
组：第 4 组（05–08）

依据：`../spec.md`「术语守卫」中「英文 `session` / `sessions` 保持整词零容忍」一条与完整词表 08 的 session 行；
「工单 09–18 的测试」中「守卫自测加一条」。

**What to build:** 贡献者写了含 session 的英文文案时，守卫报错按意思告诉他该怎么写：对话写 chat，登录写 sign-in / signed out，
网络库导入写 import。

- [x] `session`、`sessions` 两个条目的替换建议改为 spec 词表里的写法；两个条目仍按整词匹配
- [x] 守卫顶部注释写明：确有改写不了的正当用法时，由提交者在 PR 里说明、维护者决定是否破例
- [x] 守卫自测加一条：对真实词表断言 `session`、`sessions` 的替换建议都同时含 `chat`、`sign-in`、`import`
- [x] 白名单仍是调试台三个 key：diff 不触及白名单
- [x] 术语守卫测试通过；提交信息标明「第 4 组」
