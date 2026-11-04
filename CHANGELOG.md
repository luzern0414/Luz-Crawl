# 更新记录

## 未发布

- 目录：输出目录改为 `task_folder_v2`。输出根下只有“序号_主题”任务文件夹；`raw/` 存放全部爬取内容和机器记录（任务标记 `raw/luz-task.json`，页面存档文件直接放在“序号_标题”文件夹里，不再套一层 `raw/`）；总结 html 是与 `raw/` 同级的“序号_主题.html”，网页 html 放进各自的页面存档，不再散落在输出根。旧任务目录（标记在 `raw/` 旁边，`sibling_raw_v1`）和旧存档仍可读取与续接；输出根里有散落文件时 `begin` 报错并指向 `scripts/migrate_layout.py`。`crawl_preflight.py` 先认 `<存档>/content.json`，再认 `<存档>/raw/content.json`。
- 迁移脚本 `migrate_layout.py`：默认只预览，`--apply` 才迁移，`--revert` 撤回；`--rewrite-with 移动记录.json --extra-root 目录` 按记录里的旧名改写输出根之外的项目目录里的绝对路径（审批绑定的产物与它们按哈希引用的文件只列出，不改）；`--reconcile-with 移动记录.json` 把其他文件里已被取代的哈希更新为文件现在的哈希。
- 归档：同一网址再次采集不再自动续接并改写旧归档，而是另存为新序号的归档，旧归档保持原样（哈希不变）；新归档在 manifest 和 identity 里写 `recapture_of`；只有明确加 `--resume` 才续接该网址最新的一份。
- 前置检索：`doctor` 增加 `silent_ready`，没有打开可见 Edge 时前置检索不再因连接检查失败；`run` 增加 `--platform`、`--read`，来源只取自本次 search/capture 日志；`conclude` 写入结论页的 SHA-256，`check` 复核并返回页面路径。
- 报告页：前置检索结论页、爬取总结页和汇总报告统一为正式文档版式（标题在先、带表题的表、单一字体族；删除统计卡、过滤框、徽标、时间戳和脚本）。字号改用共享的 Markdown 层级块（`lib/formal-report.css` 内 `luz-md-type` 标记之间）：桌面（768 及以上）正文 18、h1 36、h2 28、表格 16，手机正文 16、h1 28、h2 24、表格 14，表题和来源域名 14；原来的正文 16、标题 32/24/20 取消。`scopedFormalCSS` 生成附在已保存页面后的报告样式时先去掉注释。
- 合规：新增 `robots URL`（RFC 9309 判定，只请求 `/robots.txt`）、`references/compliance.md` 和 `references/research-method.md`；证据说明补充 WARC 的区别。
- 搜索：搜索引擎回答卡里的厂商帮助页（如“必应如何提供搜索结果”）不再进入候选。
- 扩展：移除未被调用的 `cookies` 权限与命令和重复的 `activeTab`；自动化标志隐藏改为默认关闭，需要时设置环境变量 `LUZ_STEALTH=1`。需在扩展管理页重新加载。
- 清理：删除已完成的内部设计与计划文档（边界并入 `references/platforms.md`）和未使用的 `assets/readme-workflow.svg`。

## 3.3.0

- 增加小红书和抖音关键词扩展、详情字段、作者、时间和已加载评论采集。
- 增加评论去重、覆盖率和停止原因，详情失败时继续补采并自适应预算。
- 增加 GitHub、Bing、GitCN、HelloGitHub、Codeberg 和 Gitee 的有限检索路线。
- 扩展显示公开/授权浏览器模式及查询、候选、详情、评论进度。
- 精简技能、项目和扩展使用说明。

## 3.2.0 至 3.2.2

- GitHub 检索：关键词拆解、有限查询、候选去重、详情补位和失败候选补位；改进查询条件、卡片证据、结果排序、备用搜索路线和仓库详情读取。
- 增加 GitCN、HelloGitHub、Codeberg 等开源项目搜索入口。
- 区分候选、正文、登录、验证、限流、部分成功和失败。
- 修复浏览器表单搜索、详情核验、截图保存和任务接续；精简命令、扩展和文档说明，统一输出与状态规则。

## 3.0.0

- 使用仓库内源码直接运行。
- 支持无头浏览器、可见浏览器补读、媒体下载和本地 HTML 归档。
