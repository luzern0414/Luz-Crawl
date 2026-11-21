# 前置检索的命令与判定

七个 Luz 技能按原始请求与实际信息缺口选择本地处理、阅读指定网址、普通搜索或深入调研。联网的数量与依据见 [evidence-policy.md](evidence-policy.md)，调研方法见 [research-diligence.md](research-diligence.md)。

简单修改和直观问题可直接使用给定材料。本地生成器需要前置记录时，下面两条命令即可完成检查。它们不启动浏览器，不创建 Crawl 抓取任务。独立调用沿用本技能的会话目录。

```powershell
python -X utf8 scripts/crawl_preflight.py run --caller luz-dev --session "<会话>" --stage implementation --topic "修复空列表的索引错误" --research local --reason "调用方源码与现有回归用例可直接核对"
python -X utf8 scripts/crawl_preflight.py check --caller luz-dev --session "<会话>" --stage implementation
```

## 命令

每条命令的 `--caller`、`--session`、`--stage` 必须一致。记录是 `<session>/raw/00-crawl/<caller>[-stage].json`，结论页是同名的 `.html`。

| 命令 | 作用 | 退出码 |
|---|---|---|
| `run` | 本地写入 `not-required`。联网一次查阅本轮的相关经验，再用一个浏览器批次执行所有查询、已知网址和任务汇总 | 本地为 0。联网达到下限为 0，仍须 conclude。数量不足为 1，状态为 `needs-research` 或 `blocked` |
| `status` | 只读。已有多少查询、正文、站点，候选有多少没进复盘，复盘缺什么，下一步做什么 | 0 |
| `review-init` | 生成或合并尽责复盘 `…-research-review.json`：绑定字段、候选、查询、各轮日志、经验日志由它填，判断留空 | 0 |
| `supplement-init` | 生成或合并补充信息 `…-supplement.json`：每篇正文一条结论和一条来源评估、每个问题一条覆盖，内容留空；`--out` 可改位置 | 0 |
| `conclude --file <补充信息.json>` | 核对通过后写入补充信息、绑定复盘、生成结论页；加 `--dry-run` 只列出全部问题，不写任何文件 | 通过为 0，否则 1 |
| `check` | 只读。重新核对日志、正文、快照、摘录、来源评估、覆盖、模板和结论页 | 通过为 0，否则 1 |

`run` 的参数：

| 参数 | 含义 |
|---|---|
| `--caller` | 实际执行检索的技能 |
| `--session` | 本技能会话，或项目目录、状态根 |
| `--topic` | 这次缺什么信息；不含密钥和真实用户数据 |
| `--research` | 缺省 auto。无查询的网址阅读用 urls；明确要求搜索用 search，大量查找用 deep，本地可解用 local。只给普通主题时默认本地，传查询、原文 URL 或明确的搜索指令会启用对应联网路线 |
| `--min-sources` | 用户指定的去重正文最低篇数，正整数。直接请求如“搜索五篇原文”也可识别。补搜沿用初次决定 |
| `--reason` | 本地判断的依据，可写代码位置、测试或给定材料 |
| `--stage` | 业务阶段或项目阶段 |
| `--task` | `begin` 返回的任务目录；同一需求的各技能、各阶段共用 |
| `--query` | 可重复，缺省用 topic。写成 `入口::关键词`（如 `github::browser automation`）时这条查询用自己的入口 |
| `--url` | 可重复；已知的官方原文 |
| `--platform` | 查询入口，默认 bing。逗号分隔表示回退顺序（`bing,baidu`）。前一个没有正文或候选且允许继续查找时，用同一批次访问下一个 |
| `--read` | 每条查询打开的详情数，0 到 5，默认 3；0 只建候选池 |
| `--concurrency` | 不同站点的并发数，1 到 8，默认 6。同站入口的任务依次运行 |
| `--compact` | 返回来源计数、研究缺口和归档位置。完整来源清单在 `record` 指向的阶段记录中 |
| `--append` | 同阶段补搜，保留已有路线与来源 |
| `--no-screenshot` | 文本调研不截图，仍保留正文与 DOM 快照；界面依据要另行截图并实际查看 |

