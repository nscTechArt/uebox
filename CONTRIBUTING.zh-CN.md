# 参与共创

English: [CONTRIBUTING.md](CONTRIBUTING.md)

这个项目的立场很简单：

> **开发阶段随便试，验收阶段一寸不让。**

我们**明确欢迎** vibe coding —— 用 AI 把想法直接写成代码。不会写代码不是门槛，
不跑测试才是。仓库里已经放好了给 AI 看的规范和一条命令的验收门禁，
剩下的只是「说清楚你要什么」。

---

## 先选一条路

### 🙋 我是用户，我只是想要某个功能

两个选择：

- **自己动手**（推荐，最快）：照着
  [用 AI 给虚幻盒子加功能](docs/contributing/vibe-coding.zh-CN.md) 走，
  三步准备好环境，把需求模板发给你的 AI 助手。
- **提个需求**：开一个
  [Feature request](../../issues/new?template=feature_request.yml)，
  写清楚你想要什么、在哪用。写「我想要什么」就够了，不用想「怎么实现」。

顺便说：Issue 本身就是很好的 AI 输入。写完之后你可以把整个 Issue 复制给你的 AI 助手，
让它照着做。

### 👩‍💻 我会写代码

1. 读 [AGENTS.md](AGENTS.md) —— 架构分层、硬规则、门禁，都在里面；
2. 读 [垂直切片](docs/contributing/vertical-slice.md) —— 知道代码该写在哪一层；
3. 写代码，写测试；
4. `pnpm verify` 跑到全绿；
5. 对着 [验收清单](docs/contributing/definition-of-done.zh-CN.md) 自查；
6. 开 PR。

### 🤖 我是 AI Agent

读 [AGENTS.md](AGENTS.md)（或 [AGENTS.zh-CN.md](AGENTS.zh-CN.md)）。那是给你的唯一规范来源。
`push` 和开 PR 之前必须停下来问人。

---

## 快速开始

```bash
pnpm install
pnpm dev
```

改完代码：

```bash
pnpm verify
```

这一条命令跑完 CI 会跑的所有门禁，失败时会告诉你具体该改什么。
它还会自动把 `better-sqlite3` 切回 Electron ABI，所以你可以直接接着 `pnpm dev`。

无关 UI/文档改动不需要插件 ZIP 或 Unreal；改了插件打包输入，门禁需要指定目标版本
（没装 Unreal 时声明 `none`），详见[打包指南](docs/contributing/packaging.zh-CN.md#日常门禁)。

要出安装包、发版，或者被原生模块的 ABI 卡住，见
[打包、发布与原生模块](docs/contributing/packaging.zh-CN.md)。

### 推荐的编辑器配置

[VSCode](https://code.visualstudio.com/) +
[ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) +
[Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) +
[Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar)

---

## 我们看什么、不看什么

**会看：**

- `pnpm verify` 是不是真的全绿
- 功能是不是真的能用（不只是测试绿）
- 改动是不是只碰了该碰的地方
- 新代码有没有测试
- 用户可见文案有没有中英双语

**不看：**

- 你是不是"真正的程序员"
- 代码是不是 AI 写的（欢迎，PR 模板里勾一下就行，不减分）
- 你用的是哪个 AI 助手
- 你的第一版实现是不是最优雅的（能过门禁、能用，我们会一起改）

---

## 提交规范

Conventional Commits + 中文描述，和现有历史保持一致：

```
feat: 支持自定义标签颜色
fix: 修复打包产物无法启动的两个缺陷
feat!: 卸载工作流 Nexus          ← 破坏性变更用 !
docs: 补充垂直切片说明
chore: 升级 electron-builder
```

分支命名：`feat/<slug>`、`fix/<slug>`。

---

## 报 Bug

开一个 [Bug report](../../issues/new?template=bug_report.yml)，带上：

- 版本号（关于页面里能看到）
- 操作系统
- 复现步骤
- 报错截图或日志

---

## 安全问题

**不要**用公开 Issue 报安全漏洞。请通过 GitHub 的
[Security Advisory](../../security/advisories/new) 私下提交。

---

## 行为准则

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 许可

本项目使用 Apache License 2.0。提交贡献即表示你同意你的代码以同样的许可发布。
