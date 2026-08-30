const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  clipboard,
  desktopCapturer,
  session
} = require("electron");

const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

let mainWindow = null;
let cinemaProcess = null;
let cloudflaredProcess = null;
let publicUrl = "";
let cloudflaredBuffer = "";

const ROOT = __dirname;

// LiveKit 地址兼容归一化：
// 服务端 SDK (LiveKitAPI) 需要 http(s)://，客户端需要 ws(s)://
function normalizeHttpUrl(url) {
  return String(url || "")
    .trim()
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://")
    .replace(/\/+$/, "");
}

function normalizeWsUrl(url) {
  return String(url || "")
    .trim()
    .replace(/^https:\/\//i, "wss://")
    .replace(/^http:\/\//i, "ws://")
    .replace(/\/+$/, "");
}

// LiveKit 配置持久化（优先读配置文件，回退环境变量）
// 统一 app 名，确保开发态与打包态共用同一份配置
app.setName("BerlinCinema");

const CONFIG_FILE = path.join(
  app.getPath("userData"),
  "config.json"
);

function loadSavedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    }
  } catch {}
  return {};
}

// 持久化日志（控制中心 + 关键事件，文件位于 F:\Cinema\logs\app.log）
const LOG_FILE = path.join(ROOT, "logs", "app.log");

function appendLogFile(level, tag, message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const line = `[${new Date().toISOString()}] [${level || "info"}] [${tag || ""}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

function saveConfigToDisk(data) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

const _saved = loadSavedConfig();

const CONFIG = {
  port: 3000,
  cinemaUrl: "http://localhost:3000",
  // 打包后 cloudflared 在 resources/cloudflared，开发时在项目根目录
  cloudflared: app.isPackaged
    ? path.join(process.resourcesPath, "cloudflared", "cloudflared.exe")
    : path.join(ROOT, "cloudflared", "cloudflared.exe"),
  serverFile: path.join(ROOT, "viewer-server.mjs"),

  livekitUrl: normalizeHttpUrl(
    _saved.livekitUrl || process.env.LIVEKIT_URL || ""
  ),
  apiKey: String(_saved.apiKey || process.env.LIVEKIT_API_KEY || "").trim(),
  apiSecret: String(_saved.apiSecret || process.env.LIVEKIT_API_SECRET || "").trim(),

  roomName: "berlin-cinema",
  // 用 WHIP 直通推流（不转码），免费层不消耗 60 分钟/月的转码配额
  ingressName: "Berlin Cinema WHIP",
  participantIdentity: "obs-whip",
  participantName: "Berlin Cinema WHIP"
};

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function log(message, type = "info") {
  send("log", {
    time: new Date().toLocaleTimeString(),
    message,
    type
  });
}

function envCheck() {
  return {
    livekit: !!(
      CONFIG.livekitUrl &&
      CONFIG.apiKey &&
      CONFIG.apiSecret
    ),
    cloudflared: fs.existsSync(CONFIG.cloudflared),
    node: true
  };
}

// 用 HTTP 探测判断 viewer-server 是否在跑（无副作用，比 createServer+listen 可靠）
async function isPortServing(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/cinema`, {
      signal: AbortSignal.timeout(1500)
    });
    return r.status === 200;
  } catch {
    return false;
  }
}

// 杀掉监听指定端口的进程（Windows：netstat 找 PID + taskkill）
function killPortProcess(port) {
  try {
    const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
    const pids = new Set();
    // 精确匹配本地监听地址 ":port"（后跟空白），避免误杀监听 30000/30001 等端口的进程
    const portRe = new RegExp(":" + port + "\\s");
    out.stdout.split("\n").forEach(line => {
      if (portRe.test(line) && line.includes("LISTENING")) {
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
    });
    pids.forEach(pid => {
      try {
        spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true });
        log(`已结束占用 3000 端口的旧进程 (PID ${pid})`, "warning");
      } catch {}
    });
    return pids.size > 0;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 探测 3000 端口的 viewer-server 是否是最新代码（对比 viewer-server.mjs 文件 mtime）
// mtime 一致 = 代码没改 = 直接复用（秒开）；mtime 不同 = 代码改了 = 杀重启加载新代码
async function isNewViewerServer() {
  try {
    const expected = fs.statSync(CONFIG.serverFile).mtimeMs;
    const r = await fetch(`http://127.0.0.1:${CONFIG.port || 3000}/api/version`, {
      signal: AbortSignal.timeout(1500)
    });
    const d = await r.json();
    return d.ok && Math.abs(d.mtime - expected) < 1000;
  } catch {
    return false;
  }
}

async function ensureViewerServerRunning() {
  // 已经在跑 + 是最新代码 → 复用
  if (await isPortServing(CONFIG.port) && await isNewViewerServer()) {
    log("预启动：viewer-server 已是最新代码，复用", "success");
    return true;
  }
  // 在跑但是旧代码（无 /api/version 路由）→ 杀掉重启加载新代码
  if (await isPortServing(CONFIG.port)) {
    log("预启动：旧版 viewer-server（无 /api/version 路由），重启加载最新代码", "warning");
    killPortProcess(CONFIG.port);
    await sleep(1000);
  }
  // 没在跑或刚杀掉：启动
  if (cinemaProcess) {
    cinemaProcess = null;  // 引用失效，等 exit 事件
  }
  if (!fs.existsSync(CONFIG.serverFile)) {
    log(`没有找到 ${CONFIG.serverFile}，无法预启动影院服务`, "error");
    return false;
  }
  log("预启动本地影院服务...");
  spawnViewerServerProcess();
  // 短超时（10 秒）等待就绪
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isPortServing(CONFIG.port)) {
      log("预启动：viewer-server 已就绪", "success");
      return true;
    }
  }
  log("预启动：viewer-server 启动慢（10s 后未就绪，不影响开播）", "warning");
  return true;
}

