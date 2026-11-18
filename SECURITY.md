# 安全报告

浏览器扩展拥有网页读取和调试权限；本地服务只在本机运行，个人状态和归档保存在本机。

发现可能导致越权访问、文件越权写入、凭据泄露或私有服务访问的问题，请在仓库 Issues 提交不含利用细节和敏感数据的报告。不要公开 Cookie、令牌、浏览器资料或私人正文。

站点拒绝、登录限制、字段隐藏和临时网络错误属于功能问题，请附公开 URL、落地 URL、命令、status 和 stop_reason。

## 扩展权限

扩展为 Manifest V3，页面只允许本包脚本（`script-src 'self'`），不加载远程代码，不使用 `eval`，不向网页暴露资源。权限只保留代码实际调用的部分，由 `tests/package-metadata.test.mjs` 核对。

| 权限 | 用途 |
|---|---|
| `debugger`、`tabs`、`tabGroups` | 在本任务创建的页面里读取、导航和分组 |
| `<all_urls>`（host_permissions） | 可采集任意公开网址；这是最大的权限，只在用户指定网址时使用 |
| `declarativeNetRequestWithHostAccess` | 下载媒体时为扩展发出的请求设置来源页作为 Referer，任务结束即撤销 |
| `downloads`、`downloads.ui` | 通过浏览器保存已观察到的媒体，并在下载时隐藏下载面板 |
| `alarms`、`storage` | 后台保活；本机输出偏好和任务日志 |

扩展不读取 Cookie：`cookies` 权限和对应命令已移除；`activeTab` 与 `<all_urls>` 重复，也已移除。

## 本机连接服务

服务监听 127.0.0.1，要求 `x-luzcrawl` 请求头，并拒绝带网页来源的请求；扩展以 `chrome-extension://` 来源连接。已知的剩余风险：

- 服务按来源前缀放行，不固定 LuzCrawl 扩展的 ID，本机另一个已安装的扩展或本机进程理论上也能向它发命令。只在可信的本机环境运行，不在共享账户或远程桌面里常驻。
- `lib/bridge/stealth.mjs` 能隐藏 `navigator.webdriver` 等自动化标志，默认不注入；只有用户授权的一次运行才设置环境变量 `LUZ_STEALTH=1`。取舍见 `references/compliance.md`。
- 输出根下 `_browser-profile\edge*`（默认 `E:\Skill输出\Luz-Crawl\_browser-profile\`，可用 `LUZ_CRAWL_PROFILES` 改）保存静默浏览器的登录状态，可能含能冒充账号的 Cookie 和请求头，不进仓库、不外发。

## 持续会话

`live` 的控制服务绑定随机 loopback 端口，校验随机 Bearer 凭据、Host、Origin、任务和会话绑定。运行凭据仅保存在当前用户目录 `.luz-crawl/live/`，不写入 raw、命令行或返回值；正常关闭后删除凭据。POSIX 使用私有文件权限，Windows 依赖用户目录 ACL；这不是对同一系统账户下其他进程的安全隔离。

请求先登记指纹再派发；相同 ID 与负载只返回原结果，不重复执行。未知写结果暂停后续写操作；结果持久化失败时关闭会话。操作日志不保存动作请求中的文字值，但页面观察、URL 和结果可能含页面显示的数据，按任务范围保存。空闲默认 900 秒、可设 60–3600 秒，最长 8 小时；每会话单条动作请求执行，最多 1000 个新请求，核验和关闭仍可用。浏览器资料仍是复用的专属 profile，不承诺每次全新 Cookie 上下文。
