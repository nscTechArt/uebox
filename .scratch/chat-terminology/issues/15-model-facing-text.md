# 15: 给应用内模型读的文字

Status: done
Blocked by: 10（两张都改 agent 工具文字，审批按钮那一带可能重叠）
组：第 7 组（给应用内模型读的文字）

依据：`../spec.md`「给应用内模型读的文字（第 7 组）」；术语见根目录 `CONTEXT.md`。

**What to build:** AI 转告用户的话也说「对话」：工程健康检查、派活、语音指令等应用内模型读的文字里，指对话的「会话 / 聊天」改为「对话」，
模型不再把旧说法照抄给用户。协议名与其他领域的会话保持原样，行为不变。

- [x] spec 范围内的文字逐句改：只换词、不改句式；「聊天」指内容时改成准确说法；提到 `session` / `session_id` 参数处写明取值来自哪个工具的返回（取值是内核 session id）
- [x] spec 列出的例外全部不动（日志、MCP / 引擎 / 编辑器 / 语音识别会话、「当前语音对话」标记一对、参数名 `session` / `session_id`、「会话记录」）
- [x] 断言这些文字的测试同步改；「当前语音对话」标记的断言不动；相关测试通过
- [x] `CONTEXT.md` 注明语音派活工具的参数 `session`（取值是内核 session id）是给模型的协议名，不改
- [x] 一次性检索：范围内按 `会话|聊天` 搜索，每处剩余命中都落在例外里，检索命令与结果附在本工单末尾
- [x] 提交信息标明「第 7 组」，只含第 7 组的改动
- [x] **人手动验证**（agent 做完上面各条后停下来请人做）：本机试语音派活能接到已有对话；`sessionHealth` 的提示由模型转告时说的是「对话」

## 一次性检索（完成时）

命令（脚本在 `../scripts/g7-strings.mjs`）：

```bash
pnpm exec node .scratch/chat-terminology/scripts/g7-strings.mjs src/main
pnpm exec node .scratch/chat-terminology/scripts/g7-strings.mjs src/shared   # 零命中
rg -n "会话|聊天" resources/skills
rg -c "会话|聊天" resources src/main --glob "!*.ts"                   # 只有 resources/skills
```

范围内每处剩余命中都归入保留类别：日志（console / logger 行）；MCP 协议会话（`McpServerHost`、`addNotebookSource` 的「外部会话」）；
引擎 / 编辑器会话（PIE、编辑器进程、agent 撤销栈、「引擎会话」技能文本）；内核 transcript 的「会话记录」；
`toolSearch.ts` 的 `DOMAIN_TERMS` 检索同义词（让模型或用户用旧说法时仍能命中）；技能作者的开发与实测过程
（`ue-animation-retargeting`，不指对话，曾误改为「对话」、已恢复上游原文）。
测试文件不在检索里；断言旧说法的测试随全量测试一起改。

**顺带发现（不在本单范围）**：`sessionHealth.ts` 离线提示说「工具清单是本轮开始时定下来的，中途连上不会补发」，
`createAgent.ts` 已会在引擎状态中途变化时换工具清单，这句话可能已过时——属行为说明准确性，另开单。

注意：`dispatch_task.session` 与 `box.session_id` 的取值都是内核 session id（不是对话 id），相关文字按中性写法落地，
`CONTEXT.md` 已注明，见 spec 第 7 组做法。手动验证已完成（语音派活接到已有对话；`sessionHealth` 转告时说「对话」）。
