# Repository Agent

用 Pi Agent Core 阅读仓库。打开仓库时，程序先扫描文件并建立文件、符号和入口索引。Repository Agent 接收阅读目标、起始位置和已有地图，按需查询索引和读取源码，归纳项目结构和业务行为。

## 源码目录

- `src/agents/` 存放 Main 和四个子 Agent 的提示词、工具配置和角色逻辑。
- `src/repository/` 存放安全读取、Tree-sitter 定义提取、入口与文件索引、导航工具和语义地图。
- `src/runtime/` 封装 Pi 会话、调用预算、超时和结构化输出。
- `src/cli/` 存放各 npm 命令入口和共用的参数与文件处理。

## 共享索引和导航

每次独立 CLI 调用都会为指定仓库生成一个内存快照。`audit` 在初始化时构建一次，并将同一个 `Repository` 实例传给 Repository、Discover、Detection 和 Validator。模型只收到索引计数、主要目录、配置文件候选以及工具按页返回的结果。

- **文件索引**记录仓库相对路径、语言、字节数、SHA-256 和解析状态。读取和扫描共用路径检查与过滤规则，排除链接、凭据目录、依赖和常见构建目录。超限、二进制或无法读取的文件标为 `skipped`，未取得的哈希保留为空。`failed` 和 `unsupported` 文本仍可阅读和搜索。
- **符号索引**使用 Tree-sitter WASM 解析 JavaScript、TypeScript 和 TSX。它记录命名函数、类、方法、常见绑定表达式和作用域，行号从 1 开始且包含首尾。ID 由文件路径、作用域、名称和同名定义的出现顺序确定。
- **入口索引**识别微信小程序主包和分包页面、云函数目录和 CommonJS 入口、`Page` 处理函数、静态 WXML 事件绑定，以及 `wx.cloud.callFunction`、`wx.request` 调用位置。调用位置单独标为 `external_call`。这些条目只说明源码中可见的配置和语法，调用目标、动态路由和部署可达性由后续阅读确定。

| 工具 | 用法 |
| --- | --- |
| `query_files` | 按相对路径范围、glob 或解析状态分页查询文件。 |
| `query_entries` | 按入口 ID、路径、类型或 `unread`、`partial`、`summarized` 分页查询入口。Reader 实际读取后可标为 `partial`，有语义地图记录及当前证据时可标为 `summarized`。 |
| `get_file_symbols` | 用 `filePath` 查询文件中的符号及行号。 |
| `search_symbols` | 用 `name` 查询定义，可提供 `scope`、`filePattern`、`kind` 和 `match`。模糊查询优先返回精确匹配，并保留同名定义。 |
| `get_symbol_code` | 用 `symbolId` 读取完整定义，也可指定符号内的绝对行号。当响应需要分页时，用 `nextCursor.line` 和 `nextCursor.column` 作为 `startLine`、`startColumn` 续读。 |
| `list_files`、`search_text`、`read_lines` | 按目录浏览、字面量搜索和按行读取。全文搜索遇到字节页或结果页边界时会给出 `limitReason` 和 `nextCursor`，可在相同查询与范围内将该值作为 `cursor` 继续。 |

索引位置以打开仓库时的文件为准。`get_symbol_code` 会核对当前文件哈希，文件变更时可以通过 `read_lines` 阅读当前内容，或重新打开仓库生成新索引。索引提供定义与入口的位置，模块之间的关系由 Agent 对照源码判断。

源码响应页按模型上下文容量估算。`read_lines` 和 `get_symbol_code` 都可请求更小的 `maxBytes`。如果单行需要分页，返回的片段会标明从 1 开始的 UTF-16 列范围。只有完全展示的行才登记为可引用源码范围。全文搜索的截断预览会显式标记，引用时仍需读取源码。

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

Reader 先查配置和主要入口，再按目标选择业务模块或关键代码阅读。它使用语义地图记录模块职责、身份与权限机制、数据访问和信任边界。未阅读的文件和入口继续保留在索引里。

