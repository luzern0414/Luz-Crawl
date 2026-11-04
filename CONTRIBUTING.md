# 贡献

## 提交问题

请提供：

- 项目版本、Node.js 和 Edge 版本；
- 使用的平台和公开 URL；
- 执行命令；
- 预期与实际状态；
- stop_reason、limitations 和复现步骤。

日志和截图先删除 Cookie、令牌、账号信息和私人正文。

## 修改代码

- 运行逻辑在 lib/ 和 scripts/。
- 扩展代码在 browser-extension/。
- 文档和站点目录在 references/、data/ 和根目录。
- 测试运行：`npm run test:all`，即 `node --test "tests/*.test.mjs"` 加前置检索的 `python -X utf8 -m unittest discover -s scripts -p "test_*.py"`。
- 其他 Luz 技能直接导入 `scripts/crawl_preflight.py` 和 `scripts/test_crawl_preflight.py` 的 `fixture`、`complete_fixture`、`validate_preflight`、`source_errors`、`digest`、`now`，修改这些函数的签名前先确认它们。
- 新生成的报告页统一用 `lib/formal-html.mjs`（和 Python 端共用 `lib/formal-report.css`）：标题在先，每张表有“表 N　标题”，不加时间戳、徽标、统计卡、脚本和装饰。字号、字重、行高和标题、表格、代码的间距来自 `lib/formal-report.css` 里夹在 `luz-md-type:start` 与 `luz-md-type:end` 之间的 Markdown 层级块（桌面正文 18、h1 36、h2 28、表格 16；手机正文 16、h1 28、h2 24、表格 14；表题与来源域名 14）。这一段是各 Luz 技能共用的同一份镜像，只从共享母本同步，不在这里手改；块之外只写组件样式，字号一律取 `var(--md-aux)`、`var(--md-table)` 等令牌，不另写 px。
- 修改扩展后，在扩展管理页重新加载并运行 doctor。

新站点先记录在 references/site-library.json；只有确认搜索或采集路线可复用时才加入运行目录。不要把个人 data/memory/、输出目录、raw、浏览器资料、日志或凭据提交到仓库。

## 安全边界

搜索和采集使用真实浏览器，只关闭本任务创建的页面；点赞、发送和提交等写操作必须获得用户明确授权。其余边界（不破解验证码、不绕过权限、不导出 Cookie）见 [SKILL.md](SKILL.md) 与 [references/compliance.md](references/compliance.md)。