// 轮询等待 viewer-server 就绪（最多 attempts 次，每次间隔 500ms）
async function waitForPortServing(attempts) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isPortServing(CONFIG.port)) return true;
  }
  return false;
}

async function startCinemaServer() {
  // 已在跑（预启动过）→ 直接复用，秒开
  if (await isPortServing(CONFIG.port)) {
    // 在跑但是旧代码（无 /api/version 路由）→ 杀掉重启加载新代码，
    // 避免控制中心加载到旧版页面/旧接口
    if (!(await isNewViewerServer())) {
      log("本地影院服务为旧版本，重启加载最新代码", "warning");
      killPortProcess(CONFIG.port);
      await sleep(1000);
      if (cinemaProcess) cinemaProcess = null;  // 引用失效，等 exit 事件
      spawnViewerServerProcess();
      if (await waitForPortServing(10)) {
        log("本地影院服务重启成功", "success");
        return true;
      }
      log("本地影院服务重启慢（不阻塞开播）", "warning");
      return true;
    }
    log("本地影院服务已就绪", "success");
    return true;
  }
  // 没在跑：启动
  if (cinemaProcess) {
    cinemaProcess = null;  // 引用失效，等 exit 事件
  }
  if (!fs.existsSync(CONFIG.serverFile)) {
    log(`没有找到 ${CONFIG.serverFile}`, "error");
    return true;  // 不阻塞开播（推流不依赖 viewer-server）
  }
  log("启动本地影院服务...");
  spawnViewerServerProcess();
  // 短超时（5 秒）等待启动，**不阻塞开播**——超时也不 return false
  if (await waitForPortServing(10)) {
    log("本地影院服务启动成功", "success");
    return true;
  }
  log("本地影院服务启动慢（不阻塞开播，5 秒后仍未就绪）", "warning");
  return true;  // 不阻塞开播——viewer-server 启动慢不影响推流
}

// 实际 spawn viewer-server 的辅助函数（预启动和 startCinemaServer 共用）
function spawnViewerServerProcess() {
  if (cinemaProcess) return;  // 已经在跑
  cinemaProcess = spawn(
    process.execPath,
    [CONFIG.serverFile],
    {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        LIVEKIT_URL: CONFIG.livekitUrl,
        LIVEKIT_API_KEY: CONFIG.apiKey,
        LIVEKIT_API_SECRET: CONFIG.apiSecret
      }
    }
  );
  cinemaProcess.stdout.on("data", data => {
    const text = data.toString().trim();
    if (text) log(text);
  });
  cinemaProcess.stderr.on("data", data => {
    const text = data.toString().trim();
    if (text) log(text, "warning");
  });
  const child = cinemaProcess;
  // spawn 失败必须有 error 监听，否则触发 uncaught exception 导致主进程崩溃
  child.on("error", err => {
    if (cinemaProcess === child) cinemaProcess = null;
    log("影院 Node 服务启动失败：" + (err && err.message || err), "error");
    send("status");
  });
  child.on("exit", code => {
    // 只在引用仍指向该子进程时清空，避免旧进程晚到的 exit 误清新进程引用
    if (cinemaProcess === child) cinemaProcess = null;
    log(`影院 Node 服务退出，代码：${code}`, "warning");
    send("status");
  });
}

