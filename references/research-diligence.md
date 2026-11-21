# 尽责调查与经验复用

本页用于已经决定联网的阶段。深入调研展开多个方向，普通搜索按问题核对来源，指定页面的阅读限于用户给定的范围。数量门槛和依据表在 [evidence-policy.md](evidence-policy.md)，命令在 [preflight.md](preflight.md)。按用户约定的范围、时间与并发执行。

## 完成标准

在任务范围内尽量找全相关信息和候选网站，并核实影响决定的问题。每个阶段留下：问题与查询计划、完整候选、逐轮判断、来源依据、经验的采用与更新。覆盖不足就继续查；受预算或访问限制而停下时写明受限，不说穷尽。不拿无关网页、转载、镜像或重复查询凑数，已核实的问题也不为数字重复抓取。命令的详情数、滚动数、重试次数是单次预算，不是整项研究的上限。

## 先查经验，再设计查询

1. 拆出对象、目标、场景、关键决定、地区／语言／版本和约束。每个待回答的问题有编号、重要性、采用位置和满足条件。
2. 查主题短语、核心术语、平台和域名的相关经验。规划多个查找项时用 `experience --file lookups.json`，文件内容为 `[{ "query": "术语", "platform": "入口" }]`，`platform` 可省略。`run` 会把本轮计划涉及的经验一次写入阶段日志。出现新术语或失败后，再从实际缺口查相关经验。
3. 判断返回的偏好、关键词、路线、失败和来源经验：采用、改写、不适用或待复核。记下具体 key 和它改变了哪条查询或判断；没命中也记。不写“已复用”却说不出对应经验和实际影响。
4. 旧经验只安排调查顺序，不替代对当前页面的核实。`uses` 是确认次数，不是正确概率。过期、未验证或互相矛盾的条目先复核；用户的新要求覆盖旧偏好，并用原 key 更正。

## 问题驱动的发散

先列查询组和各自目的。深入调研默认覆盖五个不同方向，普通搜索从一个相关方向开始。可按下表挑选：

| 方向 | 查询方式 | 要回答的问题 |
|---|---|---|
| 核心意图 | 用户原词、对象、动作、场景、行业名称与简称 | 专业领域怎样表达这个需求 |
| 原始依据 | 官方规范、文档、原论文、原仓库、发布方与版本 | 规则和能力来自哪里，有什么条件 |
| 替代比较 | 同类产品、不同技术路线、竞品、不同地区的做法 | 有没有漏掉可行的候选，差别在哪 |
| 实施细节 | 官方示例、代码、数据、依赖、许可、运营与验收 | 能不能落地，需要哪些前提 |
| 反例风险 | 限制、失败、未解决的问题、撤回、更正和相反观点 | 什么证据可能推翻当前判断 |
| 关联问题 | 上下游、相邻领域、引用与被引用、作者的相关材料 | 新线索能否解决原问题或暴露必要的缺口 |

每个方向说明它与原问题的关系。模型想到的同义词和网站只是待查线索，不写成已存在的来源。中英文或当地语言按任务选，保留版本与地区条件；引号、排除词、`site:`、日期和文件类型语法按平台核对。长查询没结果就拆开，不把所有同义词拼成 AND。经验库和网站库只是起点，开放式调查还要找库外的来源；用户只要指定页面或站内搜索时守住范围。

## 完整候选与分类

排序混杂或候选多时，在同一轮使用多个 `--query` 和 `run --read 0`，等去重候选池返回后集中选择，再用一次 `run --append` 传入选中的多个 `--url`。按问题相关性和发布主体选择原文。

`run` 把每轮实际发现的网址和采集尝试合并进本阶段的 `*-candidates.json`，保留查询、日志、失败状态和正文来源编号。它不截断，但也不代表发现了全站结果；`sites` 按主机分组，不是独立发布主体数。原始候选文件不动，逐项评审写在同目录的 `<caller>[-stage]-research-review.json`。没有实际发现记录的网址不写成已发现；清单很长时按类概括并给完整清单的位置，不只留最后三五个。

