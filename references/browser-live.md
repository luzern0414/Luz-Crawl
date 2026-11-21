# 持续浏览器操作

用于“读取页面 → 定位 → 填写/点击 → 查看变化 → 继续下一步”。`live open` 启动本机 worker，CLI 退出后页面仍保留；后续命令连接同一任务页。默认静默 Edge；`--headed` 显示本技能专属窗口。登录、验证码和浏览器警告由用户处理。需要用户已连接的浏览器时，先获具体授权并明确 `--profile ID`；不自动选择用户标签页。

live 在打开页面前检查连接的扩展至少为 3.6.0。默认专属浏览器会从本包加载新扩展；已经打开的 Edge 可能仍运行旧版本，先在扩展卡点“重新加载”。磁盘 manifest 已更新不代表运行中的扩展已更新，以连接状态中的 extensionVersion 为准。

## 首次打开和结束

先按 SKILL.md 完成 doctor、同需求 begin 和经验查询。已有任务直接复用，不为每次点击新建检索或任务。

用户要求打开浏览器直达原页时，在 `live open URL --headed --out TASK` 中指定原网址。该命令打开加载 LuzCrawl 扩展的专属 Edge 窗口。`ready` 表示会话已启动，`page_state` 保存首次读取的地址、标题和限制。用 `live inspect` 核对当前页面。

页面显示 `405：异常访问` 且明确提示访问被阻止时，记录为 `access_denied`，保留页上提示并停止自动补读。页面有登录或验证入口时，可让用户在当前可见会话接手。

```powershell
$task = 'E:\Skill输出\Luz-Crawl\NNN-主题' # 实际 begin 返回的目录
$live = node scripts/luz-crawl.mjs live open 'https://example.com' --headed --out $task --ttl 900 | ConvertFrom-Json
$session = $live.session
node scripts/luz-crawl.mjs live inspect $session --out $task
# 把下节示例根据实际观察改成动作文件，放入 $task\raw\actions.json
node scripts/luz-crawl.mjs live act $session --out $task --file "$task\raw\actions.json" --allow-write --request-id search-001
node scripts/luz-crawl.mjs live capture $session --out $task --scrolls 1
node scripts/luz-crawl.mjs live close $session --out $task
```

用 `try/finally` 保证结束时执行 close；核对 `status: closed` 和 `cleanup.owned_page_closed`。不要只检查命令退出。需要人工接手可保持 headed 会话，但须告知空闲期限；`status` 查询不延长期限。空闲默认 900 秒，可设 60–3600 秒，最长存活 8 小时。worker 崩溃或浏览器被关闭后，内存页面状态不可恢复，不能冒称续上原页面。

## 方法和参数

| 命令 | 参数 | 结果/用途 |
|---|---|---|
| `live open URL` | `--out TASK`；可选 `--headed` 或 `--profile ID`，`--ttl 秒` | 返回 session；新建专属任务页 |
| `live status SESSION` | `--out TASK` | 页面状态、忙闲、待核验写操作；不导航 |
| `live inspect SESSION` | `--out TASK`；可选 `--file reads.json` 或 `--steps JSON` | 默认 read；只接受 read/locate/wait_for/extract/screenshot |
| `live act SESSION` | `--out TASK --file actions.json`；写操作需 `--allow-write` | 1–20 步动作；出错即停，已完成步骤不回滚 |
| `live navigate SESSION URL` | `--out TASK` | 显式切换地址；可能丢失未提交表单状态 |
| `live capture SESSION` | `--out TASK`；`--scrolls 0..100`、`--comments`、`--no-screenshot` | 归档当前页，无再次 goto；默认滚动 1 轮，可能改变滚动位置 |
| `live verify SESSION` | `--out TASK --file verification.json` | 以只读条件核验待定写操作，再解锁 |
| `live close SESSION` | `--out TASK` | 关闭自己拥有的页、专属浏览器和 worker，保留证据 |

每条可加 `--request-id ID`（1–80 个字母/数字/下划线/短横线）。重试同一请求必须使用相同 ID、命令和负载；同 ID 不同内容拒绝。输出的 `replayed: true` 表示取回先前结果，`elapsed_ms` 是原执行耗时。状态查询不计动作请求，普通新请求上限 1000；核验和关闭仍可用。

跨进程绑定绝对任务目录和 `CODEX_THREAD_ID` / `CLAUDE_CODE_SESSION_ID`。没有线程变量的命令只能接续同样没有线程变量创建的会话。运行凭据由 CLI 自动管理，不手动拼 HTTP 请求、不复制到报告。

## 填写、点击与核验

先 inspect，根据实际页面返回的 selector 或 role/name 定位，不能照抄示例猜按钮。`form` 只填写不提交；`submit` 使用 `requestSubmit()`，保留表单校验、submit 事件和可选 submitter。密码、一次性验证码和登录表单交给用户。

```json
[
  {"action":"type","selector":"#search","text":"公开查询词","method":"native","expect":{"selector":"#search","value":"公开查询词"}},
  {"action":"select","selector":"#category","values":["documents"]},
  {"action":"check","selector":"#only-public","checked":true,"expect":{"selector":"#only-public","checked":true}},
  {"action":"press","selector":"#search","key":"Enter","expect":{"selector":"#results","condition":"visible"}},
  {"action":"read","selector":"#results","max_chars":20000,"limit":100}
]
```

