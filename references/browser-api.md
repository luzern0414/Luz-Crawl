# 浏览器操作 API

用于在一个任务页中执行有限的浏览器动作。所有动作返回 JSON。

`browser URL` 是一次调用，完成后关闭页面。需要跨命令保留输入与页面状态，用 [live 持续会话](browser-live.md)；两者共用动作 schema，`schema` 是字段与范围的机器入口。

## 调用

    node scripts/luz-crawl.mjs schema
    node scripts/luz-crawl.mjs browser "https://example.com" --file actions.json --out TASK_FOLDER

动作数组只能通过 --file 或 --steps 传入，单次 1–20 步。密码和验证码由用户手动完成。

## 动作

| action | 作用 |
|---|---|
| read | 读取可见文字和控件 |
| locate | 查找可见目标并返回选择器 |
| click | 点击唯一可见目标 |
| type | 向唯一输入框输入文字 |
| select | 按 option value 选择单个或多个选项 |
| check | 设置 checkbox/radio 状态；单选取消需选另一个选项 |
| press | 原生键盘操作；支持键见 schema |
| form | 填写表单字段 |
| submit | 提交唯一表单 |
| scroll | 滚动页面或容器 |
| wait_for | 等待文字、元素、值或 URL |
| wait | 等待指定毫秒数 |
| extract | 读取正文、评论和滚动位置 |
| screenshot | 保存视口或整页截图 |

先 read 或 locate 再操作。目标使用 selector 或 role/name，例如：

    {"action":"click","target":{"role":"button","name":"搜索"}}

click、type、form、submit、select、check、press 属于写操作，必须在用户对目标和内容的授权范围内并加 --allow-write。写操作结果未知时只读核验，不重复派发。click/type 支持 `method: dom|native`，默认 dom；press 为 native。作用域、能力限制、分页、表格行偏移和核验方式见 [持续会话](browser-live.md)。

wait_for/expect 可验证可见、隐藏、text/text_equals、value、checked 或 url，默认超时 8 秒，最多 30 秒。selector 与 role/name 二选一；简化语义定位不承诺完整可访问名称计算。form 先验证全部字段，但页面事件仍可能使后续字段失效，此时已经发生的写入不回滚，并标记待核验。

## 搜索表单

先定位输入框和提交控件，再填写并提交；用 expect 确认结果区域或 URL 已出现。表单动作完成不等于查询成功，必须读取结果页并确认候选。

## 批量

    node scripts/luz-crawl.mjs batch --file jobs.json --out TASK_FOLDER
    node scripts/luz-crawl.mjs batch --file jobs.json --concurrency 6 --out TASK_FOLDER

jobs.json 可以包含 URL、动作步骤或搜索任务：

    [
      {"id":"page","url":"https://example.com"},
      {"id":"q1","platform":"github","query":"crawler retry","read":1}
    ]

每批 1–500 项，默认并发 4，允许 1–6。每项独立保存结果；登录、验证、限流只停止对应站点。批量完成后，未取得正文或没有候选的项目会进行一次有限补采。

调用方限制单并发时显式 `--concurrency 1`，不启动子代理；live 会话自身始终串行，不用 batch 把同一页面步骤拆成并行任务。

## 返回状态

- completed：动作和显式 expect 完成，仍需检查目标内容。
- outcome_unknown：写操作结果未知，只允许核验。
- captured、partial、awaiting_user、blocked、failed 的含义见 [evidence.md](evidence.md)；awaiting_user 用返回的 task_id 执行 continue。

GitHub 结果中的 verified_sources 只统计已打开且确认正文的仓库；搜索卡片不代替 README。

## 节流

    node scripts/luz-crawl.mjs policy
    node scripts/luz-crawl.mjs policy --file policy.json

默认每项有操作和时间预算。遇到 429 或页面明确限流时保存冷却并停止该站，不用其他入口规避。
