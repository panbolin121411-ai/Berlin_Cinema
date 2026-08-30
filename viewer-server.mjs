import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import {
  getCinemaInfo,
  getBroadcastInfo
} from "./livekit-service.mjs";

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

const app = express();

const PORT = 3000;

// 观众上报状态（绕开 WebRTC DataChannel，用 HTTP POST 上报，HTTP GET 拉取）
// Map<viewerId, {location, rtt, jitter, packetsLost, width, height, fps, lastSeen, client}>
const viewers = new Map();
const VIEWER_OFFLINE = 30000;    // 30 秒没上报 → 标记离线
const VIEWER_KEEP = 300000;      // 离线后保留 5 分钟（让控制中心显示"已离开 XX:XX"）

// 观众端日志目录
try { fs.mkdirSync(path.join(__dirname, "logs"), { recursive: true }); } catch {}

setInterval(() => {
  const now = Date.now();
  for (const [id, v] of viewers) {
    if (now - v.lastSeen > VIEWER_KEEP) viewers.delete(id);
  }
}, 30000);

// —— 服务端 IP 定位（不依赖观众端浏览器，iOS 也能拿到城市）——
// cloudflared 隧道转发真实客户端 IP 到 CF-Connecting-IP 头
const ipCityCache = new Map();   // ip -> { city, ts }，缓存 30 分钟

async function getCityByIp(ip) {
  if (!ip) return "未知";
  const cleanIp = String(ip).trim();
  // IPv6（含冒号）：GeoIP 对 IPv6 定位不可靠
  if (cleanIp.includes(":")) return "未知";
  // iOS mDNS / UUID 格式（如 1446235f-dda8-4f04-...local）→ 不是真实公网 IP
  if (cleanIp.includes(".local") || /^[0-9a-f-]{30,}$/i.test(cleanIp)) return "未知";
  if (cleanIp === "::1" || cleanIp === "127.0.0.1" || cleanIp === "::ffff:127.0.0.1" || cleanIp === "unknown" || cleanIp === "localhost") {
    return "本地";
  }
  const cached = ipCityCache.get(cleanIp);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.city;
  try {
    const r = await fetch(`http://ip-api.com/json/${cleanIp}?lang=zh-CN&fields=status,city,regionName`, {
      signal: AbortSignal.timeout(5000)
    });
    const d = await r.json();
    let city = "";
    if (d.status === "success") {
      city = String(d.city || d.regionName || "").replace(/市$/, "");
      if (city.length > 6) city = city.slice(0, 6);
    }
    if (city) {
      ipCityCache.set(cleanIp, { city, ts: Date.now() });
      return city;
    }
  } catch {}
  return "未知";
}

app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

// 版本探测：返回 viewer-server.mjs 文件修改时间（main.js 用它判断是否需要重启）
app.get("/api/version", (req, res) => {
  try {
    const mtime = fs.statSync(path.join(__dirname, "viewer-server.mjs")).mtimeMs;
    res.json({ ok: true, mtime });
  } catch {
    res.json({ ok: false });
  }
});

app.get(
  "/api/cinema",
  async (req, res) => {
    try {
      const info =
        await getCinemaInfo();

      res.json({
        success: true,
        ...info
      });

    } catch (error) {
      console.error(error);

      // 返回 200 + success:false：LiveKit 未配置/失败时服务本身仍在运行，
      // main.js 的 isPortServing 用状态码做存活探测（500 会被误判为"服务没起来"而反复重启）
      res.json({
        success: false,
        error:
          error.message
      });
    }
  }
);

app.get(
  "/control",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "control.html"
      )
    );
  }
);

// 观众端上报网络状态（POST），由控制中心轮询（GET）
app.post("/api/report", async (req, res) => {
  const body = req.body || {};
  const { viewerId } = body;
  if (!viewerId) {
    return res.status(400).json({ ok: false, error: "missing viewerId" });
  }

  // 观众端日志：独立写入 logs/viewer.log，供排查
  if (body.type === "log") {
    const line = `[${new Date().toISOString()}] [${body.level || "info"}] ${body.msg}\n`;
    try {
      fs.appendFileSync(path.join(__dirname, "logs", "viewer.log"), line);
      if (process.env.VIEWER_LOG_CONSOLE) console.log("[viewer-log]", line.trim());
    } catch {}
    return res.json({ ok: true });
  }

  // 统计：更新 viewers Map（服务端 IP 定位 + 上报时戳计算网络延迟）
  const { type, level, msg, t, ...stats } = body;
  // 网络延迟 = 服务端收到时间 - 观众端发送时间戳（绕开 iOS 无 WebRTC stats 的限制）
  let delay = 0;
  if (typeof t === "number" && t > 0) {
    delay = Date.now() - t;
    if (delay < 0) delay = 0;
  }
  // 真实客户端 IP（优先观众端上报的 IPv4 出口，GeoIP 对 IPv4 定位准确；IPv6 定位不可靠）
  const bodyIpv4 = String(body.ipv4 || "").trim();
  const ip = bodyIpv4 || req.headers["cf-connecting-ip"] || (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  // 定位：服务端按 IP 查城市（优先于观众端上报的 location）
  const location = await getCityByIp(ip);
  viewers.set(viewerId, { ...stats, location, delay, lastSeen: Date.now() });
  // 诊断：记录收到观众 stats（供排查观众席显示问题）
  try {
    fs.appendFileSync(
      path.join(__dirname, "logs", "viewer.log"),
      `[${new Date().toISOString()}] [stats] viewerId=${viewerId.slice(0, 8)} client=${stats.client || "?"} loc=${location} delay=${delay}ms ip=${String(ip).slice(0, 15)} ipv4=${bodyIpv4 || "-"}\n`
    );
  } catch {}
  res.json({ ok: true });
});

// 主动离场通知（观众端 pagehide/visibilitychange 立即调用，避免 30s 离线延迟）
app.post("/api/disconnect", (req, res) => {
  const { viewerId } = req.body || {};
  if (viewerId && viewers.has(viewerId)) {
    viewers.delete(viewerId);
    try {
      fs.appendFileSync(
        path.join(__dirname, "logs", "viewer.log"),
        `[${new Date().toISOString()}] [disconnect-active] viewerId=${viewerId.slice(0, 8)}\n`
      );
    } catch {}
  }
  res.json({ ok: true });
});

app.get("/api/viewers", (req, res) => {
  const now = Date.now();
  const out = [];
  for (const [id, v] of viewers) {
    // 只返回当前活跃的观众（lastSeen < 30s），已离开的不返回
    if (now - v.lastSeen > VIEWER_OFFLINE) continue;
    out.push({ viewerId: id, ...v, active: true });
  }
  // 诊断：记录拉取结果（供排查观众席显示问题）
  res.json({ ok: true, viewers: out });
});

app.get(
  "/api/broadcast",
  async (req, res) => {
    try {
      const info =
        await getBroadcastInfo();

      res.json({
        success: true,
        ...info
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        error:
          error.message
      });
    }
  }
);

app.get(
  "*splat",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

app.listen(
  PORT,
  "0.0.0.0",   // 全网监听：支持手机同 WiFi 局域网直连（http://电脑IP:3000）
  () => {
    console.log(
      `Berlin Cinema Viewer`
    );

    console.log(
      `http://localhost:${PORT}`
    );
  }
);