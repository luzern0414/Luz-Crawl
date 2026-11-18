---
name: luz-crawl
description: 按用户意图检索、阅读指定网页、开展深入调研，或在持续浏览器会话中操作页面并采集证据。本地可解的问题可直接处理。
---

# Luz 网页检索与采集

按用户原始请求搜索、阅读或操作真实网页，以读到的正文和实际页面状态支持结论。本地材料足够时可直接处理。

## 调用协议

按[依据政策](references/evidence-policy.md)和[前置记录](references/preflight.md)选 `local`、指定网址、`search` 或 `deep`。有项目上下文读[项目流程](../Luz-Project/references/skill-architecture.md)。输出正式文档时接入[成品验收](../Luz-Design/references/document-evidence.md)。

1. 本地模式按需记录依据并 `check`。联网运行 `node scripts/luz-crawl.mjs doctor` 后，`begin "主题" --out <输出根> --new` 建任务。之后每条命令带 `--out <任务目录>`，同一需求共用任务目录。
2. 用 `experience --query "关键词"` 查经验。明示的数量、范围和问题逐项传入，不省略用户指定的搜索。普通搜索和深入调研的门槛与终止条件见[依据政策](references/evidence-policy.md)和[调研规程](references/research-diligence.md)。
3. 读去重后的真实正文。搜索卡片作候选，评论只代表已加载的条目。正式联网阶段走 `run`、阅读、`conclude`、`check`，每阶段各自登记。
4. `summary <任务目录>` 汇总。在汇总成功后按[归档规则](references/evidence.md)清理可重建的下载缓存，保留待交付媒体和用户要求的原件。`note` 写入经验后反查。

## 按任务选入口

- 通用查询、指定网址、批量阅读见[工作流](references/workflows.md)。开源候选回[原仓库](references/github-search.md)，小红书和抖音见[平台指南](references/platforms.md)。
- 持续操作用 [live 会话](references/browser-live.md)，单次自动化查[浏览器接口](references/browser-api.md)。登录或验证用 `pending` 等用户处理，再 `continue TASK_ID`。重采另建归档，`--resume` 续接最新归档。
- 归档、汇总和诊断见[证据说明](references/evidence.md)、[验证](references/validation.md)与[安装](references/install.md)。任务原始资料在 `raw/`，汇总页与 `raw/` 同级。

## 硬边界

- 用户明确指定并授权时才用已连接的登录浏览器。点击、输入、提交等写操作须经授权并加 `--allow-write`。提交结果未知时先 inspect。
- 批量或重复读同一站点先查 `robots`，遵循[合规规则](references/compliance.md)。尊重权限、限流和验证，凭据不导出，小红书、抖音和 GitHub 只读指定的少量公开页面。
- 个人字段只留完成当前任务所需部分。项目阶段使用 `project.json` 的共享任务目录，向 Project 交可核对的来源和结论。经验仅说明发现及适用范围，历史命中仍要在当前页面复核。
