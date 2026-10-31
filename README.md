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

3. `doctor` 返回 `ready: true` 后，为每项需求建立一个外部任务目录：

   ```powershell
   $task = (node scripts/luz-crawl.mjs begin "主题" --out "D:\输出" --new | ConvertFrom-Json).folder
   node scripts/luz-crawl.mjs experience --query "关键词"
   node scripts/luz-crawl.mjs search github "browser automation" --read 0 --out $task
   node scripts/luz-crawl.mjs search xhs "家居收纳" --read 5 --comments --out $task
   node scripts/luz-crawl.mjs search douyin "露营装备" --read 5 --comments --out $task
   node scripts/luz-crawl.mjs capture "URL" --comments --out $task
   node scripts/luz-crawl.mjs summary $task
   ```

常用命令：`search` 搜索，`capture` 读取详情，`collect` 汇总主题，`batch` 批量读取，`download` 下载已观察媒体，`pending` 查看等待任务，`continue TASK_ID` 接续登录或验证。

状态：`captured` 已确认正文，`partial` 有缺项，`awaiting_user` 等待手动处理，`blocked` 被限流或权限阻止，`failed` 执行失败。

不破解验证码、不绕过权限、不导出 Cookie 或令牌。写操作必须有明确授权并加 `--allow-write`。
