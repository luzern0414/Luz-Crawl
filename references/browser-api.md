# 浏览器操作 API

用于在一个任务页中执行有限的浏览器动作。所有动作返回 JSON。

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
| form | 填写表单字段 |
| submit | 提交唯一表单 |
| scroll | 滚动页面或容器 |
| wait_for | 等待文字、元素、值或 URL |
| wait | 等待指定毫秒数 |
| extract | 读取正文、评论和滚动位置 |
| screenshot | 保存视口或整页截图 |

先 read 或 locate 再操作。目标使用 selector 或 role/name，例如：

    {"action":"click","target":{"role":"button","name":"搜索"}}

click、type、form、submit 属于写操作，必须得到用户对目标和内容的明确授权并加 --allow-write。写操作结果未知时只读核验，不重复派发。

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

## 返回状态

- completed：动作和显式 expect 完成，仍需检查目标内容。
- captured：正文已确认。
- partial：有内容但有缺项或预算耗尽。
- awaiting_user：等待登录或验证，使用返回的 task_id 执行 continue。
- blocked：限流、权限或目标缺失。
- failed：浏览器、传输或归档失败。
- outcome_unknown：写操作结果未知，只允许核验。

GitHub 结果中的 verified_sources 只统计已打开且确认正文的仓库；搜索卡片不代替 README。

## 节流

    node scripts/luz-crawl.mjs policy
    node scripts/luz-crawl.mjs policy --file policy.json

默认每项有操作和时间预算。遇到 429 或页面明确限流时保存冷却并停止该站，不用其他入口规避。
