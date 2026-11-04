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
- `data/memory/browser-profile-edge*` 保存静默浏览器的登录状态，可能含能冒充账号的 Cookie 和请求头，不进仓库、不外发。
