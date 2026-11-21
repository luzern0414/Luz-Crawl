---
name: luz-crawl
description: 按用户意图检索、阅读指定网页、开展深入调研，或在持续浏览器会话中操作页面并采集证据。本地可解的问题可直接处理。
---

# Luz 网页检索与采集

按用户原始请求搜索、阅读或操作真实网页，以读到的正文和实际页面状态支持结论。本地材料足够时可直接处理。

## 调用协议

商业项目首次范围确认由 System 调用 `crawl_preflight.py run --session <状态根> --caller luz-system --stage scope --research search --query <检索词> --topic <业务问题>`。在同一记录读原文、conclude、check，供需求说明和系统方案同批使用。两份文件的客户事实取自原始资料，外部依据注明适用条件。

按[依据政策](references/evidence-policy.md)和[前置记录](references/preflight.md)选 `local`、指定网址、`search` 或 `deep`。有项目上下文读[项目流程](../Luz-Project/references/skill-architecture.md)。输出正式文档按[成品验收](../Luz-Design/references/document-evidence.md)复核。调研与检索报告采用 [Design 通用文档模板](../Luz-Design/references/design/documents.md#通用文档模板)。

1. 本地模式按需记录依据并 `check`。联网运行 `node scripts/luz-crawl.mjs doctor` 后，`begin "主题" --out <输出根> --new` 建任务。之后每条命令带 `--out <任务目录>`，同一需求共用任务目录。
2. 规划时用 `experience --query "关键词"` 查经验。同一轮关键词和原文网址用一次 `run --compact` 提交，多条分别传 `--query`、`--url`。直接采集用 `batch --file <计划> --compact`，单条用 `search <入口> "关键词" --read N --compact`。独立站点默认 6 路并发，结束后一次返回计数与归档位置。搜索数量与终止条件见[依据政策](references/evidence-policy.md)和[调研规程](references/research-diligence.md)。
3. `--read 0` 只收集候选链接。需要读原页、正文或图片时，把去重后的目标网址提交给本技能读取。评论只代表已加载的条目。正式联网阶段走 `run`、阅读、`conclude`、`check`，每阶段各自登记。
4. `summary <任务目录>` 汇总。在汇总成功后按[归档规则](references/evidence.md)清理可重建的下载缓存。实际搜索会记录关键词、入口、可读来源和限制，用 `note` 沉淀本次确认能复用的经验，再用不同措辞反查。

## 按任务选入口

- 已知原页用 `capture URL` 或 `batch` 通过 LuzCrawl 扩展打开。用户要求打开可见浏览器或在当前页持续操作时，用 `live open URL --headed` 直开目标页，再用 `live inspect` 核对页面状态。其他工具的拦截回执仅用于诊断，接管依据是本技能的实际页面回执。[浏览器会话](references/browser-live.md)
- 通用查询和批量阅读见[工作流](references/workflows.md)。开源候选回[原仓库](references/github-search.md)，小红书和抖音见[平台指南](references/platforms.md)。
- 单次自动化查[浏览器接口](references/browser-api.md)。登录或验证由用户在可见页面处理。已有 `pending` 任务可用 `continue TASK_ID` 续接。重采另建归档，`--resume` 续接最新归档。
- 归档、汇总和诊断见[证据说明](references/evidence.md)、[验证](references/validation.md)与[安装](references/install.md)。每个“序号-主题”任务的原始资料在 `raw/`，汇总页与 `raw/` 同级。

## 硬边界

- 用户明确指定并授权时才用已连接的登录浏览器。点击、输入、提交等写操作须经授权并加 `--allow-write`。提交结果未知时先 inspect。
- 批量或重复读同一站点先查 `robots`，遵循[合规规则](references/compliance.md)。尊重权限、限流和验证，凭据不导出，小红书、抖音和 GitHub 只读指定的少量公开页面。
- 个人字段只留完成当前任务所需部分。项目阶段在状态根登记依据，页面归档放在 `project.json` 的共享任务目录 `crawl.task_root`。经验仅说明发现及适用范围，历史命中仍要在当前页面复核。

调研阅读页、第三方页面取证与产品界面的交接见[工作流](references/workflows.md)的交付范围。