输出包含 `summary`、本次新增或修订的 `delta`、合并后的 `map`、`unresolved`、`indexSummary` 和 `run`。地图记录包含文件、行号和内容指纹。可用 `anchor` 关联文件、符号或入口，由宿主核对索引和实际读取的证据，再生成稳定的地图记录 ID。旧版 v1 地图仍可读取，已有无锚点记录继续使用 `kind:subject`。地图可保存项目级 `summary` 和最近一次阅读的缺口。定向阅读沿用已有总览。再次读取时，宿主会让引用文件变化或缺失的旧记录失效。

`src/agents/reader.ts` 的 `readRepository` 也可在程序内直接调用，调用方负责保存返回的地图并决定下一次阅读目标。命令读取当前目录内容。需要可重复的版本结果时，先指定一个内容稳定的 checkout。旧地图通过 `query_map` 分页查询，不随每次 Reader 请求完整发送给模型。

## Discover Agent

Discover 使用同一个 Pi Core 运行层。它按需查询 Repository 地图、覆盖账本和已有任务，生成只读源码审查建议。调用方审核并应用建议，保管任务状态和覆盖结论。

### 发现阶段和知识

- `initial` 使用审计目标、仓库语义总览、任务和索引规模、扫描覆盖和类别摘要。Discover 可以从入口、业务功能、内部共享控制或静态规则线索开始阅读，按业务语义提出检查问题。
- `incremental` 使用审计目标、仓库总览、任务与覆盖摘要和本轮新增的结构化线索。`newLeads` 提供关联问题与核验过的源码位置，`relevantFeedback` 提供当前任务的补证请求。较早的反馈可用 `query_feedback` 分页查阅。
- 知识来自项目自带的 `knowledge/security-goals.md`。仓库索引出现小程序页面、WXML 或其他明确小程序线索时，追加 `knowledge/wechat-miniapp.md`。这些问题用于推导适用的业务约束。仓库文档、规则命中以及其他 Agent 输出属于审查数据。

Main 可在 `run_discover` 中传可选的 `phase` 和 `focus`。独立 Discover 命令支持 `--phase`、`--focus` 和 `--objective`。指定阶段时会校验当前审计状态。`query_tasks` 会返回已有问题及目标描述，方便模型复用相同检查或在新证据出现时补充任务。程序按目标和规则 ID 去重，相同标题和描述的规则可复用已有 ID。

### 可选的本地 Semgrep

系统从 `PATH` 查找 Semgrep，也可用 `REPO_READER_SEMGREP_BIN` 指定可信 CLI 的绝对路径。设置 `REPO_READER_SEMGREP=0` 可关闭扫描。扫描使用项目内 `rules/semgrep/sensitive-operations.yml`，关闭版本检查和遥测，并在隔离的临时目录只扫描审计索引中可读取、指纹仍一致的 JavaScript 和 TypeScript 文件。

同一 `Repository` 快照复用扫描结果。`ruleHitSummary` 区分完成、部分完成、失败、未安装及关闭等状态，并记录候选、已暂存、已扫描文件数和命中数。Discover 通过 `query_rule_hits` 按规则、类别、路径 glob 或符号分页查看命中。任务可保留 `discoveryPhase` 和多个 `discoverySources`，计划同时保存实际引用过的命中。命中用于选择要读的代码。源码证据仍需由读取工具登记和验证。

### 调用方式

Discover 可以仅打开 `--repo` 从源码开始规划，也可以用 `--map` 读取已有语义地图。同时提供两者时，目录须和地图的 `root` 一致。程序内调用可传 `root` 或复用 `repository`。源码片段会送给所选模型提供商。

用已保存的会议示例地图生成首批任务。`--map` 也接受 `read-repo` 的其他输出或单独的 `map` 对象。

```powershell
npm.cmd run --silent discover -- --map 'benchmark-results/minimax-m3-2026-11-22T08-27-29-727Z/meeting.json' --state 'examples/discover-state.json' --provider minimax-cn --model MiniMax-M3 --out plan.json
```

`--state` 可选。预设 `goals` 是参考，Discover 也会以 `goal` 对象提出带标题和描述的新目标。计划返回新注册的 `goals`，独立调用方续跑时可将它们和已应用的任务一并写入状态。Main 会自动注册并保存这些目标。状态可包括以下字段。