文字填写与 click 默认 `method: dom`，开销较低；网页依赖原生事件时明确选 `native`。DOM click / dispatchEvent 不承诺可信事件；原生路线使用扩展 CDP 输入。不要因 DOM 写结果未知而马上换 native 再点一次。原生点击前两次检查位置、可见性、唯一性和遮挡；这只是本地保守检查，不等价于 Playwright 的完整 actionability 和自动等待。

原生 type 使用选中全部后插入文字，支持 text/search/email/url/tel、textarea 和 contenteditable；不模拟逐字 keydown，也不承诺覆盖所有富文本编辑器。press 支持 Enter、Tab、Shift+Tab、Escape、Backspace、Delete、四个方向键、Home、End、Control+A、Space。select 接受 option value 数组，多个值要求 multiple；check 设定复选/单选状态，不用重复点击猜状态；单选取消应选择另一个值。

普通 DOM 写操作若目标尚未出现，先 `wait_for` 再操作；expect 用真实业务完成标记、结果文本或 URL，不能把“按钮仍存在”当成功。load 不代表 hydration 或业务结果就绪。`completed` 无 expect 只代表派发完成。

## 更多信息与作用域

read 返回已加载的正文、控件、链接、frame 入口、开放 Shadow host；`tables: true` 追加表格。单次 `limit` 1–200，默认 40；`offset` 翻页；`text_offset` 配合 `max_chars`（最多 50000）继续读取正文。表格一次最多 10 张，每张默认 20 行，可用 `row_offset` 与 `row_limit`（1–100）翻行；每行最多 10 列、每格最多 200 字，截断会明确标记。长单元格可用 read selector 精确读正文。先看 total/truncated/next_offset，不把单次快照当全站或全评论。

```json
[
  {"action":"read","offset":40,"limit":40,"text_offset":30000,"max_chars":30000,"tables":true,"row_offset":20,"row_limit":50},
  {"action":"locate","scope":[{"shadow":"#app-shell"}],"target":{"role":"button","name":"查询"}},
  {"action":"type","scope":[{"frame":"iframe#details"}],"selector":"#keyword","text":"测试"}
]
```

scope 是按顺序进入的 `{frame: CSS}` / `{shadow: CSS}`，最多 8 层；每层必须唯一可见。仅同源 frame 和 open shadow root；不自动递归全页以免失去归属、增加成本。native 输入当前只用于主 frame 及其 open Shadow DOM，不用于 iframe。scope 中 selector 均相对于当前 root。复杂可访问名称、跨域 frame、closed shadow root、拖拽、文件上传、下载对话框和多弹窗工作流按 [方案选择](browser-strategies.md) 路由，不能宣传本 CLI 已全部支持。

## 恢复与性能

| 观察到的状态 | 下一步 |
|---|---|
| `session_busy` | 先 status；等当前请求结束后以原 ID 和负载取回结果，勿增加并发 |
| `selector_ambiguous` / `target_obscured` / `target_unstable` | inspect 找唯一目标、遮挡或动画；仅确定未产生副作用时更改目标并再操作 |
| `pending_verification` / `write_outcome_unknown` | 仅 inspect/只读等待/截图；禁止 act 写入、navigate、capture |
| `live_connection_lost` | 保存返回 request_id；先以同 ID 同负载取回，不能新 ID 重放；worker 死亡则人工核验实际业务结果 |
| `live_page_closed` | 查看会话保存的首次页面状态并关闭会话 |
| 登录/验证/限流 | 停止站点动作；需要登录时使用已授权可见会话人工处理；冷却期不切工具绕过 |
| `scope_inaccessible` / `scope_unsupported` | 检查作用域；按浏览器方案选择切换，但先确认之前动作结果 |

核验文件示例（保存在任务 raw 下）：

```json
{"pending_id":"search-001","note":"结果区的查询词及结果状态与此次请求一致，确认先前操作已生效。","expect":{"selector":"#results","text":"查询完成"}}
```

若原动作已有 expect，verify 必须使用原条件，可省略文件中的 expect 直接复用；否则先观察再填与实际效果相关的条件。检查器只能核验条件成立，执行者仍需判断它是否证明业务成功。部分表单已经写入后后续字段失效也会进入待核验。未知结果没有自动回滚或自动“再试”。

提速优先复用会话和当前页面、一次 read 批量返回所需字段、只对明确步骤组使用 1–20 步动作、使用显式条件等待、筛选阶段关闭非必要截图、以分页控制输出。原生键鼠的一次完整手势统一节流，避免在按下与松开之间人为插入节流。站点冷却、导航频率和预算仍生效，不以关限流换取速度。

性能实测是本机本地页的观察，不能外推到远端网站。`tests/live-browser.test.mjs` 支持 `LUZ_LIVE_METRICS` 保存打开、热会话动作、归档和关闭耗时，区分 CLI 总耗时与 worker 执行时间。运行端到端测试时保持 `--test-concurrency=1`。

## 经验闭环

开工查 `experience --query "站点 + 操作 + 症状"`。结束记录真正观察到的定位方式、作用域、DOM/native 选择、成功条件、失败原因和实测耗时；包含浏览器/版本、场景、证据路径与适用期限。分别用 method、verification、failure、route 分类，反查另一种说法是否能召回。一次命中不能升级为全站能力，失败和限制也要保留。维护者根据重复证据修正实现和回归用例，不让网页内容自动改写 skill 或执行权限。