async function getLiveKitAPI() {
  if (!CONFIG.livekitUrl || !CONFIG.apiKey || !CONFIG.apiSecret) {
    throw new Error(
      "LiveKit 环境变量不存在：LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET"
    );
  }

  const { LiveKitAPI } = await import("livekit-server-sdk");

  return new LiveKitAPI({
    host: CONFIG.livekitUrl,
    apiKey: CONFIG.apiKey,
    secret: CONFIG.apiSecret
  });
}

// 主播凭证（浏览器内屏幕共享推流用）：允许发布
async function getBroadcasterToken() {
  const { AccessToken } = await import("livekit-server-sdk");

  const token = new AccessToken(
    CONFIG.apiKey,
    CONFIG.apiSecret,
    {
      identity: "broadcaster",
      name: "Berlin Cinema Broadcaster",
      ttl: "12h"
    }
  );

  token.addGrant({
    roomJoin: true,
    room: CONFIG.roomName,
    canPublish: true,
    canSubscribe: true
  });

  return await token.toJwt();
}

async function getIngress() {
  const api = await getLiveKitAPI();

  const list = await api.ingress.listIngress({
    roomName: CONFIG.roomName
  });

  let ingress = list.find(
    x => x.name === CONFIG.ingressName
  );

  if (!ingress && list.length > 0) {
    ingress = list[0];
  }

  if (!ingress) {
    log("没有找到 Ingress，正在自动创建...", "warning");

    const { IngressInput } =
      await import("livekit-server-sdk");

    ingress = await api.ingress.createIngress(
      IngressInput.WHIP_INPUT,
      {
        name: CONFIG.ingressName,
        roomName: CONFIG.roomName,
        participantIdentity: CONFIG.participantIdentity,
        participantName: CONFIG.participantName,
        // WHIP 直通，不转码，免费层不消耗转码配额
        enableTranscoding: false
      }
    );

    log("LiveKit Ingress 创建成功", "success");
  }

  return ingress;
}

async function getLiveKitStatus() {
  try {
    const api = await getLiveKitAPI();

    const rooms = await api.room.listRooms();

    const room = rooms.find(
      x => x.name === CONFIG.roomName
    );

    let ingress = null;

    try {
      ingress = await getIngress();
    } catch (e) {
      log(`读取 Ingress 失败：${e.message}`, "warning");
    }

    return {
      connected: true,
      roomExists: !!room,
      participants: room ? Number(room.numParticipants) : 0,
      publishers: room ? Number(room.numPublishers) : 0,
      ingress: ingress ? {
        id: ingress.ingressId,
        name: ingress.name,
        streamKey: ingress.streamKey,
        url: ingress.url,
        roomName: ingress.roomName,
        status: ingress.state?.status || "UNKNOWN",
        width: ingress.state?.video?.width || 0,
        height: ingress.state?.video?.height || 0,
        framerate: ingress.state?.video?.framerate || 0,
        bitrate: ingress.state?.video?.averageBitrate || 0,
        audio: ingress.state?.audio?.mimeType || ""
      } : null
    };

  } catch (error) {
    return {
      connected: false,
      error: error.message
    };
  }
}

