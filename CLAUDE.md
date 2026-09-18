# CLAUDE.md

本文件是给 Claude Code 的入口指针，内容不在这里重复维护。

**动手前请先完整阅读 [AGENTS.md](AGENTS.md)**（中文版：[AGENTS.zh-CN.md](AGENTS.zh-CN.md)），
它是本仓库对所有 AI 编码 Agent 的唯一规范来源：架构分层、硬规则、验收门禁、提交约定。

一句话版本：做完一个任务跑 `pnpm verify:changed`（约 30 秒，只查你改的）；这批活要发出去之前
再跑一次完整的 `pnpm verify`，全绿才算做完。**不要每做完一件小事就跑完整门禁**，理由见
AGENTS.md 第 3 节。`git push` 和开 PR 之前先问人。

本仓库不附带项目级 slash command：`.claude/` 在 `.gitignore` 里，属于各人的私有 IDE 配置，
不进公开仓库（理由同 `.cursor`、`.gemini` 那几行）。想要自己的快捷命令就在本机
`.claude/commands/` 下建，不会被提交上去。