```powershell
python -X utf8 scripts/crawl_preflight.py run --caller luz-design --session "<本技能会话>" --topic "<这次缺什么信息>" --task "<begin 返回的任务目录>" --stage design --research deep --read 0 --query "<关键词>" --query "github::<关键词>"
python -X utf8 scripts/crawl_preflight.py status --caller luz-design --session "<会话>" --stage design
python -X utf8 scripts/crawl_preflight.py run --caller luz-design --session "<会话>" --topic "<同一主题>" --stage design --append --url "<选中的原文>"
python -X utf8 scripts/crawl_preflight.py review-init --caller luz-design --session "<会话>" --stage design
python -X utf8 scripts/crawl_preflight.py supplement-init --caller luz-design --session "<会话>" --stage design
python -X utf8 scripts/crawl_preflight.py conclude --caller luz-design --session "<会话>" --stage design --file "<补充信息.json>" --dry-run
python -X utf8 scripts/crawl_preflight.py conclude --caller luz-design --session "<会话>" --stage design --file "<补充信息.json>"
python -X utf8 scripts/crawl_preflight.py check --caller luz-design --session "<会话>" --stage design
```

普通搜索可以直接 `--read 3` 读详情，已知原文用一个或多个 `--url` 指定。深入调研可一次传入多组 `--query` 并用 `--read 0` 建候选池，再用一次 `--append` 批量补读选中的原文。联网阶段以 `conclude` 和 `check` 核验结论。本地阶段直接 `check`。

- 每轮返回一份结果，提供正文索引、候选清单、批次归档和汇总页位置。每条实际路线及失败原因都可在归档里核对。不同入口的任务可同时搜索和采集，打开详情时按实际目标站的访问节奏控制。
- 经验查询、浏览器检查或任务汇总失败时，保留本轮日志用于恢复。阶段内的汇总供继续调研时阅读，等整个任务结束再用 `summary` 清理共享缓存。
- 第一次 `run` 建立阶段记录；不带 `--append` 再运行会重写本阶段记录。`--append` 必须是同一 caller、session、stage、topic，不能换任务，也不能借别的阶段。补搜会使原结论失效：重读新增正文，重新 `conclude`、`check`。
- 同阶段的 `run`、`conclude`、`review-init` 用互斥锁；锁在时 `check` 不认旧结论。进程异常终止留下锁时，先核实锁里的 pid 已退出再清理。
- 旧生成器没有 `--stage` 参数时，在本阶段的命令环境里设 `LUZ_CRAWL_STAGE` 为同一名称，换阶段同步更新；显式参数优先。没有阶段的旧单次记录只供同一个单阶段调用。

## 项目里的位置

`--session` 传项目目录或状态根（含 `project.json` 的目录；项目目录的状态根是 `E:\Skill输出\Luz-Project\<目录名>\raw`）。记录和结论页写在状态根下 `project.json` 的 `crawl.evidence_index`（`00-crawl`；旧项目的 `raw/00-crawl` 保持不变）。项目不保存爬取的原始内容：复用的 Crawl 任务（`crawl.task_root`）在 Crawl 输出根下。

## 任务与阶段共享

| 情况 | 做法 |
|---|---|
| 同一需求的多个技能或阶段 | 首个联网阶段用 `begin --new` 建任务，其余联网阶段用 `--task` 复用目录，各自 `run`、`conclude`、`check`。本地阶段仅在生成器需要记录时使用 `run --research local`、`check` |
| 缺省 `--task` | 项目用 `project.json` 的 `crawl.task_root`；否则自动 `begin --new`，输出根取 `LUZ_CRAWL_OUTPUT`，没设时是 `E:\Skill输出\Luz-Crawl` |
| 并发的不同需求 | 各用自己的任务目录 |
| 阶段隔离 | 本阶段来源核对到本轮浏览器批次、其中的具体路线与对应正文档案。补搜沿用同阶段已登记的来源 |