function startCloudflared() {
  if (cloudflaredProcess) {
    log("Cloudflare Tunnel 已经运行", "warning");
    return;
  }

  if (!fs.existsSync(CONFIG.cloudflared)) {
    log(`找不到 cloudflared：${CONFIG.cloudflared}`, "error");
    return;
  }

  publicUrl = "";
  cloudflaredBuffer = "";

  log("正在启动 Cloudflare Tunnel...");

  cloudflaredProcess = spawn(
    CONFIG.cloudflared,
    ["tunnel", "--url", CONFIG.cinemaUrl, "--no-autoupdate"],
    {
      cwd: path.dirname(CONFIG.cloudflared),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  const handleOutput = data => {
    const text = data.toString();

    cloudflaredBuffer += text;

    // 防止长时间运行内存无限增长：只保留最近 64KB
    if (cloudflaredBuffer.length > 65536) {
      cloudflaredBuffer = cloudflaredBuffer.slice(-65536);
    }

    const matches = cloudflaredBuffer.match(
      /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi
    );

    if (matches && matches.length) {
      const url = matches[matches.length - 1];

      if (url !== publicUrl) {
        publicUrl = url;

        log(
          `公网影院已上线：${publicUrl}`,
          "success"
        );

        send("public-url", publicUrl);
        send("status");
      }
    }
  };

  cloudflaredProcess.stdout.on("data", handleOutput);
  cloudflaredProcess.stderr.on("data", handleOutput);

  const child = cloudflaredProcess;
  child.on("error", err => {
    if (cloudflaredProcess === child) cloudflaredProcess = null;
    log("Cloudflare Tunnel 启动失败：" + (err && err.message || err), "error");
    send("status");
  });
  child.on("exit", code => {
    // 只在引用仍指向该子进程时清空，避免旧进程晚到的 exit 误清新进程引用
    if (cloudflaredProcess === child) cloudflaredProcess = null;

    if (publicUrl) {
      log("Cloudflare Tunnel 已停止", "warning");
    }

    publicUrl = "";

    send("public-url", "");
    send("status");
  });
}

function stopCloudflared() {
  if (!cloudflaredProcess) {
    return;
  }

  log("正在停止 Cloudflare Tunnel...");

  forceKill(cloudflaredProcess);

  cloudflaredProcess = null;
  publicUrl = "";

  send("public-url", "");
}

function startAll() {
  return (async () => {
    log("========================================");
    log("BERLIN CINEMA 启动流程");
    log("========================================");

    const env = envCheck();

    if (!env.livekit) {
      log(
        "LiveKit 环境变量不完整，请检查系统环境变量",
        "error"
      );
    }

    if (!env.cloudflared) {
      log(
        `找不到 Cloudflared：${CONFIG.cloudflared}`,
        "error"
      );
    }

    await startCinemaServer();

    if (env.livekit) {
      try {
        const ingress = await getIngress();

        log(
          `LiveKit Ingress：${ingress.ingressId}`,
          "success"
        );

        send("ingress", {
          ingressId: ingress.ingressId,
          url: ingress.url,
          streamKey: ingress.streamKey,
          roomName: ingress.roomName,
          status: ingress.state?.status || "IDLE"
        });

      } catch (error) {
        log(
          `LiveKit Ingress 初始化失败：${error.message}`,
          "error"
        );
      }
    }

    startCloudflared();

    await new Promise(r => setTimeout(r, 1500));

    send("status");
  })();
}

function stopAll() {
  stopCloudflared();

  // viewer-server 常驻：不杀，下次开播直接复用（秒开）。
  // 只在 app 退出（before-quit）或代码更新（mtime 变化）时才重启它。
  // if (cinemaProcess) { forceKill(cinemaProcess); cinemaProcess = null; }

  log("Berlin Cinema 已停止（影院服务保持运行，下次秒开）", "warning");
  send("status");
}

async function status() {
  const portRunning = await isPortServing(CONFIG.port);

  const livekit = await getLiveKitStatus().catch(
    error => ({
      connected: false,
      error: error.message
    })
  );

  return {
    cinema: portRunning,
    tunnel: !!cloudflaredProcess && !!publicUrl,
    publicUrl,
    livekit,
    environment: envCheck()
  };
}

async function createWindow() {
  // 确保本地影院服务先启动，控制中心通过 http://localhost:3000/control 加载
  // (避免 file:// 协议下 LiveKit connect 跨域 fetch 失败)
  await startCinemaServer();

  mainWindow = new BrowserWindow({
    width: 400,
    height: 660,           // 更紧凑（用户反馈 720 还长）
    minWidth: 340,
    minHeight: 540,
    backgroundColor: "#07090d",
    title: "Berlin Cinema",
    icon: path.join(ROOT, "icon.png"),
    frame: false,

    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  // 强制设高度（覆盖上次会话保存的尺寸）
  mainWindow.setSize(400, 660);

  mainWindow.loadURL("http://localhost:3000/control");

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("start-all", async () => {
  await startAll();
  return await status();
});

ipcMain.handle("stop-all", async () => {
  stopAll();
  return await status();
});

ipcMain.handle("status", async () => {
  return await status();
});

ipcMain.handle("refresh-ingress", async () => {
  try {
    const ingress = await getIngress();

    return {
      success: true,
      ingress: {
        ingressId: ingress.ingressId,
        url: ingress.url,
        streamKey: ingress.streamKey,
        roomName: ingress.roomName,
        status: ingress.state?.status || "IDLE"
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
});

ipcMain.handle("open-url", async (_, url) => {
  if (!url) return false;

  await shell.openExternal(url);

  return true;
});

ipcMain.handle("copy", async (_, text) => {
  clipboard.writeText(text || "");
  return true;
});

ipcMain.handle("window-minimize", () => {
  mainWindow?.minimize();
  return true;
});

ipcMain.handle("window-toggle-maximize", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return true;
});

ipcMain.handle("window-close", () => {
  mainWindow?.close();
  return true;
});

ipcMain.handle("get-broadcast-info", async () => {
  try {
    const token = await getBroadcasterToken();
    return {
      success: true,
      broadcasterToken: token,
      livekitUrl: normalizeWsUrl(CONFIG.livekitUrl)
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-config", () => {
  return {
    livekitUrl: CONFIG.livekitUrl,
    apiKey: CONFIG.apiKey,
    apiSecret: CONFIG.apiSecret
  };
});

ipcMain.handle("save-config", async (_, cfg) => {
  const { livekitUrl, apiKey, apiSecret } = cfg || {};

  CONFIG.livekitUrl = normalizeHttpUrl(livekitUrl || "");
  CONFIG.apiKey = String(apiKey || "").trim();
  CONFIG.apiSecret = String(apiSecret || "").trim();

  const ok = saveConfigToDisk({
    livekitUrl: CONFIG.livekitUrl,
    apiKey: CONFIG.apiKey,
    apiSecret: CONFIG.apiSecret
  });

  // viewer-server 使用 spawn 时的旧 env；保存新配置后重启它，让新凭据立即生效
  // （否则运行中的服务仍用旧 Key/Secret 签发观众 token，LiveKit 会拒绝连接）
  if (ok) {
    try {
      if (await isPortServing(CONFIG.port)) {
        log("LiveKit 配置已更新，重启影院服务以应用新配置...", "warning");
        killPortProcess(CONFIG.port);
        await sleep(1000);
        if (cinemaProcess) cinemaProcess = null;  // 引用失效，等 exit 事件
        spawnViewerServerProcess();
      }
    } catch {}
  }

  return { success: ok };
});

// 获取观众上报数据（通过主进程转发，绕开渲染进程 file:// 页面的 CORS/协议限制）
ipcMain.handle("get-viewers", async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${CONFIG.port || 3000}/api/viewers`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) {
      appendLogFile("warn", "get-viewers", `HTTP ${res.status}`);
      return { ok: false, viewers: [] };
    }
    const data = await res.json();
    return data;
  } catch (e) {
    appendLogFile("error", "get-viewers", `fetch 失败: ${e.message}`);
    return { ok: false, viewers: [], error: e.message };
  }
});

// 写日志到 F:\Cinema\logs\app.log
ipcMain.handle("log-to-file", (_, { level, tag, message } = {}) => {
  appendLogFile(level, tag, message);
  return true;
});

// 读日志文件（最近内容）
ipcMain.handle("read-log", () => {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      // 超过 1MB 只读末尾 200KB
      if (stat.size > 1024 * 1024) {
        const fd = fs.openSync(LOG_FILE, "r");
        const buf = Buffer.alloc(200 * 1024);
        fs.readSync(fd, buf, 0, buf.length, stat.size - buf.length);
        fs.closeSync(fd);
        return buf.toString("utf8");
      }
      return fs.readFileSync(LOG_FILE, "utf8");
    }
  } catch {}
  return "";
});

// 在资源管理器中打开日志文件
ipcMain.handle("open-log", () => {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (!fs.existsSync(LOG_FILE)) appendLogFile("info", "init", "log file created");
    shell.openPath(LOG_FILE);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("restart-tunnel", async () => {
  stopCloudflared();

  await new Promise(r => setTimeout(r, 700));

  startCloudflared();

  return true;
});

// 单实例锁：防止多开应用
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 第二个实例启动时，聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  // 预启动 viewer-server（不等用户点开播就启动后台进程）
  // 用户点开播时直接复用 → 0 秒等待，不会有超时
  setTimeout(() => {
    ensureViewerServerRunning().catch(err =>
      log("预启动影院服务失败：" + err.message, "error")
    );
  }, 500);

  // 屏幕共享支持：handler 返回 desktopCapturer 的真实源
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then(sources => {
          log(`检测到屏幕源 ${sources.length} 个`);
          if (sources.length > 0) {
            const { id, name } = sources[0];
            callback({
              video: { id, name },
              audio: "loopback"
            });
          } else {
            log("未检测到屏幕源（可能是权限问题）", "error");
            callback({});
          }
        })
        .catch(err => {
          log(`获取屏幕源失败：${err.message}`, "error");
          callback({});
        });
    }
  );

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 同步强杀进程树（Windows），确保端口/隧道释放
function forceKill(child) {
  if (!child || !child.pid) return;
  try {
    child.kill();
  } catch {}
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true
      });
    } catch {}
  }
}

app.on("before-quit", () => {
  stopCloudflared();

  if (cloudflaredProcess) forceKill(cloudflaredProcess);
  if (cinemaProcess) forceKill(cinemaProcess);

  // 兜底：按端口杀所有残留进程（即使 cinemaProcess 引用丢失/手动启动的旧进程）
  killPortProcess(CONFIG.port);

  cloudflaredProcess = null;
  cinemaProcess = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
