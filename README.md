# Berlin Cinema 私人影院

一键把电脑屏幕和声音推流给手机 / iPad / 其他电脑观看的「私人影院」系统。屏幕共享在浏览器内完成，**无需 OBS**；公网观看走 cloudflared 临时隧道，复制链接即可分享。

## 它怎么工作

```
┌─ 主播电脑 ─────────────────────────────────┐
│ Electron 控制中心 (main.js)                  │
│  ├─ 自动启动本地服务 viewer-server.mjs        │
│  ├─ 创建 / 复用 LiveKit WHIP Ingress         │
│  ├─ 启动 cloudflared 临时隧道                │
│  └─ 浏览器屏幕共享推流 (getDisplayMedia)      │
└──────────────┬──────────────────────────────┘
               │ WHIP 直推 (H.264 / Opus)
        ┌──────▼──────┐        ┌──────────────┐
        │ LiveKit Cloud│ ◄──── │ 观众浏览器    │
        └─────────────┘        │ (index.html) │
                               └──────────────┘
```

- **主播端**：Electron 控制中心（网页界面，由本地 viewer-server 提供）+ 浏览器屏幕共享，无 OBS
- **观众端**：任意浏览器打开分享链接（支持 iPad / iPhone Safari）；同一 WiFi 也可直接访问 `http://电脑IP:3000`
- **隧道**：cloudflared 每次生成临时 `*.trycloudflare.com` 公网地址，复制即分享

## 功能

- **一键开播**：控制中心点「▶ 一键开播」，自动完成 本地服务 → WHIP Ingress → 公网隧道 → 屏幕共享
- **无需 OBS**：浏览器直接捕获屏幕 + 系统音频推流
- **高画质**：H.264 / 30fps / 最高 2560×1440 / 16Mbps；音频 48kHz 128kbps Opus
- **配置零依赖**：LiveKit 凭证在界面里填写，保存后本地记忆（`%APPDATA%\BerlinCinema\config.json`），不强制环境变量
- **观众席面板**：实时显示观众城市 / 网络延迟 / 播放分辨率，直播时一目了然
- **局域网直连**：手机与电脑同一 WiFi 时，可直接访问 `http://电脑IP:3000`，不消耗公网流量

## 技术栈

- Electron 37（控制中心 GUI）
- Express（本地 viewer-server，端口 3000）
- livekit-client / livekit-server-sdk（WebRTC 推流与观看）
- cloudflared（公网临时隧道）

## 使用（当前最实际的流程）

1. 安装依赖：`npm install`
2. 启动：`npm start`（或双击 `start-control.bat`）——控制中心会自动预启动本地服务
3. 点菜单「≡ → ⚙ 设置」，填写 LiveKit Cloud 的 URL / API Key / API Secret，点保存
4. 点「▶ 一键开播」，在系统弹窗中选择要共享的屏幕（勾选"分享系统音频"）
5. 等待上方出现 `https://xxx.trycloudflare.com` 公网地址，复制发给对方即可观看
6. 结束后点「■ 停止」关闭隧道（本地服务保持常驻，下次开播秒开）

> 没有 LiveKit 账号？免费注册 https://cloud.livekit.io（免费层 50GB 下行/月）。Ingress 使用 WHIP 直通（不转码），不消耗免费层的转码配额。

## 观众怎么看

- 手机 / iPad 直接打开你分享的链接，小屏卡片播放，点一下全屏
- 与电脑同一 WiFi 时，直接访问 `http://电脑IP:3000`（无需公网）
- 建议使用 Chrome / Edge / Safari 最新版

## 打包

```bash
npm run build
```

产物在 `dist/`（便携版单文件 exe，无需安装）。

打包前确认：

- `cloudflared/cloudflared.exe` 存在（下载：https://github.com/cloudflare/cloudflared/releases）
- 打包会把 `cloudflared/` 打进 `resources/`，运行时自动找到

## 运行日志（排查用）

- 开发模式：项目目录 `logs/`（app.log / viewer.log）
- 打包后（portable）：`%APPDATA%\BerlinCinema\logs\`（portable 临时解压目录重启即丢，故写入 userData）

## 注意

- **系统音频**：依赖默认输出设备的 loopback 支持。某些无线耳机芯片有缺陷，无法共享系统声音，需用 3.5mm 有线连接
- **浏览器**：屏幕共享推流建议用 Chrome / Edge；观众端 Safari（iOS 17+）可用
- **环境变量**：`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` 可作为 GUI 配置的兜底，但非必需
