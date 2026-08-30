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

function checkPort(port) {
  return new Promise(resolve => {
    const server = http.createServer();

    server.once("error", () => {
      resolve(true);
    });

    server.once("listening", () => {
      server.close(() => resolve(false));
    });

    server.listen(port, "127.0.0.1");
  });
}

async function startCinemaServer() {
  const occupied = await checkPort(CONFIG.port);

  if (occupied) {
    log(`3000 端口已经在使用，跳过 Node.js 启动`, "success");
    return true;
  }

  const serverFile = CONFIG.serverFile;

  if (!fs.existsSync(serverFile)) {
    log(`没有找到 ${serverFile}，无法自动启动影院服务`, "error");
    return false;
  }

  log("正在启动本地影院服务...");

  cinemaProcess = spawn(
    process.execPath,
    [serverFile],
    {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Electron 主进程里 spawn 自己运行 .mjs 必须加此标记
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        // 把 GUI/config.json 里的 LiveKit 配置注入子进程，
        // 否则 livekit-service.mjs 读的是系统环境变量（可能为空）
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

  cinemaProcess.on("exit", code => {
    cinemaProcess = null;
    log(`影院 Node 服务退出，代码：${code}`, "warning");
    send("status");
  });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));

    if (await checkPort(CONFIG.port)) {
      log("本地影院服务启动成功", "success");
      return true;
    }
  }

  log("等待本地影院服务超时", "error");
  return false;
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

  cloudflaredProcess.on("exit", code => {
    cloudflaredProcess = null;

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

  if (cinemaProcess) {
    forceKill(cinemaProcess);
    cinemaProcess = null;
  }

  log("Berlin Cinema 已停止", "warning");
  send("status");
}

async function status() {
  const portRunning = await checkPort(CONFIG.port);

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
    height: 640,
    minWidth: 340,
    minHeight: 520,
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

ipcMain.handle("save-config", (_, cfg) => {
  const { livekitUrl, apiKey, apiSecret } = cfg || {};

  CONFIG.livekitUrl = normalizeHttpUrl(livekitUrl || "");
  CONFIG.apiKey = String(apiKey || "").trim();
  CONFIG.apiSecret = String(apiSecret || "").trim();

  const ok = saveConfigToDisk({
    livekitUrl: CONFIG.livekitUrl,
    apiKey: CONFIG.apiKey,
    apiSecret: CONFIG.apiSecret
  });

  return { success: ok };
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

  cloudflaredProcess = null;
  cinemaProcess = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
