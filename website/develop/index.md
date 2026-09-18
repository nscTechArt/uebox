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

```bash
pnpm verify
```

跑的是 CI 跑的那一整套门禁——不止 lint 和测试，还包括密钥扫描、技能规范、引擎文件编码检查等，完整步骤见下面的[架构与验收门禁](/develop/architecture#门禁两档)。失败时会给出具体该改什么、敲什么命令。门禁不涉及原生模块，应用开着也能跑。

开发过程中用 `pnpm verify:changed`，约 30 秒，只检查改动部分。

## 索引

| 目标                                         | 位置                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **规范**（架构分层、硬规则、门禁、提交约定） | [`AGENTS.md`](https://github.com/ueboxai/uebox/blob/main/AGENTS.md) / [`AGENTS.zh-CN.md`](https://github.com/ueboxai/uebox/blob/main/AGENTS.zh-CN.md)，唯一真相源 |
| 用 AI 加功能                                 | [用 AI 加功能](/develop/with-ai)                                                                                                                                  |
| 代码分层                                     | [架构与验收门禁](/develop/architecture)                                                                                                                           |
| 贡献流程                                     | 仓库的 `CONTRIBUTING.md`                                                                                                                                          |
| 术语定义                                     | 仓库的 `CONTEXT.md`                                                                                                                                               |
| UI 设计规范                                  | 仓库的 `docs/UI-Design-Standards.md`、`docs/ui-components.md`                                                                                                     |
| 各能力的设计稿                               | 仓库的 `docs/` 目录                                                                                                                                               |

::: warning 关于 `docs/`
`docs/` 是内部设计稿和评审档案，面向参与开发的人。其中部分文档描述的功能已经落地形态变更或已下线，不能作为功能说明使用。
:::
