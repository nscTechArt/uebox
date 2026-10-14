# 参与共创

English: [CONTRIBUTING.md](CONTRIBUTING.md)

欢迎用 AI 写代码（vibe coding）。不会写代码不是门槛，不跑测试才是。
仓库里有给 AI 读的规范（[AGENTS.md](AGENTS.md)）和验收门禁（`pnpm verify`），
你只需要说清楚要什么。

---

## 先选一条路

### 我是用户，想要某个功能

两个选择：

- **自己动手**（最快）：照 [用 AI 给虚幻盒子加功能](docs/contributing/vibe-coding.zh-CN.md)
  准备环境，把需求模板发给你的 AI 助手。
- **提需求**：开一个 [Feature request](../../issues/new?template=feature_request.yml)，
  写你想要什么、在哪用，不用写怎么实现。

写好的 Issue 可以整段复制给 AI 助手，让它照着做。

### 我会写代码

1. 读 [AGENTS.md](AGENTS.md)：架构分层、硬规则、门禁；
2. 读 [垂直切片](docs/contributing/vertical-slice.md)：代码该写在哪一层；
3. 写代码，写测试；
4. 每次提交前跑 `pnpm verify:changed`，PR 之前跑一次 `pnpm verify`，全绿；
5. 对照 [验收清单](docs/contributing/definition-of-done.zh-CN.md) 自查；
6. 开 PR。

### 我是 AI Agent

读 [AGENTS.md](AGENTS.md)（中文版 [AGENTS.zh-CN.md](AGENTS.zh-CN.md)），那是唯一的规范来源。
`git push` 和开 PR 之前先问人。

---

## 快速开始

需要 Node.js 24.21.0 和 pnpm 10.28.2。

```bash
pnpm install
pnpm dev
```

### 门禁分两档

| 时机                          | 命令                  | 耗时        | 范围                         |
| ----------------------------- | --------------------- | ----------- | ---------------------------- |
| 干活过程中                    | 不跑                  | -           | 最多跑你正在写的那个测试文件 |
| 功能做完、每次提交时          | `pnpm verify:changed` | 约 30 秒    | 只查你改的                   |
| 整批发出去之前（push、开 PR） | `pnpm verify`         | 约 3.5 分钟 | CI 跑的那一套，全仓          |

调单个测试文件：`pnpm exec vitest run <文件>`。

`verify:changed` 不能代替 `pnpm verify`。跑门禁不需要关应用。
各步骤检查什么见 [架构与验收门禁](website/develop/architecture.md)。

改了插件打包输入（`plugin/UnrealAgentLink/` 下会进分发包的文件）时，门禁需要指定目标引擎版本，
没装 Unreal 时声明 `none`。详见 [打包指南](docs/contributing/packaging.zh-CN.md#日常门禁)。
UI 和文档改动不需要插件 ZIP，也不需要 Unreal。

出安装包、发版，或被 `better-sqlite3` 的 ABI 卡住，见
[打包、发布与原生模块](docs/contributing/packaging.zh-CN.md)。

### 界面文案和术语

- 用户能看到的文案同时加进 `zh-CN.ts` 和 `en-US.ts`。
- 用词以 [CONTEXT.md](CONTEXT.md) 为准。`src/renderer/src/i18n/terminologyGuard.test.ts`
  会扫两份语言包和主进程文案，命中禁用词（例如「会话」「聊天」「回合」）就失败，
  并告诉你该换成什么词。

### 推荐的编辑器配置

[VSCode](https://code.visualstudio.com/) +
[ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) +
[Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) +
[Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar)

---

## review 看什么

- `pnpm verify` 是否真的全绿
- 功能是否真的能用，不只是测试绿
- 改动是否只碰了该碰的文件
- 新代码是否有测试
- 用户可见文案是否有中英双语

不看：你是不是专业程序员；代码是不是 AI 写的（PR 模板里勾一下，不减分）；用了哪个 AI 助手；
第一版是否最优雅（能过门禁、能用，review 时一起改）。

---

## 提交规范

Conventional Commits，描述用中文，和现有历史一致：

```
feat: 支持自定义标签颜色
fix: 修复打包产物无法启动的两个缺陷
feat!: 卸载工作流 Nexus          ← 破坏性变更加 !
docs: 补充垂直切片说明
chore: 升级 electron-builder
```

分支名：`feat/<slug>`、`fix/<slug>`。

---

## 报 Bug

开一个 [Bug report](../../issues/new?template=bug_report.yml)，带上：

- 版本号（关于页面里有）
- 操作系统
- 复现步骤
- 报错截图或日志

---

## 安全问题

不要用公开 Issue 报安全漏洞。按 [SECURITY.md](SECURITY.md) 发邮件给维护者。

---

## 行为准则

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 许可

本项目使用 Apache License 2.0。提交贡献即表示你同意你的代码以同样的许可发布。
