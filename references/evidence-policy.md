# 每阶段检索、模板与依据

七个 Luz 技能按当前请求选择信息依据。明确要求查网时必须检索并核验正文。源码、测试、用户材料或稳定常识足以解决的问题可以直接处理。版本、价格、当前规则等缺少可靠依据时，围绕具体缺口检索。命令见 [preflight.md](preflight.md)。

## 商业项目的范围依据

状态根标记 `workflow = commercial-v1` 时，`scope` 的负责人 System 在两份对接文件生成前，按客户业务问题用 search 或 deep 检索并阅读原文，记下选择、排除、适用条件与覆盖位置。客户现状、授权范围与承诺只能取自客户原件和明确确认；公开案例只支持候选做法。由 System 完成 conclude 和 check 后，协作技能可使用该项目该阶段的有效记录。其他阶段按真实证据缺口选模式。

## 一、按阶段选择检索范围

1. **先选择依据。** 本地可解的工作直接处理。下游需要门禁时，`run --research local --reason "本地依据"` 写入本阶段判定，`check` 核对绑定；不启动浏览器。联网阶段用自己的 `--stage` 完成 `run → 读正文 → conclude → check`，同一需求共用 `--task`。
2. **先列问题。** 动手前列出本阶段要回答的问题、章节、页面、模块和验证事项，逐项进 `coverage`。既查原始规范、同类真实做法和适用版本，也查失败与边界，不只找支持已有想法的材料。
3. **下限。** 普通搜索默认至少 1 组实际查询、3 篇去重有效正文、1 个发布主体，其中至少 1 篇一手原文。大量或深入调研沿用 5 组查询、10 篇去重正文、3 个独立发布主体，其中至少 3 篇一手原文。只读给定网址时直接采集，不附加搜索引擎查询。用户明确指定篇数时用 `--min-sources N`，查询组、发布主体和一手正文的下限各自不高于 N。数量与问题覆盖都满足才可完成。
4. **什么不算。** 只改标点、空格或换语言重述的查询不算新方向。搜索结果卡、模型回答卡、导航、目录、错误页、登录壳和只有网址的条目不算正文。镜像、转载、同一机构的子域和重复正文不增加独立来源数；脚本只认得一部分重复，执行者按内容和发布关系再去重。
5. **每篇都读。** 打开并阅读适用的正文，留带哈希的快照，写采用或排除的理由。不批量抓够十页就说读完，不拿无关页面凑数。法律、协议、价格、指标、硬件能力、API、版本与依赖的具体断言回到发布方原文。
6. **不足就补。** 在同一记录上 `run --append` 补搜，保留失败路线和已有归档，再重新 `conclude`、`check`。`needs-research`、`blocked`、登录限制或缺关键依据，都不能用模型记忆补齐：保留缺口并写明缺什么。客户的业务事实只能由客户的资料支持，不从网上替客户编。
7. **按范围复盘。** 联网阶段按 [research-diligence.md](research-diligence.md) 核对问题、候选和停止依据。仅阅读指定网址时，查询组可以为空。只在对话中答复的 Crawl 调研可把 coverage 的采用位置填为“对话答复”，template_uses 留空。生成正式文件或界面时仍绑定其实际模板。

## 二、核对模板的使用位置

正式成品的模板与生成器按 [Design 文件设计](../../Luz-Design/references/file-design.html) 和 [模板库](../../Luz-Design/references/template-library.json) 选择。Crawl 只核对 `coverage.applies_to` 与实际的 `template_library.py select` 回执是否一致。联网结论页另用 Design 阅读页生成，由 Crawl 记录实际模板哈希。界面参考与组件来源、版权及浏览器验证按 [Design 组件复用](../../Luz-Design/references/component-reuse.md) 执行。

## 三、先有依据表，后有正文、界面与代码

不脱离已读材料和已确认需求去起稿、造事实、设计界面、编接口。可以忠实整理、归纳、改写材料，并按已确认需求写实现；新做的决定要标明是本次方案的决定及其推导依据，不能写成“来源这么说”。参考不等于照抄，复用源代码与资产要保留许可并核对用途。

补充信息的字段：

