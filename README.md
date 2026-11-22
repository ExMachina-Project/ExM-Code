# ExM Code

ExM Code 是 [ExMachina](https://github.com/ExMachina-Project/ExMachina) 的编程向延伸项目。沿用 Rust、Tokio、Axum、SQLite 和 React 19 / TypeScript / Vite / Ant Design，独立运行，不需要启动 ExMachina。产品由同一个 Agent Runtime 驱动桌面端、移动端和独立部署的 Web 客户端。

## 已实现

- **同一套 Runtime**：桌面经 Tauri IPC 直接调用，Web / 移动端经鉴权 API 调用。桌面不启动本地 HTTP 服务。
- **Goal / Spec / Plan / Code**：前三种只读，Code 可生成文件提案；模型工具和手动编辑都必须审阅后应用。
- **实时任务反馈**：展示每轮模型请求、工具目标和执行结果。当前流式输出的是执行进度，不是模型逐 token 文本。
- **真正取消任务**：中止正在等待的模型请求，释放并发名额，保存取消状态；Web 流连接断开也会取消所属任务。
- **会话管理**：重命名、置顶、归档/恢复、确认后删除、Markdown 导出与消息复制。删除会话不会撤销已应用的文件改动。
- **项目文件**：递归文件名/内容搜索、文件预览、按语言高亮的编辑器、新建文件草稿、差异审阅、过期提案冲突检测。
- **桌面项目**：首启选目录、最近项目列表、项目隔离的会话数据库。任务运行时禁止切换项目。
- **连接安全**：远程地址要求 HTTPS（回环地址可 HTTP）；服务器令牌按地址隔离且只保存在当前浏览器会话。更换模型地址不会沿用旧地址的 API Key，支持显式清除密钥。

## 快速开始：桌面端

需要稳定版 Rust、C 编译器（构建 SQLite）和 Node.js 22.18+。

```bash
npm ci
npm run desktop
```

首次启动选择要处理的项目，在模型设置中连接模型即可使用。桌面端直接运行本地 Agent，不需要另外启动服务。Web / 服务端开发则运行：

```bash
npm run serve -- /path/to/your/project
npm run dev # 另开终端
```

本地开发时另开终端运行 `npm run dev`，访问 <http://127.0.0.1:5174>；生产 Web 客户端通过 `VITE_EXM_CODE_SERVER_URL` 或连接页配置连接无 UI 的 Agent API。模型 Base URL 填到服务根路径（例如 `https://api.openai.com/v1`），不要附加 `/chat/completions`。回环地址上的 HTTP 模型可以不填密钥。

服务器部署示例（建议由 HTTPS 反向代理终止 TLS）：

```bash
export EXM_CODE_AUTH_TOKEN="$(openssl rand -hex 32)"
npm run serve -- /srv/my-project --listen 0.0.0.0 --port 4180 \
  --allowed-origin https://code.example.com \
  --allowed-origin http://tauri.localhost \
  --allowed-origin tauri://localhost
```

将 `webui/dist` 单独部署到静态托管服务；打开 Web 客户端后输入 Agent API 地址和访问令牌。令牌只保存在当前浏览器会话。桌面客户端本地运行 Agent；Android/iOS Tauri 客户端通过鉴权 API 连接服务器端工作区。

可用 `EXM_CODE_BASE_URL`、`EXM_CODE_MODEL` 和 `EXM_CODE_API_KEY` 在启动时配置。`.env.example` 仅作参考，不会自动加载。换项目时重新启动并传入目标目录；可用 `--listen`、`--port` 配置服务绑定。非回环部署必须使用至少 32 字符的 `--auth-token` / `EXM_CODE_AUTH_TOKEN`，并设置一个或多个 `--allowed-origin`。

## 工作方式

| 模式 | 用途 |
| --- | --- |
| **Goal** | 定义可衡量的目标、约束和验收条件。 |
| **Spec** | 整理需求、非目标、边界情况与验收标准。 |
| **Plan** | 将需求拆为有顺序的实施步骤、风险和验证项。 |
| **Code** | 检索、阅读代码并生成逐文件提案，确认后才写入工作区。 |

可以在同一任务中切换模式，例如 **Goal → Spec → Plan → Code**，继续使用已有对话。前三种模式只能读取和搜索文件，不能提交代码提案。右侧文件栏支持预览；如选择随消息附加文件，服务端会将文件内容发送给所配置的模型。模型的文件工具也会将读取结果回传给该模型。

会话和提案状态保存在运行 Agent 的项目数据目录下的 `.exm-code/sessions.sqlite3`。API Key 由运行 Agent 的设备或服务器保存，请勿将 `.exm-code/` 提交到版本控制。远程部署使用 Bearer Token 和显式 Web Origin；建议再放在 HTTPS 反向代理之后。首版无命令执行、自动测试、Git 写操作或多用户远程访问；请在自己的终端验证改动。

桌面模型配置位于应用数据目录 `model.json`，服务端配置位于私有数据目录 `config.json`；这些配置文件包含未加密密钥，在 Unix 上限制为 `0600`。Runtime 私有目录即使位于所选项目下，也不会被文件工具读取。旧版会话数据库首次打开时自动增补会话属性与消息状态字段，不清空已有记录。

## 开发与测试

```bash
npm run serve -- .   # 无 UI Agent API：127.0.0.1:4180
npm run dev         # 另开终端运行 Vite：127.0.0.1:5174
npm run check
npm test
npm run test:ui    # 需要 Chromium，可用 CHROMIUM_PATH 指定
npm run test:e2e   # 独立 Web 客户端 + 真实 Rust API + 本地模拟模型
npm run desktop    # Tauri 桌面端
npm run desktop:build
```

- `crates/exm-code-core`：模型调用循环、工作流权限、工作区工具与冲突检查。
- `crates/exm-code-runtime`：桌面和服务端共享的 SQLite 会话、项目、配置、任务取消、进度与审批逻辑。
- `crates/exm-code-server`：无 UI 的 HTTP/SSE 适配、认证和 Origin 白名单。
- `crates/exm-code-cli`：本地启动入口。
- `webui`：可独立部署的 Web 客户端，也作为 Tauri 桌面/移动客户端的前端界面。
- `desktop`：Tauri v2 原生壳，桌面端直接调用 Rust Runtime；可用 Tauri CLI 初始化 Android/iOS 客户端。

更详细的 API、部署与验证边界见 `docs/architecture.md` 和 `docs/deployment.md`。移动端目前具有原生入口、平台识别和远程连接界面；Android/iOS 安装包需要相应 SDK，不能以浏览器窄屏测试代替原生真机验证。