| 字段 | 每条记录 |
| --- | --- |
| `goals` | `id`、`title`、`description` |
| `coverage` | `targetId`、`goalId`、`status`，可选 `note`。状态包括 `unplanned`、`in_progress`、`evaluated`、`needs_evidence`、`blocked`、`not_applicable`。 |
| `tasks` | `id`、`targetId`、`goalId`、`question`、`status`。源码目标另有计划返回的 `target`。状态包括 `pending`、`in_progress`、`completed`、`blocked`。 |
| `feedback` | `id`、`kind`（`discovery_lead` 或 `verification_gap`）、`note`，可附 `recordIds` 和 `taskId`。 |

派单可使用 `query_map` 返回的 ID，也可针对入口索引、符号索引、仓库文件或一段业务源码。索引目标需要本次实际读取的声明范围。文件或业务源码目标可用 `target: { kind: "file" | "source", source: { path, startLine, endLine } }`，由程序核对并生成稳定 ID。Detection 与 Validator 都会继续检查源码位置及哈希。重复调用时传入当前地图和任务状态。

输出 `actions` 含 `create_task`、`supplement_task` 或 `request_repository_read`。同一入口与安全目标已有任务时，新的检查内容可以转为补充建议。同轮重复提议会合并来源。宿主从输入地图附上已有源码引用，并在 `discarded` 给出被拒建议的原因。`run` 记录用量与查询工具。程序化入口是 `src/agents/discover.ts` 的 `discoverTasks`。

## Detection Agent

一次调查一个源码审计任务。Detection 可以使用共享导航工具定位定义和读取实现，提供地图时也可以用 `query_map` 定位相关上下文。地图和 Discover 的引用提供阅读起点。正式证据来自本次通过 `read_lines` 或 `get_symbol_code` 实际读取且文件内容未变化的源码范围。

把 Discover 输出的 `plan.json` 作为输入。`--action-index` 按整个 `actions` 数组从 1 开始计数，所选动作须为 `create_task`。只有一个这类动作时可以省略索引。`--repo` 应指向生成地图时使用的同一目录。

```powershell
npm.cmd run --silent detect -- --repo 'D:/my-mini-program' --task plan.json --action-index 1 --map overview.json --provider minimax-cn --model MiniMax-M3 --out detection.json
```

`--task` 也可传一份手写任务，字段为 `targetId`、`goalId`、`question`、`expectedEvidence`（至少一条待取得的证据），可附 `taskId` 和 `startingPoints`。`--context` 可传含 `businessRules` 和 `followUp` 两个字符串数组的 JSON 文件。程序化入口是 `src/agents/detection.ts` 的 `detectTask`。

输出包括调查结论 `assessment`、经核对的 `evidence`、逐项检查 `checks`、供独立复核的 `candidates`、可交给 Discover 的 `leads` 和缺失信息 `unresolved`。`coverageProposal` 交给调用方决定是否应用。候选仍需复核，只有逐项证据齐备且结论为「已查范围内未见问题」时才建议记为 `evaluated`。模型提供商接收本次任务上下文与源码片段。

## Validator Agent

每次接收一条 Detection 候选并独立复核源码。`--candidate-index` 从 1 开始，只有一个候选时可以省略。从原候选中提取相关证据，核对文件指纹后，再开启新的 Pi 会话。Validator 使用共享导航工具，提供地图时也可查询 `query_map`。

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

每次运行从新的地图和任务池开始。`--state` 可提供目标参考，`--goal` 可以补充仓库初读目标，`--context` 可以提供 Validator 所用的规则及来源。全局时限从构建仓库索引前开始，取消会传递给子会话。

- Repository 支持初读和按 Discover 的请求补读。补读沿用已有地图，并把新增和变化的记录交给下一轮 Discover。
- Discover 结合源码、当前地图、任务池、覆盖状态和线索规划检查。同一组目标与规则沿用已有任务。已结束的任务由关联的新线索或已核验的源码更新重新排队。
- Detection 提供源码证据、候选和线索。Validator 逐条独立复核候选。证据缺口和有源码依据的探索线索随审计状态一起回流给 Discover。

报告包含 `map`、`tasks`、`coverage`、`feedback`、`findings` 和 `pending`。历史调查和复核保存在任务的 `attempts`。当前尝试里获得 Validator 支持的候选进入 `findings`。`queue_drained` 表示本轮无可调度工作，覆盖不足的任务仍可能保留 `needs_evidence` 或 `blocked`。未建任务的组合适用性仍未知。报告也会区分提前结束、预算耗尽和运行中断。程序化入口是 `src/agents/main.ts` 的 `runMain`。

