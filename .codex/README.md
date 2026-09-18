# Codex project setup / Codex 项目配置

Open this repository in Codex and mark it as trusted. Codex will then:

- read the root `AGENTS.md` automatically;
- load the safe project defaults in `config.toml`;
- apply the command policy in `rules/unreal-box.rules`;
- discover the repository workflows under `../.agents/skills/`.

Start with a normal request, or invoke a workflow explicitly:

```text
$unreal-box-feature add custom colors to asset tags
$unreal-box-verify
$unreal-box-ship
```

This project configuration does not choose a model or provider and does not add credentials,
telemetry, or remote services. Network access inside the workspace sandbox is off by default;
Codex can still ask before a task such as the first `pnpm install` needs network access.

---

用 Codex 打开本仓库并将项目标记为可信后，Codex 会自动：

- 读取根目录的 `AGENTS.md`；
- 加载 `config.toml` 中的安全默认值；
- 应用 `rules/unreal-box.rules` 中的命令规则；
- 发现 `../.agents/skills/` 下的仓库工作流。

你可以直接用自然语言提需求，也可以显式调用上面的四个工作流。项目配置不会替你选择模型或
服务商，也不会加入凭据、遥测或远程服务。工作区沙箱默认不联网；首次执行 `pnpm install`
等确实需要联网的任务时，Codex 会单独向你确认。
