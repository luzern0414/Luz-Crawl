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
- 测试运行：node --test "tests/*.test.mjs"。
- 修改扩展后，在扩展管理页重新加载并运行 doctor。

新站点先记录在 references/site-library.json；只有确认搜索或采集路线可复用时才加入运行目录。不要把个人 data/memory/、输出目录、raw、浏览器资料、日志或凭据提交到仓库。

## 安全边界

搜索和采集使用真实浏览器，只关闭本任务创建的页面。不破解验证码、不绕过权限、不导出 Cookie。点赞、发送和提交等写操作必须获得用户明确授权。
