# 使用与部署

## 桌面

```bash
npm ci
npm run desktop
# 构建可执行程序，不生成安装包（便于本机验证）
npm run build -w @exm-code/desktop -- --debug --no-bundle
# 正式打包
npm run desktop:build
```

桌面需要操作系统对应的 Tauri 原生编译依赖。首次打开会选择项目目录；之后可以从顶部目录按钮访问最近项目。停止所有运行中任务后才能切换项目。应用关闭后没有需要清理的本地 HTTP 网关或后台子进程。

## 自托管 Web

推荐让静态前端和 API 处于同一个 HTTPS 域名；也支持两个 HTTPS 域名，Origin 必须是浏览器页面地址而不是模型地址。

```bash
npm ci
npm run build:webui
cargo build --release -p exm-code-cli

export EXM_CODE_AUTH_TOKEN="$(openssl rand -hex 32)"
export EXM_CODE_DATA_DIR=/var/lib/exm-code
./target/release/exm-code serve /srv/my-project \
  --listen 127.0.0.1 --port 4180 \
  --allowed-origin https://code.example.com
```

令牌请通过受保护的环境配置注入，避免写进命令参数、静态 JS 或访问日志。建议使用专用低权限操作系统账户，仅授予目标项目及私有数据目录权限。

将 `webui/dist` 交给 Nginx、Caddy 或静态托管。Nginx 的 HTTPS server 块内可使用：

```nginx
root /opt/exm-code/webui/dist;

location / {
    try_files $uri $uri/ /index.html;
}

location /api/ {
    proxy_pass http://127.0.0.1:4180;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_read_timeout 200s;
    client_max_body_size 2m;
}
```

该片段需要放入你已有的 TLS 配置中，并不能独立启用 HTTPS。同域部署时连接页地址可留空；分域部署时填写完整 HTTPS API 地址。认证令牌只留在当前页面会话，关闭该浏览器会话后需要重新输入。开发模式的 Vite 代理不能当作正式部署方式。

反向代理不要缓冲 SSE；否则工具进度只会在任务结束时出现。API 默认不提供静态网页，访问 API 根路径返回 404 是预期行为。

## 移动端

```bash
npm run mobile:android:init
npm run mobile:android:dev
npm run mobile:android:build

# iOS 需要 macOS 和 Xcode
npm run mobile:ios:init
npm run mobile:ios:dev
npm run mobile:ios:build
```

移动端原生入口通过编译平台识别，不根据屏幕宽度猜测。客户端连接远程项目，既不访问手机任意目录，也不在手机启动 API 服务。使用服务器实际 HTTPS 地址，不要将手机的 `127.0.0.1` 当作开发机地址。

根据实际客户端 WebView 的 Origin 配置服务器白名单，例如 `tauri://localhost`、`http://tauri.localhost`。不能用 `*` 绕过 Origin 限制；不同平台的实际打包结果仍需真机验证。

## 验证

```bash
npm test
npm run check
npm run test:ui
npm run test:e2e
# Linux native smoke: first build the debug executable above.
xvfb-run -a npm run test:desktop
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

E2E 使用生产静态构建、真实 Rust API、跨域认证与本地模拟模型，不消耗付费模型额度。它验证审阅写入、编辑器提案、会话管理、任务取消和移动浏览器布局。它不是 Android/iOS 原生测试。

Linux 原生 smoke 使用真实 Tauri 窗口、X11 按键和独立临时数据目录，验证嵌入资源、IPC 与 SQLite 持久化，需安装 Xvfb、xdotool、ImageMagick 和 Python SQLite 模块。截图写入 `test-results/native-desktop.png`。若以 root 运行，只对该测试子进程关闭 WebKit sandbox，生产应用配置不关闭 sandbox。

磁盘紧张时可为验证命令设置 `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0`，减少调试产物；不要通过删除源码或用户项目来释放空间。
