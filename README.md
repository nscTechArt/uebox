<p align="center">
  <img src="build/icon.png" width="96" alt="虚幻盒子">
</p>

<h1 align="center">虚幻盒子 · UE Box</h1>

<p align="center">
  <b>直接操作虚幻编辑器的开源 AI Agent</b>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Unreal Engine" src="https://img.shields.io/badge/Unreal%20Engine-5.0%20~%205.8-0e1128">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%2F%20Linux%20from%20source-6b7280">
  <img alt="Built with" src="https://img.shields.io/badge/Electron%20%2B%20Vue%203%20%2B%20TypeScript-42b883">
</p>

<p align="center">
  <a href="https://uebox.ai">官网</a> ·
  <a href="https://github.com/ueboxai/uebox/releases">下载</a> ·
  <a href="https://uebox.ai/guide/">使用手册</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="README.en.md">English</a>
</p>

<!-- TODO: GIF 录好后替换下面这张静态图（给目标 → Agent 摆 Actor → 引擎里真的变了，10 秒以内），放在 website/public/shots/ 下 -->

![一轮真实对话：提问、工具调用、开始作答](website/public/shots/ai-conversation.png)

---

## 功能

- **100+ 引擎工具**：关卡、蓝图（含动画蓝图）、材质（含 Substrate）、C++、资产、数据表、UMG、Sequencer、几何体、地形、PCG
- **编译与运行验证**：蓝图 / C++ 编译报错自动修；PIE 运行取日志和截图；试玩机器人自动按键测试（实验性）
- **改动可核对**：工具调用全程可见；每轮列出新建 / 修改 / 删除；一键回引擎重读比对
- **目标模式** `/goal`：按需求清单逐条验收，未通过继续改
- **团队模式** `/team`：多个队员分工，每人可用不同模型
- **27 个内置技能** + 按工程积累的报错经验
- **80+ 模型服务商**：Claude、GPT、DeepSeek、Ollama、LM Studio 等；支持 ChatGPT Plus / Kimi 会员登录
- **审批**：风险操作需确认，可设「以后均允许」
- **MCP / CLI**：给 Codex、Claude Code、Cursor 和脚本用
- **素材管理**：项目库、资产库、蓝图库、材质库、3D 查看器、知识库，不连引擎也能用

完整能力与限制：[能力与边界](https://uebox.ai/guide/capabilities)

|                                                                |                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| ![工具调用](website/public/shots/ai-tool-call.png)<br>工具调用 | ![本轮改动](website/public/shots/engine-changes.png)<br>本轮改动 |
| ![审查](website/public/shots/engine-review.png)<br>审查        | ![项目库](website/public/shots/home-projects.png)<br>项目库      |

## 快速开始

1. 从 [Releases](https://github.com/ueboxai/uebox/releases) 下载安装（Windows）
2. **设置 → 模型 → 添加服务商**，填 API 密钥；**默认模型 → 对话** 选它（模型需支持工具调用）
3. **项目库 → 导入项目**，选 `.uproject`，在弹出的询问里点 **安装** UnrealAgentLink 插件，再点 **打开项目**
4. **侧边栏 → AI 对话**，输入「这个关卡里有多少个光源？」验证连接

文档：[第一次打开](https://uebox.ai/guide/first-run) · [配置模型](https://uebox.ai/guide/ai-setup) · [连接虚幻引擎](https://uebox.ai/guide/plugin) · [常见问题](https://uebox.ai/guide/troubleshooting)

## 接入外部 Agent

| 方式 | 用途                                       | 默认 | 文档                                 |
| ---- | ------------------------------------------ | ---- | ------------------------------------ |
| MCP  | Codex / Claude Code / Cursor 调引擎工具    | 可写 | [MCP](https://uebox.ai/guide/mcp)    |
| CLI  | 脚本、CI：`uebox tools call` / `uebox ask` | 只读 | [命令行](https://uebox.ai/guide/cli) |

仅本机可连，需令牌。

## 隐私

- 无账号，无官方服务器；密钥加密存本机，请求直连你配的服务商
- 默认只检查更新；未配置更新源的自行构建不发任何请求（[updateFeed.ts](src/main/services/updater/updateFeed.ts)）
- 用本机模型时 AI 请求不出本机

## 平台

|         | 安装包   | 引擎发现           | 预编译插件 |
| ------- | -------- | ------------------ | ---------- |
| Windows | ✅       | ✅                 | ✅         |
| macOS   | 源码构建 | ✅ 常见目录 + 手动 | 未完成验收 |
| Linux   | 源码构建 | 未适配             | —          |

UE 5.0–5.8。Windows 为主力平台。插件源码：[`plugin/UnrealAgentLink`](plugin/UnrealAgentLink)（[MIT](plugin/UnrealAgentLink/LICENSE)）。

## 开发

```bash
pnpm install
pnpm dev
pnpm verify:changed   # 提交前，只查改动（约 30 秒）
pnpm verify           # push / PR 前，完整门禁
```

- 用 AI 编码助手开发：先读 [AGENTS.md](AGENTS.md)，指南见 [用 AI 加功能](docs/contributing/vibe-coding.zh-CN.md)
- 贡献：[CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) · [垂直切片](docs/contributing/vertical-slice.md) · [测试](docs/contributing/testing.md)
- 打包与发版：[packaging.zh-CN.md](docs/contributing/packaging.zh-CN.md)
- 其他文档：[`docs/`](docs/) · [UI 设计标准](docs/UI-Design-Standards.md) · [CHANGELOG](CHANGELOG.md) · [SECURITY](SECURITY.md) · [第三方声明](THIRD-PARTY-NOTICES.md)

## 许可

应用 [Apache-2.0](LICENSE) · 插件 [MIT](plugin/UnrealAgentLink/LICENSE)

Unreal Engine 是 Epic Games, Inc. 的商标，本项目与 Epic Games 无隶属关系。
