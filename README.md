# Berlin Cinema 私人影院

一键共享屏幕，把电脑画面和声音推流给手机 / iPad / 其他电脑观看的「私人影院」系统。

## 功能

- **一键开播**：Electron 控制中心点一下，自动启动本地服务 + 公网隧道 + 屏幕共享推流
- **屏幕共享**：浏览器直接捕获屏幕（含系统音频），无需 OBS
- **高画质**：2560×1440 @ 30fps + H.264 + 12Mbps，音频 48kHz 立体声 128kbps Opus
- **公网观看**：cloudflared 临时隧道生成公网网址，复制发给对方即可观看
- **不依赖环境变量**：LiveKit 配置在 GUI 里填写，本地记忆，换机器只需填一次
- **观众端**：小屏卡片播放 + 全屏，支持 iPad / iPhone Safari

## 技术栈

- Electron 37（控制中心 GUI）
- Express（本地服务）
- livekit-client / livekit-server-sdk（WebRTC 推流与观看）
- cloudflared（公网隧道）

## 使用

1. 安装依赖：`npm install`
2. 启动：`npm start`（或双击 `start-control.bat`）
3. 点「⚙ 设置」填写 LiveKit Cloud 配置（URL / API Key / API Secret）
4. 点「一键开播」→ 选择屏幕共享 → 复制公网网址发给对方

## 打包

```bash
npm run build
```

产物在 `dist/`（便携版单文件 exe）。打包前需确保 `cloudflared/` 目录下有 `cloudflared.exe`（下载地址：https://github.com/cloudflare/cloudflared/releases）。

## 注意

- 需要 LiveKit Cloud 账号（免费层：50GB 下行/月）
- 系统音频共享依赖默认输出设备的 loopback 支持（某些无线耳机芯片有缺陷，需用 3.5mm 有线连接）
