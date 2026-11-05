# 所有 Luz 技能的前置检索

一次业务任务、一个项目阶段都必须在形成方案前检索。规则卡、目录查询、doctor、验证和经验维护命令本身不是新的业务任务，不为每条内部命令重新联网。Crawl 执行自己的检索，不递归调用自身。

独立调用只创建本技能的编号会话，不生成完整项目树。只有显式 `luz-project`、`LUZ_PROJECT_ROOT` 或 project context 启用完整矩阵。

## 调用与返回

三条命令的 `--caller`、`--session`、`--stage` 必须一致，记录位于 `<session>/raw/00-crawl/<caller>[-stage].json`，结论页同名 `.html`。

项目里 `--session` 传项目目录或状态根（含 `project.json` 的目录；项目目录的状态根是 `D:\Codes\skill输出\Luz-Project\<目录名>\raw`），记录和结论页写在状态根下 `project.json` 的 `crawl.evidence_index`（`00-crawl`；旧项目的 `raw/00-crawl` 保持不变）。项目不保存爬取的原始内容：复用的 Crawl 任务（`crawl.task_root`）在 Crawl 输出根下。

| 命令 | 传入 | 返回 | 退出码 |
|---|---|---|---|
| `run` | `--caller` 实际执行者；`--session` 本技能会话、项目目录或状态根；`--topic` 这次缺什么信息；可选 `--task`、`--stage`、`--query`（可重复，缺省用 topic）、`--url`（可重复，已知官方原文）、`--platform`（默认 bing，可用 github、gitee、xhs、douyin 等）、`--read`（每个查询打开的详情数，1 到 5，默认 1） | JSON：`record`、`status`（needs-conclusion）、`task`、`sources[]`（`archive` 指向正文归档）、`next` | 0；未取得有效正文时 1，记录保留为 blocked |
| `conclude` | 同上加 `--file <补充信息.json>` | JSON：`record`、`report`（结论页路径）、`status: complete` | 0；补充信息不完整或证据无效时 1 |
| `check` | 同上 | JSON：`ok`、`errors[]`，通过时另有 `report` | 0 通过，1 不通过 |

`run` 依次执行 doctor、begin（或复用任务）、experience、search/capture、summary。一条搜索或采集路线失败（退出码非 0、超时）时，记录保留它的日志和退出码，继续跑其余路线，只有所有路线都没有取得正文才记为 blocked；doctor、experience、summary 失败仍然停下。同一阶段的全部来源放进同一次 `run`（再跑一次会重写该阶段的记录，原来的来源不再列入）。`--topic` 与 `--query` 不含密钥或真实用户数据；`--topic` 写成不带括号说明的短名称，它就是结论页的标题。`--caller` 支持六个专属技能及 Crawl 自己（`luz-crawl`）。

```powershell
python -X utf8 scripts/crawl_preflight.py run --caller luz-design --session "<本技能会话>" --topic "<这次缺什么信息>" --task "<begin 返回的任务目录>" --stage design --query "<关键词>" --url "<已知官方原文>"
python -X utf8 scripts/crawl_preflight.py conclude --caller luz-design --session "<会话>" --stage design --file "<补充信息.json>"
python -X utf8 scripts/crawl_preflight.py check --caller luz-design --session "<会话>" --stage design
```

## 任务与阶段共享

| 情况 | 做法 |
|---|---|
| 同一需求的多个技能或阶段 | 主会话 `begin --new` 一次，把返回的目录作为 `--task` 传给每个技能；每个技能每个阶段仍各自 `run`、`conclude`、`check` |
| 缺省 `--task` | 项目（状态根有 `project.json`）时用其中 `crawl.task_root`；否则自动 doctor、`begin --new`，输出根取环境变量 `LUZ_CRAWL_OUTPUT`，未设置时用 `crawl_preflight.py` 里的 `DEFAULT_OUTPUT`（`D:\Codes\skill输出\Luz-Crawl`），任务目录是其下的“序号-主题”文件夹 |
| 并发的不同需求 | 各用自己的任务目录，不共用 |
| 阶段隔离 | 来源只取自本次 `run` 的 search/capture 日志；同一任务里别的阶段读到的页面不能当作本阶段的证据，记录也不能换 caller 或 stage 复用 |

## 补充信息

