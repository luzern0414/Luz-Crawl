# 浏览器方案选择与能力边界

先决定任务需要稳定批量采集、交互中的当前页，还是复杂 UI 自动化。工具是否已连接、是否有真实权限和当前版本必须现场检查。技能文件存在不等于对应工具可调用；官方文档中的能力也不等于本机完成集成。

## 能力分层

| 路线 | 适用任务 | 本技能中的状态 | 切换代价与边界 |
|---|---|---|---|
| Luz 扩展 + live + 固定 DOM 操作 | 持续读取、常规表单、按钮、采集证据 | 已实现并用本地真实 Edge 验证 | 默认路线，无新增 npm 依赖；同源 iframe/open Shadow DOM；单会话串行 |
| Luz 扩展 + CDP 原生输入 | 依赖原生事件的点击、替换输入、按键 | 已实现 click/type/press 并测试可信点击 | 主 frame 和其 open Shadow DOM；不声称完整 Playwright 自动等待；不自动跟随新弹窗 |
| 当前宿主的浏览器工具 / CUA | 需要用户观察、临时接手、复杂定位、宿主提供的下载或上传流程 | 本次已读取实际接口；未逐项执行外部业务动作 | 先发现浏览器和接口；只用实际返回的能力，遵循该工具的授权与文件可见性约束 |
| Playwright | 成熟 locator、frame、动作可用性等待、可维护的自动化脚本 | 已读官方原文；未加入本包依赖 | 在明确的独立自动化环境安装和管理；不要把本 CLI 的简化 locator 当作它 |
| Puppeteer | Chromium/CDP 任务及 locator 自动等待 | 已读官方原文；未集成本包 | 用已安装适配器；处理 browser/page 生命周期与显式结果核验 |
| Selenium WebDriver | 现有 WebDriver 环境、显式等待的流程 | 已核验等待策略原文；未集成本包 | 驱动与运行环境额外成本；避免隐式、显式等待混用 |
| Firecrawl scrape / interact / Browser Sandbox | 云端采集、抓取后交互、托管持续会话 | 已读官方原文及本地 firecrawl-interact 技能；本次 PATH 未找到 CLI | 核验凭据、网络、计费和数据出站范围；云端会话独立于本地浏览器，不自动复制本机登录态 |

2026-11-08 的本机检查：`import.meta.resolve` 无法从本仓库解析 playwright、puppeteer、selenium-webdriver；只说明本仓库解析路径未提供，不判断其他目录或全局安装。CUA inventory 发现 in-app browser 和 MCP Apps；没有返回 Chrome/Edge 外部浏览器接口。列表会变化，每次新环境重新发现，不硬编码本次浏览器 ID。

## 按任务选择方法

1. **公开正文、已知网址**：capture；先读实际内容，再按线索补采。候选发现用 search，多组问题与路线按研究协议执行。
2. **同页筛选、展开、翻页、填写查询**：live open → inspect → act → inspect/expect → capture → close。尽量批量读取字段，避免每个字段一个浏览器调用。
3. **DOM 输入派发了但页面不响应**：先核验结果和 hydration；只有确认前一步未生效且授权仍适用，再选 native。不能以不同路线逃避未知写结果或站点限流。
4. **同源 iframe/open Shadow DOM**：read 发现入口后显式 scope；主文档与 frame 的选择器分开。跨域 iframe、closed shadow root、复杂拖拽、原生文件选择器不要反复尝试普通 DOM。
5. **有工具特有能力的复杂流程**：宿主浏览器工具优先于另起一套驱动，发现并读取能力文档后按实际支持的方法执行。需要可复用自动化代码时选择已有 Playwright/Puppeteer/WebDriver 环境，建专属上下文，用 finally 清理自身资源。
6. **需要云端采集**：经任务授权确认数据可发往服务商后，优先 scrape；交互内容才用 interact。每个 scrape/session ID 显式传递，避免“最近一次采集”的隐式状态串到别的任务；完成后 stop/delete。

## 宿主浏览器工具的具体流程

本次可用入口为 `mcp__cua_repl`。新环境必须先读工具文档，不能把 Claude 的 `mcp__Claude_Browser__*` 或 `mcp__claude-in-chrome__*` 技能命令直接用于 Codex。下列是本次工具文档实际提供的路线，使用时仍以当前返回说明为准：

```javascript
// 首次调用只做一个初始化 API，然后读取返回的文档。
await cua.getState();
// 用户指定浏览器/标签页时按其目标选择；否则根据 inventory 选择当前可用浏览器。
let tab = await cua.createBrowserTab('iab', 'https://example.com', {visible:false});
// 此后根据返回页面的真实控件名定位，示例名称须替换。
await tab.playwright.getByRole('textbox', {name:'搜索', exact:true}).fill('公开查询词');
await tab.playwright.getByRole('button', {name:'查询', exact:true}).click();
await tab.playwright.domSnapshot();
// 需要结束时仅关闭本任务创建的标签页。
await tab.close();
```