| 类别 | `category` | 用途 |
|---|---|---|
| 官方／标准 | `official` | 原始规则、API、版本和限制 |
| 一手项目／产品 | `project-product` | 真实实现、仓库、案例和产品能力 |
| 研究／数据 | `research-data` | 原论文、公开数据、方法和适用范围 |
| 行业／专业机构 | `professional` | 术语、领域方法和对比线索 |
| 社区／经验 | `community` | 故障、用户的说法、反例和原出处线索 |
| 聚合／索引 | `index` | 发现入口，回到原文后才作依据 |
| 发布关系核实不了 | `unknown` | 写明原因 |

主页、搜索和详情分别验证，按 [site-research.md](site-research.md) 决定是否进运行目录。

## 阅读、补搜与停止

循环做“发现 → 读正文 → 按新线索补搜”。每轮记：查了什么、去重后新增了哪些网站、哪些正文相关、补齐了哪个问题、出现了什么新术语、矛盾或缺口、下一轮改什么。跟进引用、相关项目、相反结论和替代方案；没有值得跟的线索时写明排查过的范围。

停下之前确认：必要问题都有适用的依据；冲突有解决的依据；重要的来源类别和候选都处理过；做过按阅读结果调整的补搜；能说明再搜为什么新增有限。数量达标、重复原词、只搜一个域名都不能证明饱和。

| 停止原因 | 含义 |
|---|---|
| `sufficient` | 范围内依据充足 |
| `saturated` | 连续几条不同路线的新信息明显变少 |
| `budget-limited` | 受预算限制；列出剩余候选和影响 |
| `access-limited` | 受访问限制；列出剩余候选和影响 |

前两种也不表示全网穷尽；后两种的关键缺口仍然阻塞，非关键限制进 `gaps`。全文、小节、视频简介与转写的阅读范围分别记，没读的部分不算读过，同一长文拆段不增加正文数。保留失败的分支，从允许访问的其它独立来源继续查，不规避验证码、权限、限流、robots 或用户的限制。

## 经验分类与更新

每次实际公开搜索记录生效的关键词、入口、候选和受阻状态。读到正文后再记录关键词与来源网址的对应关系。后续用 `experience --query` 回查 `keywords`、`events` 和 `source_hints`，结合任务问题选择值得复核的查询和网站。网站能力按实际搜索入口记录，原文域名作为来源线索供下次核验。

`kind` 是偏好／教训／事实，`category` 是用途，`tags` 是主题与别名，三者不互相代替。

| `category` | 可复用的内容 |
|---|---|
| `keyword` | 原词、同义词、行业与外语术语、有效或无效的组合、扩展条件 |
| `route` | 搜索入口、站内与索引路线、详情路径、平台与限制 |
| `source` | 发布方、公开原文、能回答的问题、版本／地区和复核条件 |
| `failure` | 症状、已排除的原因、试过的修正、不可越过的限制 |
| `verification` | 查询生效、正文到位、字段准确和来源独立的核验方法 |
| `method` | 问题拆分、筛选、逐轮调整、停止判断和交接方法 |
| `general` | 旧条目；复核时再分类，不凭猜测批量标成已验证 |

每轮有新规律或修正就 `note`。结束前至少新增、更新或经本次真实验证后确认一条；没有新规律就确认真正用上的旧条目，不编经验凑数。最后换一种说法反查新条目，确认能召回。

```powershell
node scripts/luz-crawl.mjs experience --query "核心术语 领域别名" --category keyword --out $task
node scripts/luz-crawl.mjs note --kind lesson --category route --key "route-主题-场景" --tags "主题,平台,别名" --when "实际适用条件" --text "经验证的路线、效果和限制" --source "<实际公开原文网址>" --outcome success --out $task
node scripts/luz-crawl.mjs experience --query "另一种自然说法" --out $task
node scripts/luz-crawl.mjs check
```