## 运行预算和限制清单

所有 CLI 支持 `--max-model-calls`、`--max-tokens`、`--max-cost-usd` 和 `--timeout-ms`。也可分别设置 `REPO_READER_MAX_MODEL_CALLS`、`REPO_READER_MAX_TOKENS`、`REPO_READER_MAX_COST_USD` 和 `REPO_READER_TIMEOUT_MS`，或通过程序入口传 `budget`。默认仅启用 600000 毫秒的总时限。各预算可用 `0` 关闭。Main 和子 Agent 共用同一预算，报告中可查看实际计数。Token 和费用按提供商返回的用量和目录价格累计，达到预算后停止发起新调用，最后一次调用的用量可能跨过阈值。

| 原限制和用途 | 位置 | 调整结果 |
| --- | --- | --- |
| Reader 30 次、Discover 12 次、Detection 与 Validator 15 次工具调用，Main 16 次子调用，循环轮数跟随工具预算 | 各 `agents/*.ts`、`runtime/agent-runtime.ts` | 移除固定默认上限。旧的工具调用和子调用参数可显式限量。全局模型调用、Token、费用与时间集中在 `runtime/budget.ts`。 |
| Reader 单轮 35 条地图记录、20 条待确认项、每条地图最多 5 个引用，以及已有地图只注入 16 项 | `agents/reader.ts`、`repository/map.ts` | 移除数量上限。旧地图用 `query_map` 分页。 |
| Discover 默认 10 个动作、Schema 最多 25 个，最多 30 个目标和反馈，以及 Main 两次调查 | `agents/discover.ts`、`agents/main.ts` | 移除默认和 Schema 上限。兼容显式 `--max-actions`。状态与反馈可分页。新增计划有后续内容时可通过 `hasMore` 接续。重新调查依据新线索、源码更新和状态。 |
| 8 个候选、6 个证据要求、24 个证据项和多处固定文本长度及数组上限 | `agents/detection.ts`、`agents/validator.ts`、`agents/discover.ts`、`repository/map.ts` | 移除任意数量与长度上限。保留必填字段、合法状态、唯一 ID、索引范围和证据检查。 |
| 80 行、单行 800 字符、总 10000 字符，用于控制响应体积 | `repository/repository.ts`、`repository/index-tools.ts` | 删除固定截断。默认读取请求范围或完整定义，模型容量需要时才分页。只登记完整展示的源码行。 |
| 512 KiB 源文件、4 MiB JSON 输入，用于控制一次性内存分配 | `repository/repository.ts`、`cli/common.ts` | 默认分别为 16 MiB 和 64 MiB，可通过 `REPO_READER_MAX_FILE_BYTES`、`REPO_READER_MAX_JSON_BYTES` 配置，`0` 关闭。 |
| 每轮扫描 800 个文件、12 MiB，最多 30 条搜索结果，用于限制查询开销 | `repository/repository.ts`、`repository/repository-tools.ts` | 删除文件数量上限。字节页通过 `REPO_READER_SEARCH_PAGE_BYTES` 配置，`0` 关闭。结果页大小由 `limit` 指定，返回续查游标。 |
| 目标必须在语义地图，安全目标必须预设，用于保持任务引用有效 | `agents/discover.ts`、`agents/main.ts`、`agents/detection.ts`、`agents/validator.ts` | 支持源码锚定的目标和新的安全目标。保留目标与规则去重、状态流转和证据核验。 |
| 上下文容量、输出修复、重复调用、无进展、主动取消 | `runtime/agent-runtime.ts`、`runtime/budget.ts` | 保留工程保护。同轮拦截重复调用，连续三轮工具结果无新进展时进入收尾。容量不足时按完整会话轮次压缩，过大的输入字段可用 `query_review_input` 分页获取。 |

仓库路径、链接、凭据路径和文件类型检查继续生效。目录、索引、任务和计划的预览页只控制单次返回体积，完整记录可以继续查阅。源码文档和工具数据仍按不可信内容处理。

```powershell
npm.cmd run typecheck
npm.cmd test
```