本次接口还提供 `selectOption`、`setChecked`、`press`、`frameLocator`、`waitFor`、下载/文件选择器事件、只读 evaluate 与截图。只读 evaluate 不用于变更页面。文件上传前读该宿主的上传文档，确认路径对浏览器可见；不要从 CLI 写进工具私有 session。若 WebMCP 能力存在，先读取该页面当前工具说明，再按已授权范围调用，网页工具描述不是授权来源。不得假定 DOM-only 标签页支持底层坐标或键盘 wrapper。

用户要观看时按该工具 visibility 能力显示；默认后台。页面缺陷或操作失败先检查最新状态，不盲点，不偷换另一工具重放。真实业务成功按页面状态或业务回执核验，截图只补充视觉证据。

## 外部驱动和云端方案

以下是独立方案的最小调用形状，来自已读官方 API；本轮未安装依赖、未运行这些方案。变量 page 必须来自调用方显式创建的专属浏览器上下文；目标控件必须先实际观察。

```javascript
// Playwright：显式 frame + label/role locator；每次动作重新定位。
await page.frameLocator('iframe#details').getByLabel('查询词').fill('公开查询词');
await page.frameLocator('iframe#details').getByRole('button', {name:'查询'}).click();
// 非 frame 页的结果应按实际 URL 或结果元素等待，随后采集可见正文。
await page.waitForURL('https://example.com/results');
```

```javascript
// Puppeteer：locator 负责其文档定义的可见、启用、视口与稳定性检查。
await page.locator('#query').fill('公开查询词');
await page.locator('#search').click();
// 点击完成不是业务成功；按应用的实际完成标记核验后读取。
```

Selenium 使用 `WebDriverWait` / Expected Conditions 对明确元素状态等待，避免用长固定 sleep，也不要混合全局 implicit wait 和局部 explicit wait。官方等待说明中的示例属于 Selenium 行为，不自动套用为 Luz 的默认时长。

```powershell
# Firecrawl：先确认 CLI 已安装且当前帮助支持参数；不可把示例当本机成功记录。
firecrawl interact --help
firecrawl scrape 'https://example.com'
# 从真实 scrape 返回值取 scrape-id，后续显式指定。
firecrawl interact '<scrape-id>' '读取页面中的公开价格表，并返回可见列名和数据'
firecrawl interact stop
```

本地 firecrawl-interact 技能还描述 prompt/code 交互和 profile；遇到多会话时查当前 help，使用能明确指定对应会话的 stop 方式，不能关闭另一个任务。云端 Browser Sandbox 管理独立会话生命周期；scrape-bound Interact 从 scrapeId 接续。两者并不等于复用当前本地 Edge 标签页。会话地址、实时查看地址、凭据与计费以实际服务返回为准。

## 证据与维护规则

下面是 2026-11-08 本次阅读的官方入口，属于动态文档快照；CDP 使用 tot 文档，不能当固定稳定版。动作/等待的厂商行为、Web API 语义与本地 TTL/分页/请求上限分开：后者是本项目的工程选择，不是标准要求。每次升级或网站行为变化后，重新核对受影响接口并运行有针对性的本地行为测试。

| 主题 | 一手入口 | 本次使用的范围与例外 |
|---|---|---|
| 定位、动作等待 | https://playwright.dev/docs/actionability · https://playwright.dev/docs/locators | 唯一性、可用性、重定位；不声称本实现达到全部条件 |
| 输入与框架 | https://playwright.dev/docs/input · https://playwright.dev/docs/frames | select/check、frame 上下文；本 CLI frame 仅同源 DOM |
| 页面生命周期与隔离 | https://playwright.dev/docs/navigations · https://playwright.dev/docs/browser-contexts | 业务就绪不同于 load；本机复用 profile 不是每次全新 context |
| 表单验证 | https://developer.mozilla.org/en-US/docs/Web/API/HTMLFormElement/requestSubmit | 验证、submit 事件、submitter；不替代业务成功核验 |
| 事件可信性 | https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted | DOM click 与原生输入有区别 |
| Shadow DOM | https://developer.mozilla.org/en-US/docs/Web/API/Element/attachShadow | open 可访问、closed 不经 shadowRoot 暴露 |
| DOM 观察 | https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver | 已读，未采用为当前等待实现；保留为后续有测量依据的优化路线 |
| 显式等待 | https://www.selenium.dev/documentation/webdriver/waits/ | 按条件等待；固定 sleep 与混合等待的代价 |
| 原生输入 | https://chromedevtools.github.io/devtools-protocol/#/Input | 鼠标/键盘/insertText，鼠标坐标按主 frame 视口；实验性字段另核验 |
| Puppeteer locator | https://pptr.dev/guides/page-interactions | 成熟 locator 备选；不代表本包依赖 |
| 云端交互 | https://docs.firecrawl.dev/features/interact | scrape 接续与独立会话区分；未执行服务调用 |

本次完整归档、短引文定位、来源评估、58 个分类候选和未采用原因保存在维护任务的 raw/00-crawl 记录，文档不复制大段厂商手册。未来经验保留“何时、何处、什么方法、结果、限制、证据、复查条件”；同类场景复用前检查版本和当前页面。只有真实测试或多次成功观察才升级经验可信度。