- `--outcome` 取 `success`、`failure`、`mixed`、`unverified`；易变的条目设 `--valid-until YYYY-MM-DD`。
- `--source` 放公开依据的网址，任务归档和日志位置写进复盘；本地实现的教训可以没有公网来源，但要有实证位置。不写凭据、个人信息和私人路径。
- `--public --when` 只发布通用且已核实的路线，用户偏好始终留在本机。
- 用稳定的 key 更正同一规律并保留上一版；不同类别或平台的同文案不强行合并。失败经验不一律删，也不凭一次超时断定网站永远不可用。
- 自动生成的 `scope:` 条目只概括采集观察，标为 `source`／`unverified`；观察次数不是去重正文数或已采用来源数，复核后用同一 key 更正。

## 尽责复盘

`crawl_preflight.py review-init` 生成并在每次补搜后合并 `<caller>[-stage]-research-review.json`：绑定字段、候选网址、已执行的查询、各轮日志和经验查询日志由它填，判断全部留空。执行者逐项填写，一串 `passed` 不能代替真实观察：

| 字段 | 内容 |
|---|---|
| `caller`、`stage`、`task_root`、`candidate_inventory_sha256` | 与当前记录一致（脚本绑定） |
| `questions[]` | 唯一 `id`、`question`、`importance`（required 或 optional）；必要问题另写满足条件和采用位置 |
| `query_groups[]` | 各不相同的 `purpose`、`queries`（本阶段成功执行过的查询，一条查询只属于一组）、平台和关联问题 |
| `candidate_reviews[]` | 当前全部候选，每项 `url`、`category`、`question_ids`、`status`、`priority`、`reason`；补充真实发布主体和阅读范围 |
| `rounds[]` | `logs`、`observation`（实际新增的信息）、`next_action`（下一轮改什么、为什么）；最后一轮说明为何停 |
| `experience_reuse[]` | `status`、`log`、`impact`，有命中时写具体 `keys`；没命中也记日志 |
| `experience_updates[]` | `note` 返回的 `key`、`category`、`outcome`、`evidence`（实证与回执位置）、`recall_log`（反查日志位置） |
| `stop` | `reason`（上面四种之一）、`basis`（实际依据）、`remaining`（剩余候选和受限范围） |

- `status` 取 `unread`、`read-adopted`、`read-not-adopted`、`duplicate`、`irrelevant`、`restricted`；`priority` 取 `high`、`medium`、`low`。
- 标为已读的候选必须有本阶段归档的正文；`read-adopted` 必须关联问题并有对应的已采用结论。只读了一部分的按 `read-not-adopted` 记真实范围。无关项的 `question_ids` 可以为空。
- 高优先级候选还没读或受限时，不能写 `sufficient` 或 `saturated`，也不能悄悄删掉。
- `conclude` 绑定复盘的哈希，`check` 检查它没被改动；补搜之后重新 `review-init`、复核、再 `conclude`。没有候选文件的历史记录保持兼容，补搜后按新合同做。

脚本只核验结构、正文、摘录、关系和哈希。发散是否相关、是否认真读过、停得是否合理、经验是否真被用上，机器判断不了，由执行者负责。比较策略时写清分母：审阅候选中的相关比例、尝试详情中有效正文的比例、必要问题的覆盖、去重后新增的来源。下载量、记忆条数和确认次数不是准确率。

## 方法依据与边界

- [Google 检索改进](https://support.google.com/websearch/answer/2466433?hl=en)：精确查询、扩展和过滤；不推定其它引擎语法相同。
- [GitHub 搜索语法](https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax)：该页限定非代码搜索，平台与搜索类型分别核对。
- [Qdrant 相关性反馈](https://qdrant.tech/articles/search-feedback-loop/)：按反馈调整查询并注意偏离原意；不搬用它的实验指标。
- [Zotero 分类](https://www.zotero.org/support/collections_and_tags)、[搜索](https://www.zotero.org/support/searching)、[去重](https://www.zotero.org/support/duplicate_detection)：分类、可搜索的笔记和保留关系的合并；不要求安装该产品。
- [Imperial College London 检索记录](https://library-guides.imperial.ac.uk/systematic-review/documenting_search)：保留可复核的过程；不把医学综述规则当软件通用标准。

每次尽责调查、上面的分类、停止与交接合同来自用户要求和本地实施决定。外部资料只支持方法选择，不规定本地数量门槛，也不证明本技能的长期精度已经提高。
