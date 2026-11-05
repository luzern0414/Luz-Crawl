# 更新记录

## 未发布

- 目录：输出目录改为 `task_folder_v2`，遵守 Luz 技能输出目录统一规范。输出根默认 `D:\Codes\skill输出\Luz-Crawl`（命令行和前置检索一致，可用 `--out` 或 `LUZ_CRAWL_OUTPUT` 改），下面只有“序号-主题”任务文件夹（三位序号加短横线，如 `117-主题`）；序号取输出根下所有一级文件夹的最大序号加一，旧的 `NNN_主题` 也计入，不补洞、不复用。任务根目录只有 `raw/`（全部爬取内容和机器记录，任务标记 `raw/luz-task.json`，页面存档文件直接放在“四位序号_标题”文件夹里，不再套一层 `raw/`）和同级的总结页 `NNN-主题.html`；`begin` 建好任务就写出只有标题的总结页，之后每次采集重写。总结页没有内容的节不写。旧的下划线任务目录和标记在 `raw/` 旁边的旧任务（`sibling_raw_v1`）、旧存档不改名，仍可读取、续接和生成总结；输出根里有散落文件时 `begin` 报错并指向 `scripts/migrate_layout.py`。`crawl_preflight.py` 先认 `<存档>/content.json`，再认 `<存档>/raw/content.json`。
- 项目模式：项目不保存爬取的原始内容，复用的 Crawl 任务就在 Crawl 输出根下（`project.json` 的 `crawl.task_root`）。`crawl_preflight.py` 的 `--session` 可以是项目目录或状态根（含 `project.json` 的目录；项目目录对应 `D:\Codes\skill输出\Luz-Project\<目录名>\raw`），前置检索记录与结论页写在状态根下 `crawl.evidence_index`（`00-crawl`）；旧项目的 `raw/00-crawl` 保持原行为。新增 `state_root`、`evidence_dir`。
- 迁移脚本 `migrate_layout.py`：已有任务保留原名，只有改号的第二代文件夹按新写法 `NNN-主题`；默认只预览，`--apply` 才迁移，`--revert` 撤回；`--rewrite-with 移动记录.json --extra-root 目录` 按记录里的旧名改写输出根之外的项目目录里的绝对路径（审批绑定的产物与它们按哈希引用的文件只列出，不改）；`--reconcile-with 移动记录.json` 把其他文件里已被取代的哈希更新为文件现在的哈希。
- 归档：同一网址再次采集不再自动续接并改写旧归档，而是另存为新序号的归档，旧归档保持原样（哈希不变）；新归档在 manifest 和 identity 里写 `recapture_of`；只有明确加 `--resume` 才续接该网址最新的一份。
- 前置检索：`run` 里一条搜索或采集路线失败（退出码非 0、超时、被限流）时保留日志和退出码、继续其余路线，所有路线都没有取得正文才记 blocked（原先任何一条失败就停下，整次检索作废）。
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
