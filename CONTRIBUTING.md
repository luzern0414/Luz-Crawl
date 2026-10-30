# 贡献 LuzCrawl

请先确认贡献可按 PolyForm Noncommercial 1.0.0 分发。第三方代码必须保留来源和许可；对 browser-extension/ 的上游修改保留 Apache-2.0 声明。

## 提交问题

提供版本、Node / 浏览器版本、平台、公开目标 URL、命令、预期结果、实际 `status / stop_reason / limitations` 和复现步骤。若是网址错误，区分请求 URL 与落地 URL。截图及日志先删除 Cookie、令牌、账号资料与私人正文。

## 本仓库的范围

本仓库就是源码，根目录就是技能目录，直接运行、无需构建：入口 `scripts/luz-crawl.mjs`，采集代码 `lib/`，本机连接服务 `lib/bridge/`，扩展 `browser-extension/`，测试 `tests/`。除 Node.js 24.5+ 与 Microsoft Edge 外不引入外部依赖（不加 npm 包、不调用 OpenCLI / Playwright / FFmpeg 等外部程序）。

- 文档、站点目录、网站库与路线提示（SKILL.md、references/、`data/catalog.json`、`data/experience/seeds.json`）直接在本仓库修改。
- 运行逻辑直接改 `lib/` 与 `scripts/` 并补测试（`node --test tests/`），在 CHANGELOG 写明。改了 `browser-extension/` 要提醒使用者在扩展管理页重新加载。

## 修改与验证

1. Fork 仓库，从当前主分支建立自己的修改分支。
2. 新站点先进 `references/site-library.json`（候选与实测状态），只有验证过的可复用路线才进 `opencli/catalog.json`；同步 references/platforms.md。路线候选不能标成实测通过。
3. 运行 `node scripts/luz-crawl.mjs doctor`（`ready` 为 true）与 `node scripts/luz-crawl.mjs check`（经验与路线提示格式、上限和隐私检查）。
4. 真实浏览器验证登录接续、目标内容、媒体/评论范围与标签关闭；输出用 `--out` 指向临时目录，不在技能目录里产生输出。在 PR 中分别说明自动检查与平台结果。

PR 描述写清问题、最终行为、验证结果和仍未验证的范围。不要提交个人 `data/memory/`、outputs、raw、node_modules、浏览器资料、`.env`、日志或密码。保留默认输出可移植，单次参数不应修改长期偏好。

## 浏览器与来源约束

每次搜索必须使用真实浏览器；只关闭自己的任务页。可读公开入口、登录、验证码、限流、付费限制与传输错误分别处理。不要加入验证码破解、Cookie 导出、付费绕过、任意 shell 或不受约束的浏览器脚本接口。

点赞、发送等外部写操作需要用户对具体目标和内容的明确授权；演示与回归测试使用本地 fixture。
