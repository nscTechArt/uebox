# 用 AI 加功能

仓库中放了面向 AI 的规范（`AGENTS.md`）和一条命令的验收门禁（`pnpm verify`）。AI 编码助手可以读取规范、修改代码、运行测试。

## 准备

- [Node.js 24.21.0](https://nodejs.org/)
- pnpm 10.28.2（`npm i -g pnpm@10.28.2`）
- Git
- 一个 AI 编码助手：Claude Code、Codex、Cursor、Copilot 等

使用 Codex 时，直接用它打开并信任本仓库：根目录 `AGENTS.md`、`.codex/` 安全配置和 `.agents/skills/` 项目工作流会自动生效。

克隆仓库后：

```bash
pnpm install
pnpm dev
```

## 需求模板

描述预期效果，实现方式交给 AI 判断。

```text
我要给虚幻盒子加一个功能：[一句话说清楚你想要什么]。

具体想要的效果是：
- [用户在哪里能看到 / 点到它]
- [点了之后会发生什么]
- [有什么边界情况你希望它怎么处理]

请你：
1. 先读仓库根目录的 AGENTS.md，按里面的规范做；
2. 动手前先把相关代码读一遍，告诉我你打算改哪些文件、为什么；
3. 实现完记得补上测试；
4. 功能做完先跑 `pnpm verify:changed`；把提交信息给我之前，
   再跑一次完整的 `pnpm verify`，一直修到全绿；
5. 全绿之后给我一个符合规范的提交信息，但先别 push，等我确认。
```

## 完整指南

带示例和验收清单的版本在仓库中：

- [`docs/contributing/vibe-coding.zh-CN.md`](https://github.com/ueboxai/uebox/blob/main/docs/contributing/vibe-coding.zh-CN.md)
- English: [`docs/contributing/vibe-coding.md`](https://github.com/ueboxai/uebox/blob/main/docs/contributing/vibe-coding.md)

只想提需求：[开一个 Issue](https://github.com/ueboxai/uebox/issues/new)。
