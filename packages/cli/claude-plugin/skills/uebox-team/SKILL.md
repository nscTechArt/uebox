---
name: uebox-team
description: Runs an Unreal Box game-studio team from this client. This session is the producer, uebox-member subagents are the teammates and a uebox-acceptor subagent tests the result, while Unreal Box keeps the roster, task board, mail, asset locks, snapshots and acceptance record. All thinking runs on this client's model; Unreal Box runs none. Use when the user asks to build a whole game or MVP with a team through Unreal Box, says things like "用团队模式做"、"让虚幻盒子的团队来做"、"开一个工作室把这个游戏做出来", or wants to resume an Unreal Box team by id. Do not use for a single change to an Unreal project (use the uebox skill or Unreal Box tools directly), or when Unreal Box is not running.
---

# Unreal Box studio team, with this client as the brain

Unreal Box is the studio and you are the producer. Teammates are subagents you start. Unreal Box keeps
the shared state and enforces the rules: who may write, asset locks, snapshots, and the
acceptance record.

## Quick Start

1. Check the setup once:
   - Run `uebox --version`. If it fails, tell the user to install the Unreal Box CLI.
   - The `UEBOX_TOKEN` environment variable must be set. Teammate subagents connect with it.
     If it is not set, stop and point the user to "Setup" in this plugin's README.
   - This session must have Unreal Box's MCP server. Its tools include `team_open`.
2. Call `team_open` with `objective` (the user's request, in their words). Read the producer
   brief it returns: it is the real rulebook for this team. Put the `team_seat` it gives you
   in the arguments of every later Unreal Box call, and never hand it to a subagent.
3. In your working directory, run `uebox team use <team id>`. The delivery hook uses it to find
   the team.

## Workflow

- Hire with `team_hire`: a name, a role you write, and optionally a tool scope or read-only.
- Give a teammate work: start a `uebox-member` subagent. The prompt has three lines:
  `team_id: <id>`, `member: <name>`, `assignment: <what to do, with all the context it needs>`.
  Independent assignments can run as parallel subagents.
- Create or open the project with `project_manage` (the one write you may do), then call
  `team_open` with `team_id` and `project_path` (the folder that holds the .uproject) so
  snapshots and teammates' tools target it.
- Between assignments: `team_status` shows the real state, `team_inbox` shows notes addressed
  to you, and `team_board` is the shared plan.
- To deliver, start a `uebox-acceptor` subagent with `team_id`, `report` (what was built, known
  gaps) and `how_to_play`. On FAIL, assign fixes and run acceptance again. On BLOCKED, stop and
  tell the user what is needed.
- To resume another day, call `team_list`, then `team_open` with `team_id`.

## Constraints

- Apart from creating or opening the project, do not change it yourself: not with Unreal Box
  write tools (Unreal Box refuses them on your connection), and not with this client's own file
  tools. Unrecorded changes skip the locks and snapshots.
- `task` is not available to the team: it would run Unreal Box's own model.
- Any change after a PASS voids it. The delivery hook keeps you working until acceptance passes,
  at most twice per user message.

## Failure Handling

- `team_join` fails inside a subagent: the subagent stops and returns the error. Usually the
  name does not match `team_hire`, or the team id is wrong.
- A teammate reports a lock conflict: another teammate holds that file. Sequence the work, or
  have them message each other.
- A subagent ends without `team_report`: Unreal Box records that job as stopped. Check
  `team_status` before you reassign it.

## Escalation

Stop and ask the user when acceptance returns BLOCKED, when the objective is ambiguous about
which project to build in, or when a step would spend money (paid generation) beyond what the
user asked for.