运行成功只表示已取得可读正文。执行者必须阅读 `sources[].archive` 文件夹里的 `content.json`（旧存档在其 `raw/` 下），核对来源级别与适用边界（[research-method.md](research-method.md)），再写补充信息：

```json
{
  "scope": "响应式布局与图标可读性",
  "findings": [
    {"source_id": "SRC-001", "summary": "从正文提炼的事实或设计依据", "applies_to": "方案的哪一页、模块或决定", "adopted": true},
    {"source_id": "SRC-002", "summary": "另一项参考", "applies_to": "候选比较", "adopted": false, "reason": "不符合本次平台约束"}
  ],
  "gaps": ["尚未核实的范围或版本；没有则空数组"]
}
```

补充信息的文字写给读结论页的人：页面不显示 `SRC-` 编号，`summary`、`applies_to`、`reason`、`gaps` 里不要引用编号，也不写路径、哈希和采集日期。`conclude` 生成的结论页是给开发者复核的 HTML，版式与 Crawl 的其他报告一致：第一行是标题，之后依次是带表题的三张表（检索结论、检索范围与路线、未覆盖范围），每张表在自己的小节里；来源写在表 1 的“来源”列，给出标题链接和域名，不另列来源清单、数字统计和采集日期。单一字体族，字号按 Markdown 层级分级（见 [CONTRIBUTING.md](../CONTRIBUTING.md)），不含时间戳、哈希、路径、工具名和装饰。页面随所属技能的方案作为输入，关键结论也写入方案相应部分。

结论页不直接交给客户：需要写进客户文件的内容由所属技能用客户的词重写，不带 Crawl 页面、来源统计、路径或哈希；客户明确要求参考来源时，只在文末列标题与链接。

## 判定

- 完整链路：有连接检查、经验查询、真实搜索或采集日志，且次序正确。连接检查通过指 doctor 返回 `ready: true`（已连接可见 Edge）或 `silent_ready: true`（本机可以启动静默 Edge）；它不证明能读到页面，后面的正文仍须单独成立。
- 有效来源：任务标识存在（`<任务目录>/raw/luz-task.json`，旧任务在 `<任务目录>/luz-task.json`）；页面确认取得正文；有 content.json 和真实快照文件；清单与文件 SHA-256 一致。网址、正文采集时间与本次成功日志须对应；搜索候选、错误响应、空表、仅 URL、passed 标签、只 doctor 都不通过。某条采集路线未取得正文时保留其状态和限制，可采用同次检索中另一条已核实的来源。
- 补充信息：至少一项有效来源对应的补充信息被实际采用，写明采用位置；其他参考说明采用决定；列出未覆盖范围。脚本只能检查记录完整性，执行者必须复核结论是否忠于来源。
- 结论页：`conclude` 把页面名与 SHA-256 写入记录，`check` 复核；页面缺失或被改动即不通过，需重新 `conclude`。
- 时效：调用记录超过七天须重新检索；发布或交付时仍检查实际文件，不能靠旧的通过状态。
- 失败：记录 blocked，保留已尝试路线；有限补搜或补采，不以未核实知识伪造完成。需要登录或验证时按 Crawl 协议交给用户。
- 范围：这是通用最低门禁。System 的多来源覆盖、Dev 的官方/开源研究、Writing 的事实核验、Design 的风格确认、Ops 的测试证据继续执行，不能用一页参考代替专业调查。
- 合规：批量或重复读取前按 [compliance.md](compliance.md) 核对；平台限制写入未覆盖范围。

## 各技能补充什么

| 技能 | 典型检索范围 | 写回位置 |
|---|---|---|
| Project | 行业、范围约束、交付条件、阶段风险 | 需求与阶段计划 |
| System | 用户任务、同类业务、模块关系、平台能力 | 功能逻辑 / 前端 / 后端三视图 |
| Design | 信息密度、排版、图标、组件、无障碍、响应式 | 2–3 个候选及确认后的 UI 交接 |
| Dev | 技术版本、API、数据库、实现、依赖、部署 | 技术方案、代码与验证依据 |
| Ops | 测试方法、发布、监控、备份、回滚 | 验收、发布、运行和移交报告 |
| Writing | 原始事实、术语、受众、表达边界 | 声明表、提纲、正文或文案键表 |
| Crawl | 来源权威性、访问方式、已知采集限制 | 可追溯来源与爬取总结 HTML |
