# 给开发者

本站主体是[使用手册](/guide/)。开发规范与代码一起维护在仓库中，不在这里重复，这一节只提供索引。

## 仓库

<https://github.com/ueboxai/uebox>

Electron + Vue 3 + TypeScript，Apache-2.0。UnrealAgentLink 插件在 `plugin/UnrealAgentLink`，使用独立的 MIT 许可证。

产品是**虚幻引擎的 agent harness**：主体是 Agent（`src/main/agent-v3/`），项目库、资产库、蓝图库、材质库、笔记与知识库在结构上服务于它。决定一个功能归哪儿时按这个关系判断，分层见[架构与验收门禁](/develop/architecture#agent-的五层)。

## 运行

需要 [Node.js 24.21.0](https://nodejs.org/) 和 pnpm 10.28.2。

```bash
pnpm install
pnpm dev
```

首次 `pnpm install` 需要编译原生模块，耗时几分钟。

## 验收

门禁分两档，干活过程中不跑：

| 时机                 | 命令                  | 耗时        | 范围         |
| -------------------- | --------------------- | ----------- | ------------ |
| 功能做完、每次提交时 | `pnpm verify:changed` | 约 30 秒    | 只查改动部分 |
| 整批发出去之前       | `pnpm verify`         | 约 3.5 分钟 | 全仓完整门禁 |

完整门禁包括密钥扫描、lint、类型检查、单测、技能规范（`verify:skills`）、引擎文件编码检查等，步骤见[架构与验收门禁](/develop/architecture#门禁两档)。失败时会给出该改什么、该敲什么命令。门禁不碰原生模块，应用开着也能跑。

调单个测试文件：`pnpm exec vitest run <文件>`。

## 索引

| 目标                                         | 位置                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **规范**（架构分层、硬规则、门禁、提交约定） | [`AGENTS.md`](https://github.com/ueboxai/uebox/blob/main/AGENTS.md) / [`AGENTS.zh-CN.md`](https://github.com/ueboxai/uebox/blob/main/AGENTS.zh-CN.md)，唯一真相源 |
| 用 AI 加功能                                 | [用 AI 加功能](/develop/with-ai)                                                                                                                                  |
| 代码分层                                     | [架构与验收门禁](/develop/architecture)                                                                                                                           |
| 贡献流程                                     | 仓库的 `CONTRIBUTING.md` / `CONTRIBUTING.zh-CN.md`                                                                                                                |
| 测试、打包与发版                             | 仓库的 `docs/contributing/`（`testing.md`、`packaging.md`、`definition-of-done.md`）                                                                              |
| 术语定义                                     | 仓库的 `CONTEXT.md`，界面文案由 `terminologyGuard.test.ts` 检查                                                                                                   |
| 命令行 `uebox`                               | 仓库的 `packages/cli/README.md`，用法见[命令行](/guide/cli)                                                                                                       |
| 安全策略                                     | 仓库的 `SECURITY.md`                                                                                                                                              |
| UI 设计规范                                  | 仓库的 `docs/UI-Design-Standards.md`、`docs/ui-components.md`                                                                                                     |
| 各能力的设计稿                               | 仓库的 `docs/` 目录                                                                                                                                               |

::: warning 关于 `docs/`
`docs/` 是内部设计稿和评审档案，面向参与开发的人。其中部分文档描述的功能已经落地形态变更或已下线，不能作为功能说明使用。
:::
