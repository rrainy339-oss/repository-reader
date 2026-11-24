# Repository Agent

用 Pi Agent Core 阅读仓库。每次调用接收阅读目标、可选的起始位置和已有地图。模型按需列文件、搜索文本和阅读源码行，逐步补充项目结构。

## 源码目录

- `src/agents/` 存放 Main 和四个子 Agent 的提示词、工具配置和角色逻辑。
- `src/repository/` 存放仓库读取、源码证据、地图结构和查询工具。
- `src/runtime/` 封装 Pi 会话、调用预算、超时和结构化输出。
- `src/cli/` 存放各 npm 命令入口和共用的参数与文件处理。

## 运行

需要 Node.js 22.19 或更新版本。安装依赖后，配置所选提供商的环境变量 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`MINIMAX_API_KEY`（MiniMax 国际站）或 `MINIMAX_CN_API_KEY`（MiniMax 中国站）。使用 M3 时选择 `--model MiniMax-M3`，并按账号区域指定 `--provider minimax` 或 `--provider minimax-cn`。工具返回的源码片段会作为上下文发送给该模型提供商。

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run --silent read-repo -- --help
```

执行一次仓库总览，再把上一次输出交给同一个 Agent 定向阅读。示例中的模型 ID 可以替换成所选提供商目录中支持工具调用的模型。`--out` 将结果写入新的 UTF-8 文件，省略时输出到终端。

```powershell
npm.cmd run --silent read-repo -- --repo 'D:/my-mini-program' --provider anthropic --model claude-sonnet-4-6 --goal '梳理小程序主要模块、入口和前后端边界' --out overview.json
npm.cmd run --silent read-repo -- --repo 'D:/my-mini-program' --provider anthropic --model claude-sonnet-4-6 --map overview.json --focus paymentCallback --goal '深入阅读支付模块，梳理回调到订单状态更新的关系' --out payment.json
```

输出包含 `summary`、本次新增或修订的 `delta`、合并后的 `map`、`unresolved` 和 `run`。地图记录包含文件、行号和内容指纹。本次记录的引用必须落在工具实际读取的行上。再次读取时，宿主重新核对旧记录的引用文件，变化或缺失的引用会使旧记录失效。源码引用检查确认位置与文件内容，业务归类与关系仍由模型解释，并标记为观察或推断。

`src/agents/reader.ts` 的 `readRepository` 也可在程序内直接调用，调用方负责保存返回的地图并决定下一次阅读目标。命令读取当前目录内容。需要可重复的版本结果时，先指定一个内容稳定的 checkout。文件工具跳过链接、常见凭据路径、大文件和非 UTF-8 文件。搜索有扫描上限，返回 `truncated` 时可缩小目录后继续查询。

## Discover Agent

Discover 使用同一个 Pi Core 运行层。它按需查询 Repository 地图、覆盖账本和已有任务，生成只读源码审查建议。调用方审核并应用建议，保管任务状态和覆盖结论。

传入 `--repo` 可额外启用 `read_lines`，供 Discover 核对可能影响派单的源码细节。目录须和地图的 `root` 一致。工具使用仓库相对路径，继承 Repository Agent 的读取范围和文件限制。程序内调用时传 `root`。源码片段会送给所选模型提供商。未指定仓库时，已有地图仍可单独用于规划。

用已保存的会议示例地图生成首批任务。`--map` 也接受 `read-repo` 的其他输出或单独的 `map` 对象。

```powershell
npm.cmd run --silent discover -- --map 'benchmark-results/minimax-m3-2026-11-22T08-27-29-727Z/meeting.json' --state 'examples/discover-state.json' --provider minimax-cn --model MiniMax-M3 --out plan.json
```

`--state` 需要 `goals`。下一轮可以增加 `coverage`、`tasks` 和 `feedback`：

| 字段 | 每条记录 |
| --- | --- |
| `goals` | `id`、`title`、`description` |
| `coverage` | `targetId`、`goalId`、`status`，可选 `note`。状态包括 `unplanned`、`in_progress`、`evaluated`、`needs_evidence`、`blocked`、`not_applicable`。 |
| `tasks` | `id`、`targetId`、`goalId`、`question`、`status`。状态包括 `pending`、`in_progress`、`completed`、`blocked`。 |
| `feedback` | `id`、`kind`（`discovery_lead` 或 `verification_gap`）、`note`，可附 `recordIds` 和 `taskId`。 |

地图记录的 ID 是 `kind:subject`。例如会议示例里的 `entry:miniprogram/pages/detail/detail.js`。重复调用时传入当前地图和当前任务状态，确保状态中的 ID 仍能在此快照中找到。

输出 `actions` 含 `create_task`、`supplement_task` 或 `request_repository_read`。同一入口与安全目标已有任务时，新的检查内容可以转为补充建议。同轮重复提议会合并来源。宿主从输入地图附上已有源码引用，并在 `discarded` 给出被拒建议的原因。`run` 记录用量与查询工具。程序化入口是 `src/agents/discover.ts` 的 `discoverTasks`。

## Detection Agent

一次调查一个源码审计任务。Detection 自行调用共享的 `list_files`、`search_text` 和 `read_lines`，提供地图时也可以用 `query_map` 定位相关上下文。地图和 Discover 的引用只提供阅读起点；正式证据使用本次实际读取且文件内容未变化的源码范围。

把 Discover 输出的 `plan.json` 作为输入。`--action-index` 按整个 `actions` 数组从 1 开始计数，所选动作须为 `create_task`。只有一个这类动作时可以省略索引。`--repo` 应指向生成地图时使用的同一目录。

```powershell
npm.cmd run --silent detect -- --repo 'D:/my-mini-program' --task plan.json --action-index 1 --map overview.json --provider minimax-cn --model MiniMax-M3 --out detection.json
```

`--task` 也可传一份手写任务，字段为 `targetId`、`goalId`、`question`、`expectedEvidence`（至少一条待取得的证据），可附 `taskId` 和 `startingPoints`。`--context` 可传含 `businessRules` 和 `followUp` 两个字符串数组的 JSON 文件。程序化入口是 `src/agents/detection.ts` 的 `detectTask`。

输出包括调查结论 `assessment`、经核对的 `evidence`、逐项检查 `checks`、供独立复核的 `candidates`、可交给 Discover 的 `leads` 和缺失信息 `unresolved`。`coverageProposal` 交给调用方决定是否应用。候选仍需复核，只有逐项证据齐备且结论为「已查范围内未见问题」时才建议记为 `evaluated`。模型提供商接收本次任务上下文与源码片段。

## Validator Agent

每次接收一条 Detection 候选并独立复核源码。`--candidate-index` 从 1 开始，只有一个候选时可以省略。从原候选中提取相关证据，核对文件指纹后，再开启新的 Pi 会话。可用工具是共享的 `read_lines`、`search_text`、`list_files`，以及提供地图时的 `query_map`。

```powershell
npm.cmd run --silent validate -- --repo 'D:/my-mini-program' --detection detection.json --candidate-index 1 --map overview.json --provider minimax-cn --model MiniMax-M3 --out validation.json
```

可用 `--context` 传入业务规则依据。每条规则需要 `id`、`rule`、`source` 和 `provenance`。来源类型是 `documented`、`maintainer_confirmed`、`inferred`。例如：

```json
{"rules":[{"id":"draft-state","rule":"新记录进入草稿状态。","source":"产品规范第 2 节","provenance":"documented"}]}
```

输出 `verdict` 为 `supported`、`refuted` 或 `needs_evidence`，并附适用范围和本次独立读取的证据。支持或反驳需要重新读取原候选的一处支持证据，并提供当前依据。支持结论还需要适用规则的来源。原证据变化或缺失时，返回具体文件并要求重新取得证据。`needs_evidence` 会附 `feedback`，可放入 Discover 的反馈列表，原任务 ID 应保留在任务表。程序化入口是 `src/agents/validator.ts` 的 `validateCandidate`。

## Main Agent

Main 自己运行在 Pi Core 上，可以用 `run_repository`、`run_discover`、`run_detection` 和 `run_validator` 调度四个角色。每次调度开启独立的 Pi 会话，默认共用命令行选择的模型。`get_audit_state` 给 Main 提供待处理的任务和剩余预算。

```powershell
npm.cmd run --silent audit -- --repo 'D:/my-mini-program' --state 'examples/discover-state.json' --provider minimax-cn --model MiniMax-M3 --out audit.json
```

`--state` 读取 `goals`，每次运行从新的地图和任务池开始。`--goal` 可以补充仓库初读目标，`--context` 可以提供 Validator 所用的规则及来源。默认最多调度 16 次子 Agent，总时限 600000 毫秒，可用 `--max-subagent-calls` 和 `--timeout-ms` 调整。超时时会给正在运行的子会话传递取消信号。

- Repository 支持初读和按 Discover 的请求补读。补读沿用已有地图，并把新增和变化的记录交给下一轮 Discover。
- Discover 结合当前地图、任务池、覆盖状态和新增线索发现适用的「目标 × 安全要求」缺口。同一组合沿用已有任务，补查新证据时可重新排队，每个任务最多启动两次 Detection。
- Detection 提供源码证据、候选和线索。Validator 逐条独立复核候选。证据缺口和有源码依据的探索线索随审计状态一起回流给 Discover。

报告包含 `map`、`tasks`、`coverage`、`feedback`、`findings` 和 `pending`。历史调查和复核保存在任务的 `attempts`。当前尝试里获得 Validator 支持的候选进入 `findings`。`queue_drained` 表示本轮无可调度工作，覆盖不足的任务仍可能保留 `needs_evidence` 或 `blocked`。未建任务的组合适用性仍未知。报告也会区分提前结束、预算耗尽和运行中断。程序化入口是 `src/agents/main.ts` 的 `runMain`。

```powershell
npm.cmd run typecheck
npm.cmd test
```