| 字段 | 内容 |
|---|---|
| `findings[]` | 唯一 `id`、本次的 `source_id`、`kind`（fact、reference、decision）、逐字 `quote`（至少 12 个字符，脚本在归档正文里核对）、原文小节或段落 `locator`、忠于原文的 `summary`、`applies_to`、`adopted`；未采用的写 `reason` |
| `source_reviews[]` | 每篇正文一条：真实发布主体 `publisher`、级别 `authority`（primary、first_party、secondary）、判断理由 `reason`。翻译、转载、镜像、目录、无关或不可用的来源写 `exclude_from_count: true` 并说明，它们不计数，也不能作已采用的依据 |
| `coverage[]` | `question_id`（对应尽责复盘里的问题编号）、`question`、具体输出位置 `applies_to`、已采用的 `finding_ids`。必要问题全部覆盖，不用一个“整个项目”盖住没调研的模块 |
| `template_uses[]` | `template_library.py select` 返回的真实记录 |
| `blocking_gaps[]` | 关键问题没覆盖、证据冲突没解决或只有模型推测时写在这里；非空不能 `conclude`，依赖它的成稿、设计、开发停下 |
| `gaps[]` | 非关键的限制，不写成已完成的能力 |

```json
{
  "scope": "实际待核实范围",
  "findings": [{"id":"F-001","source_id":"SRC-001","kind":"fact","quote":"从归档正文逐字复制的必要片段","locator":"实际章节或段落","summary":"由引文支持的结论","applies_to":"具体决定","adopted":true}],
  "source_reviews": [{"source_id":"SRC-001","publisher":"从来源核实的真实发布方","authority":"primary","reason":"发布关系及版本判断依据"}],
  "coverage": [{"question_id":"Q-001","question":"具体待回答问题","applies_to":"具体输出位置","finding_ids":["F-001"]}],
  "template_uses": [],
  "blocking_gaps": [],
  "gaps": []
}
```

上面只是字段示意，不是能提交的证据。`supplement-init` 按本阶段的正文和问题生成待填文件；不提交示例文案或虚构引文，不伪造标题、作者、时间、网址、引文、调研数量、测试截图和运行结果。

- 同一机构不能换名字或域名凑成多个主体；关键数字、业务规则和高影响的技术断言优先用两个独立的一手来源互相核对。规范或接口只有一个权威发布方时写明这一点，用实际版本、原文条款和可执行验证核对，不伪造第二来源。
- 事实、参考做法、用户已确认的规则、本次推导的决定和尚未核实的内容分开写。演示数据、离线夹具和假设只用于明确标记的测试或演示，不进事实、研究和验收结论。
- 文档里怎么引用、HTML 与 PDF 成品怎么检查、界面参考的看图与操作证据，按 Design 的 [document-evidence.md](../../Luz-Design/references/document-evidence.md)。来源引用属于内容依据，不因“客户不看来源”而删掉。

## 四、完成条件与检查的边界

- `crawl_preflight.py check` 重读真实日志、正文、快照、摘录、来源评估、覆盖关系、模板哈希和结论页。没有只填 passed、删字段、改回旧版本或换调用方与阶段的降级办法。已批准阶段的七天时效豁免只免年龄，不免其它证据要求。
- 机器计数、摘录存在和文件哈希都不能证明主题相关、发布主体独立或结论的语义正确。执行者逐项核对：主张是否被引文支持，条件、否定、版本有没有漏，模板是否真用在成品上，每个重要页面与模块是否有依据。没核实的标未核实，不说“已杜绝幻觉”“已保证真实”。
- BRIEF 的“采用的规则”记本规则、各领域卡和模板编号；“本次沉淀”记本次用 `note` 写入或确认的偏好、来源路线和教训。过程证据留在 `raw`，按用户要的成品范围交付，不把过程报告塞进产品界面。

## 方法来源

- [Agent Skills Specification](https://agentskills.io/specification)：入口与支持资源的组织、格式验证。
- [Anthropic Reduce hallucinations](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations)：允许不确定、先逐字引文、逐项用引文核验，找不到支持就撤回；这些措施不能完全消除幻觉。
- [OpenAI Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)：针对实际任务评估、覆盖边缘情形、自动检查结合人工判断；这里只采用评估方法。
- [W3C Understanding Consistent Identification](https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html)：同一页面集合中重复功能的一致识别；它不规定本地模板、查询数量或标签必须相同。

发布主体、适用范围与引用正文在当时的 Crawl 归档里核对过。门槛、强制调用和模板规定来自用户要求与本地实施决定，不是这些来源的原话。
