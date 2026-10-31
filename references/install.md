# 安装与使用

## 安装

1. 安装 Node.js 24.5+ 和 Microsoft Edge。
2. 将仓库目录放入 Agent 的技能目录。
3. 在 Edge 扩展管理页开启开发者模式，加载仓库中的 browser-extension/。
4. 在技能目录运行：

       node scripts/luz-crawl.mjs install
       node scripts/luz-crawl.mjs doctor

doctor 返回 ready: true 且扩展已加载后即可使用。扩展文件更新后，在扩展管理页重新加载。

## 基本操作

每项需求使用一个输出目录，目录放在技能目录之外：

       node scripts/luz-crawl.mjs begin "主题" --out "D:\输出" --new
       node scripts/luz-crawl.mjs experience --query "关键词"
       node scripts/luz-crawl.mjs search github "关键词" --read 1 --out TASK_FOLDER
       node scripts/luz-crawl.mjs capture "https://example.com" --out TASK_FOLDER

采集结果包含 HTML、原始快照和可访问媒体。需要评论或媒体时加 --comments --download。

## 无头与登录

默认先使用独立无头 Edge；正文不足时在已连接的 Edge 中最小化补读；仍需要登录或验证时保存任务。

       node scripts/luz-crawl.mjs pending
       node scripts/luz-crawl.mjs continue TASK_ID
       node scripts/luz-crawl.mjs cancel TASK_ID

无头任务需要登录时先运行 headless-login TASK_ID，完成后再 continue TASK_ID。密码和验证码由用户手动输入。

## 保存目录

扩展弹窗可以保存默认输出目录，也可以运行：

       node scripts/luz-crawl.mjs remember --out "D:\输出" --format html

单次 --out 优先于默认目录。任务目录中保存搜索、详情、媒体、manifest.json 和 爬取总结.html。

## 浏览器动作

动作写入 actions.json 后运行：

       node scripts/luz-crawl.mjs browser "https://example.com" --file actions.json --out TASK_FOLDER

先 read 或 locate，再执行 click、type、form、submit。写操作必须有明确授权并加 --allow-write。动作定义见 [browser-api.md](browser-api.md)。

## 排错

- 断连：运行 doctor，检查扩展是否已加载；更新扩展后重新加载。
- partial：查看 limitations，确认页面是否需要展开、滚动或登录。
- awaiting_user：按结果中的 task_id 操作后运行 continue。
- blocked：停止该站，查看限流、权限或验证提示。
- failed：查看 error、stop_reason 和任务日志。