## 补充信息怎么写

`run` 成功只说明取到了正文并达到数量下限。执行者读完全部 `sources[].archive` 的 `content.json`，核对来源级别和适用边界，再按 [依据表](evidence-policy.md) 填写。

补充信息的文字是写给读结论页的人的：`summary`、`findings[].applies_to`、`reason`、`gaps` 不写编号、路径、哈希和采集日期；`coverage[].applies_to` 与 `template_uses[].applies_to` 是过程字段，填一致的具体输出位置供门禁核对。

结论页给开发者复核：第一行是标题，之后是带表题的三张表（检索结论、检索范围与路线、未覆盖范围），来源写在表 1 的“来源”列。它不直接交给客户：要写进客户文件的内容由所属技能用客户的词重写，关键的外部主张按 Design 的 document-evidence.md 保留就近引用和文末原文。

## 判定

- **完整链路。** 有连接检查、经验查询、真实的搜索或采集日志，且次序正确。doctor 返回 `ready: true`（已连接可见 Edge）或 `silent_ready: true`（可启动静默 Edge）只说明能开始，不证明读到了页面。
- **有效来源。** 任务标识存在（`<任务目录>/raw/luz-task.json`，旧任务在 `<任务目录>/luz-task.json`）；页面确认取到正文；有 `content.json` 和真实快照；清单与文件的 SHA-256 一致；网址、采集时间与本次成功的日志对应。某条路线没取到正文时保留它的状态和限制，可以采用同次检索里另一条已核实的来源。
- **结论页。** `conclude` 把页面名和 SHA-256 写进记录，`check` 复核；页面缺失或被改动就重新 `conclude`。
- **时效。** 记录超过七天要重新检索。项目里七天期限只管正在做的阶段：该阶段的 docs 文件已由用户逐个批准之后，它的记录只核对存在、有效、已 `conclude` 且结论页没被改动，超过七天也不挡下游，不为它重跑；变更重开某个阶段后，它重新算进行中。超期提示固定写“检索记录超过七天，请按当前需求复核”，Luz-Project 的 `project_crawl_gate.crawl_errors(…, waive_expiry=True)` 靠这句话识别并只去掉这一条，其余错误照常返回。不要改这句话的措辞。
- **失败。** 记录 `blocked`，保留试过的路线；按关键缺口调整查询、阅读与补采。需要登录或验证时交给用户，不用没核实的知识冒充完成。
- **各技能自己的要求仍然有效。** 这里是通用的最低门禁：System 的多来源覆盖、Dev 的官方与开源研究、Writing 的事实核验、Design 的实际看图与版式检查、Ops 的测试证据继续执行。
- **合规。** 批量或重复读取前按 [compliance.md](compliance.md) 核对；平台限制写进未覆盖范围。

## 各技能补充什么

| 技能 | 典型检索范围 | 写回位置 |
|---|---|---|
| Project | 行业、范围约束、交付条件、阶段风险 | 需求与阶段计划 |
| System | 用户任务、同类业务、模块关系、平台能力 | 功能逻辑、前端、后端三个视图 |
| Design | 信息密度、排版、图标、组件、无障碍、响应式 | 设计方向与界面交接 |
| Dev | 技术版本、API、数据库、实现、依赖、部署 | 技术方案、代码与验证依据 |
| Ops | 测试方法、发布、监控、备份、回滚 | 验收、发布、运行和移交报告 |
| Writing | 原始事实、术语、受众、表达边界 | 声明表、提纲、正文或文案键表 |
| Crawl | 来源权威性、访问方式、已知的采集限制 | 可追溯的来源与爬取总结页 |
