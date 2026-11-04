# LuzCrawl

用真实浏览器搜索、阅读和保存网页证据。

## 功能

- 搜索网站、GitHub 开源项目、小红书笔记和抖音视频。
- 获取正文、作者、发布时间、互动数、媒体和已加载评论。
- 拆解关键词、补搜相关词、去重候选，并在详情失败时继续补采。
- 自适应详情和评论预算，保存 HTML、原始快照、结构化数据、字段来源和停止原因。
- 扩展显示连接、采集模式和查询/候选/详情/评论进度。

## 作用

GitHub 结果不足时补用 Bing `site:`、GitCN、HelloGitHub、Codeberg、Gitee；备用结果回到 GitHub 原仓库核验。小红书使用 `xhs`，抖音使用 `douyin`。公开页面优先，授权浏览器只在用户明确授权并指定已连接浏览器时使用。

搜索卡片只是候选，详情正文确认后才算有效结果。评论只代表本次加载条目，显示评论数不代表全部评论。

## 操作

需要 Node.js 24.5+、Microsoft Edge 和 `browser-extension/` 扩展。

1. 在 Edge 扩展管理页开启开发者模式，加载 `browser-extension/`。
2. 在仓库根目录运行：

   ```powershell
   node scripts/luz-crawl.mjs install
   node scripts/luz-crawl.mjs doctor
   ```

3. `doctor` 返回 `ready: true`（已连接可见 Edge）或 `silent_ready: true`（可启动静默 Edge）后，为每项需求建立一个外部任务目录：

   ```powershell
   $task = (node scripts/luz-crawl.mjs begin "主题" --out "D:\输出" --new | ConvertFrom-Json).folder
   node scripts/luz-crawl.mjs experience --query "关键词"
   node scripts/luz-crawl.mjs search github "browser automation" --read 0 --out $task
   node scripts/luz-crawl.mjs search xhs "家居收纳" --read 5 --comments --out $task
   node scripts/luz-crawl.mjs search douyin "露营装备" --read 5 --comments --out $task
   node scripts/luz-crawl.mjs capture "URL" --comments --out $task
   node scripts/luz-crawl.mjs summary $task
   ```

目录只有一种形状：输出根下是“序号_主题”任务文件夹，`raw\` 存放爬取的全部内容和机器记录（每个页面一个“序号_标题”子文件夹），总结 html（`序号_主题.html`）与 `raw\` 同级。旧目录用 `scripts/migrate_layout.py` 整理。

常用命令：`search` 搜索，`capture` 读取详情，`collect` 汇总主题，`batch` 批量读取，`download` 下载已观察媒体，`robots URL` 查看站点爬虫规则，`pending` 查看等待任务，`continue TASK_ID` 接续登录或验证。

为其他技能做前置检索用 `python -X utf8 scripts/crawl_preflight.py run|conclude|check`，说明见 [references/preflight.md](references/preflight.md)。采集前的合规核对见 [references/compliance.md](references/compliance.md)，来源评估见 [references/research-method.md](references/research-method.md)。

状态：`captured` 已确认正文，`partial` 有缺项，`awaiting_user` 等待手动处理，`blocked` 被限流或权限阻止，`failed` 执行失败。

不破解验证码、不绕过权限、不导出 Cookie 或令牌。写操作必须有明确授权并加 `--allow-write`。
