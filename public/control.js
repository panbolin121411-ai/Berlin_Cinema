const $ = id => document.getElementById(id);

let currentPublicUrl = "";
let room = null;
let localStream = null;

function setPublicUrl(url) {
  currentPublicUrl = url || "";
  $("publicUrl").textContent = url || "等待开播…";
  $("copyBtn").disabled = !url;
}

function setStreaming(streaming) {
  $("globalDot").classList.toggle("on", streaming);
  $("globalStatus").textContent = streaming ? "直播中" : "未开播";
  $("startBtn").style.display = streaming ? "none" : "block";
  $("stopBtn").style.display = streaming ? "block" : "none";
  if (streaming) {
    $("uptime").textContent = "00:00:00";
    uptimeStart = Date.now();
  } else {
    $("uptime").textContent = "";
    uptimeStart = 0;
  }
}

let uptimeStart = 0;
setInterval(() => {
  if (!uptimeStart) return;
  const sec = Math.floor((Date.now() - uptimeStart) / 1000);
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  const el = $("uptime");
  if (el) el.textContent = `${h}:${m}:${s}`;
}, 1000);

let netTimer = null;
let syncTimer = null;
let pollTimer = null;        // 轮询 /api/viewers 拿观众状态（绕开 DataChannel）
const cityCounters = new Map();   // 城市 → 出现次数（用于分配编号）
const cityLabels = new Map();      // viewerId → "城市编号" 标签
const viewers = new Map();         // 提升到模块作用域，否则 pollViewers 找不到会 ReferenceError

function assignCityLabel(viewerId, city) {
  if (cityLabels.has(viewerId)) return cityLabels.get(viewerId);
  const c = cityCounters.get(city) || 0;
  const next = c + 1;
  cityCounters.set(city, next);
  const label = city + String(next).padStart(3, "0");
  cityLabels.set(viewerId, label);
  return label;
}

function clearLabel(viewerId) {
  // viewer 断开时，把该城市计数器减回去（避免断开后新连接号错乱）
  const label = cityLabels.get(viewerId);
  if (!label) return;
  const city = label.replace(/\d+$/, "");
  const c = cityCounters.get(city) || 0;
  if (c <= 1) cityCounters.delete(city);
  else cityCounters.set(city, c - 1);
  cityLabels.delete(viewerId);
}

async function stopStreaming() {
  if (netTimer) {
    clearInterval(netTimer);
    netTimer = null;
  }
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  localVideoPub = null;
  localAudioPub = null;
  lastPerf = null;
  // 清空观众数据（重新开播时编号从 001 开始）
  viewers.clear();
  cityLabels.clear();
  cityCounters.clear();
  const vList = $("viewersList");
  if (vList) vList.innerHTML = `<div class="viewer-row"><span class="info" style="margin:0">暂无观众</span></div>`;
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (room) {
    room.disconnect();
    room = null;
  }
}

// 实时读取媒体流到 LiveKit 节点的网络质量（RTT / 丢包）
// livekit LocalTrackPublication 没有 sender 字段，要通过 track.sender 拿（livekit 包装的 LocalVideoTrack 有 _sender getter）
let localVideoPub = null;
let localAudioPub = null;
let netStatsLogCount = 0;  // 节流：避免日志刷屏

// —— 性能日志：每 15 秒把最新推流数据写入日志文件（掉帧时可回溯）——
let lastPerf = null;

async function updateNetStats() {
  if (!room || !localVideoPub) {
    if (netStatsLogCount < 1) fileLog("warn", "netStats", `no room or pub: room=${!!room}, pub=${!!localVideoPub}`);
    return;
  }
  const track = localVideoPub.track;
  if (!track) {
    if (netStatsLogCount < 1) fileLog("warn", "netStats", "publication has no track yet");
    return;
  }
  const sender = track.sender;
  if (!sender || typeof sender.getStats !== "function") {
    if (netStatsLogCount < 1) fileLog("warn", "netStats", `no sender: sender=${!!sender}, has getStats=${sender && typeof sender.getStats === "function"}`);
    return;
  }
  netStatsLogCount++;
  try {
    const stats = await sender.getStats();
    let rtt = 0, packetsLost = 0, packetsSent = 0, fps = 0, width = 0, height = 0, bitrate = 0;
    let entryCount = 0;
    stats.forEach(stat => {
      // outbound-rtp 拿码率/FPS/丢包/分辨率
      if (stat.type === "outbound-rtp" && (stat.kind === "video" || stat.mediaType === "video")) {
        entryCount++;
        packetsLost = stat.packetsLost || 0;
        packetsSent = stat.packetsSent || 0;
        fps = stat.framesPerSecond || 0;
        if (stat.frameWidth) { width = stat.frameWidth; height = stat.frameHeight; }
        if (stat.targetBitrate) bitrate = stat.targetBitrate;
      }
      // remote-inbound-rtp 拿 RTT（来自 SFU 的 RTCP RR 反馈）
      if (stat.type === "remote-inbound-rtp" && (stat.kind === "video" || stat.mediaType === "video")) {
        if (typeof stat.roundTripTime === "number" && stat.roundTripTime > rtt) {
          rtt = stat.roundTripTime;
        }
      }
    });
    if (netStatsLogCount === 1) fileLog("info", "netStats", `first call OK, ${entryCount} outbound-rtp, rtt=${rtt.toFixed(3)}s`);
    const lossPct = packetsSent > 0 ? (packetsLost / packetsSent) * 100 : 0;
    const rttMs = rtt * 1000;
    const rttCls = rttMs > 200 ? "bad" : rttMs > 100 ? "warn" : "good";
    const lossCls = lossPct > 2 ? "bad" : lossPct > 0.5 ? "warn" : "good";

    const setVal = (id, text, cls) => {
      const el = $(id);
      if (!el) return;
      el.textContent = text;
      el.className = cls || "";
    };
    setVal("sRtt", rttMs > 0 ? `${rttMs.toFixed(0)} ms` : "—", rttCls);
    setVal("sLoss", packetsSent > 0 ? `${lossPct.toFixed(2)} %` : "—", lossCls);
    setVal("sFps", fps > 0 ? `${fps} fps` : "—");
    setVal("sRes", width ? `${width}×${height}` : "—");
    setVal("sBitrate", bitrate > 0 ? `${(bitrate / 1_000_000).toFixed(1)} Mbps` : "—");

    // 保存最新性能数据（供 15 秒定时写入日志）
    lastPerf = { rttMs: Math.round(rttMs), lossPct: +lossPct.toFixed(2), fps, w: width, h: height, mbps: +(bitrate / 1_000_000).toFixed(2) };
  } catch (e) {
    if (netStatsLogCount === 1) fileLog("error", "netStats", "getStats threw: " + e.message);
  }
}

// 每 15 秒把最新性能数据写入日志（掉帧时可回溯历史）
setInterval(() => {
  if (!lastPerf) return;
  fileLog("perf", "push", `rtt=${lastPerf.rttMs}ms loss=${lastPerf.lossPct}% fps=${lastPerf.fps} res=${lastPerf.w}x${lastPerf.h} br=${lastPerf.mbps}Mbps`);
}, 15000);

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 更新观众列表显示（人数 + 每个人的网络质量）
function updateViewerList(viewers) {
  const el = $("viewersList");
  if (!el) {
    fileLog("error", "updateViewerList", "#viewersList 元素不存在!");
    return;
  }
  if (viewers.size === 0) {
    el.innerHTML = `<div class="viewer-row"><span class="info" style="margin:0">暂无观众</span></div>`;
    if (typeof fitLogs === "function") fitLogs();
    return;
  }
  const now = Date.now();
  const rows = [...viewers.entries()].map(([id, d]) => {
    const label = escapeHtml(d.label || id.slice(0, 8));
    const isIOS = d.client === "iOS";
    const online = d.active !== false && d.lastSeen && (now - d.lastSeen < 30000);
    // 数值兜底：观众上报字段可能是字符串/缺省，直接 .toFixed 会抛 TypeError 中断整个列表渲染
    const rtt = Number(d.rtt) || 0;
    const jitter = Number(d.jitter) || 0;
    const width = Number(d.width) || 0;
    const height = Number(d.height) || 0;
    const packetsLost = Number(d.packetsLost) || 0;
    let info;
    if (online) {
      // 服务端计算的网络延迟（观众端上报时戳 → 服务端收到，绕开 iOS 无 WebRTC stats）
      const delay = Number(d.delay) || 0;
      if (delay > 0) {
        const dCls = delay > 600 ? "bad" : delay > 300 ? "warn" : "good";
        info = `<span class="${dCls}">延迟 ${delay}ms</span>`;
      } else if (!isIOS && rtt > 0) {
        const rttCls = rtt > 200 ? "bad" : rtt > 100 ? "warn" : "good";
        const jitCls = jitter > 50 ? "bad" : jitter > 20 ? "warn" : "good";
        const res = width ? ` ${width}×${height}` : "";
        info = `<span class="${rttCls}">RTT ${rtt.toFixed(0)}ms</span> · <span class="${jitCls}">抖动 ${jitter.toFixed(0)}ms</span> · 丢包 ${packetsLost}${res}`;
      } else {
        info = "在线 · 延迟计算中";
      }
    } else {
      const t = d.lastSeen ? new Date(d.lastSeen) : new Date();
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      info = `已离开 ${hh}:${mm}`;
    }
    const tag = isIOS ? `<span class="client-tag">iOS</span>` : `<span class="client-tag">Web</span>`;
    return `<div class="viewer-row ${online ? "" : "offline"}"><span class="status-dot"></span><span class="name">${label}</span>${tag}<span class="info">${info}</span></div>`;
  }).join("");
  el.innerHTML = rows;
  // 观众列表行数变化 → 重算日志框高度（避免挤压/溢出）
  if (typeof fitLogs === "function") fitLogs();
}

// 轮询观众状态（通过主进程 IPC 转发，绕开渲染进程 file:// 页面的 CORS/协议限制）
async function pollViewers() {
  try {
    const data = await window.cinema.getViewers();
    if (!data || !data.ok) return;
    const incoming = new Map();
    for (const v of data.viewers) {
      const city = (v.location || "未知").replace(/市$/, "");
      const label = assignCityLabel(v.viewerId, city);
      incoming.set(v.viewerId, {
        label,
        city,
        client: v.client || "Web",
        delay: v.delay,          // 观众网络延迟（服务端根据上报时戳计算）
        rtt: v.rtt,
        jitter: v.jitter,
        packetsLost: v.packetsLost,
        width: v.width,
        height: v.height,
        fps: v.fps,
        lastSeen: v.lastSeen,
        active: v.active
      });
    }
    // 检测下线：之前有但现在没的，清掉标签
    for (const id of viewers.keys()) {
      if (!incoming.has(id)) clearLabel(id);
    }
    viewers.clear();
    for (const [id, v] of incoming) viewers.set(id, v);
    updateViewerList(viewers);
  } catch (e) {
    fileLog("error", "pollViewers", `异常: ${e.message}`);
  }
}

async function startBroadcast() {
  // 检查 LiveKit 配置是否完整
  const cfg = await window.cinema.getConfig();
  if (!cfg.livekitUrl || !cfg.apiKey || !cfg.apiSecret) {
    addLog("请先填写 LiveKit 配置（右上角 ≡ → 设置）", "error");
    $("livekitUrl").value = cfg.livekitUrl || "";
    $("apiKey").value = cfg.apiKey || "";
    $("apiSecret").value = cfg.apiSecret || "";
    showView("settings");
    $("livekitUrl").focus();
    return;
  }

  $("startBtn").disabled = true;
  $("startBtn").textContent = "启动中…";
  fileLog("info", "broadcaster", "start broadcast initiated");

  const mask = s => (s ? s.slice(0, 4) + "***(" + s.length + "位)" : "(空)");
  addLog(`实际配置 → URL=${cfg.livekitUrl || "(空)"}，Key=${mask(cfg.apiKey)}，Secret=${mask(cfg.apiSecret)}`);

  addLog("启动服务与隧道…");

  try {
    // 1. 启动本地服务 + 公网隧道
    await window.cinema.startAll();
    addLog("服务已启动", "success");

    // 2. 获取主播凭证
    const info = await window.cinema.getBroadcastInfo();
    if (!info.success) throw new Error(info.error);

    // 3. 屏幕共享（含系统音频，失败自动降级）
    const videoConstraints = {
      frameRate: { ideal: 30, max: 30 },
      width: { ideal: 1920, max: 2560 },
      height: { ideal: 1080, max: 1440 }
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000
          // 不强制声道数：跟随系统输出设备的原生声道（避免单声道被假立体声化）
        },
        systemAudio: "include"
      });
    } catch (audioErr) {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: false
      });
      addLog("系统音频不可用，仅共享画面", "warning");
    }
    localStream = stream;

    // 诊断：打印捕获音频的实际参数（声道数/采样率）
    const diagAudio = stream.getAudioTracks()[0];
    if (diagAudio) {
      const s = diagAudio.getSettings();
      addLog(`音频捕获：${s.sampleRate || "?"}Hz / ${s.channelCount || "?"}声道`);
    }

    // 4. 连接 LiveKit 并推流
    const LK = window.LivekitClient;
    room = new LK.Room({ adaptiveStream: true, dynacast: true });

    // —— 观众连接监控（HTTP 轮询，不再依赖 WebRTC DataChannel）——
    // viewers 已在模块顶部定义

    room.on(LK.RoomEvent.DataReceived, (payload, participant) => {
      // 兼容旧版 DataChannel 消息（如有）
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (data && data.type === "log" && participant) {
          fileLog(data.level || "info", "viewer-log", `${participant.identity}: ${data.msg}`);
        }
      } catch (e) {}
    });

    room.on(LK.RoomEvent.ParticipantConnected, p => {
      if (p.identity !== "broadcaster") {
        fileLog("info", "viewer-conn", `connected: ${p.identity}`);
      }
    });

    room.on(LK.RoomEvent.ParticipantDisconnected, p => {
      fileLog("info", "viewer-disc", `disconnected: ${p.identity}`);
    });

    await room.connect(info.livekitUrl, info.broadcasterToken);
    updateViewerList(viewers);

    const vtrack = stream.getVideoTracks()[0];
    if (vtrack) {
      localVideoPub = await room.localParticipant.publishTrack(vtrack, {
        name: "screen",
        source: LK.Track.Source.ScreenShare,
        videoCodec: "h264",
        simulcast: false,
        screenShareEncoding: { maxBitrate: 16000000, maxFramerate: 30 }
      });
    }

    const atrack = stream.getAudioTracks()[0];
    if (atrack) {
      localAudioPub = await room.localParticipant.publishTrack(atrack, {
        name: "audio",
        source: LK.Track.Source.ScreenShareAudio,
        audioPreset: { maxBitrate: 128000 }
        // 声道跟随捕获（不强制立体声，避免单声道假立体声化）
      });
    }

    // 用户点浏览器「停止共享」时自动收尾
    if (vtrack) {
      vtrack.addEventListener("ended", async () => {
        await stopStreaming();
        setStreaming(false);
        addLog("屏幕共享已停止", "warning");
      });
    }

    setStreaming(true);
    addLog("直播中，复制网址发给女朋友", "success");
    fileLog("info", "broadcaster", "streaming started, public url: " + (currentPublicUrl || "n/a"));

    // 启动实时网络诊断（每 3 秒刷新 RTT / 丢包）
    netTimer = setInterval(updateNetStats, 3000);
    setTimeout(updateNetStats, 1000);

    // 轮询观众状态（每 2 秒拉一次 /api/viewers，绕开 DataChannel 不可靠问题）
    pollViewers();
    pollTimer = setInterval(pollViewers, 2000);

    // 发送对齐时间戳给观众端（每 5 秒），观众端据此检测延迟并自动追赶
    const sendSync = () => {
      try {
        if (room) {
          room.localParticipant.publishData(
            new TextEncoder().encode(JSON.stringify({ type: "sync", t: Date.now() })),
            LK.DataPacket_Kind.RELIABLE
          );
        }
      } catch (e) {}
    };
    syncTimer = setInterval(sendSync, 5000);
    setTimeout(sendSync, 1500);

  } catch (err) {
    addLog("开播失败：" + (err.message || err), "error");
    fileLog("error", "broadcaster", "start failed: " + (err.message || err));
    await stopStreaming();
  } finally {
    $("startBtn").disabled = false;
    $("startBtn").textContent = "▶ 一键开播";
  }
}

/* 一键开播 */
$("startBtn").addEventListener("click", startBroadcast);

/* 停止 */
$("stopBtn").addEventListener("click", async () => {
  await stopStreaming();
  await window.cinema.stopAll();
  setStreaming(false);
  setPublicUrl("");
  addLog("已停止", "warning");
});

/* 复制网址 */
$("copyBtn").addEventListener("click", async () => {
  if (!currentPublicUrl) return;
  await window.cinema.copy(currentPublicUrl);
  addLog("网址已复制", "success");
  // 短暂反馈：按钮变绿色"已复制" 1.5s
  const btn = $("copyBtn");
  const oldText = btn.textContent;
  btn.textContent = "已复制";
  btn.classList.add("success");
  setTimeout(() => { btn.textContent = oldText; btn.classList.remove("success"); }, 1500);
});

/* 窗口控制 */
$("btnMin").addEventListener("click", () => window.cinema.minimize());
$("btnClose").addEventListener("click", () => window.cinema.close());

/* ≡ 菜单（右上角） */
const toggleMenu = () => {
  const m = $("menuPopup");
  m.style.display = m.style.display === "none" ? "flex" : "none";
};
const closeMenu = () => { $("menuPopup").style.display = "none"; };
$("btnMenu").addEventListener("click", e => {
  e.stopPropagation();
  toggleMenu();
});
document.addEventListener("click", e => {
  if (e.target.closest("#menuPopup") || e.target.closest("#btnMenu")) return;
  closeMenu();
});

/* 视图切换：主视图 / 设置视图（用 class 互斥，display 不会被其他代码覆盖） */
function showView(name) {
  $("viewHome").classList.toggle("hidden", name !== "home");
  $("viewSettings").classList.toggle("hidden", name !== "settings");
}

/* 菜单：设置 → 设置视图 */
$("menuSettings").addEventListener("click", () => {
  closeMenu();
  showView("settings");
});
/* 菜单：详细日志 → 打开完整 app.log 文件（含 perf 性能记录等所有 detail） */
$("menuLog").addEventListener("click", () => {
  closeMenu();
  window.cinema.openLog();
});
/* 设置视图：返回 */
$("backBtn").addEventListener("click", () => {
  showView("home");
});

/* 保存设置 */
$("saveBtn").addEventListener("click", async () => {
  const cfg = {
    livekitUrl: $("livekitUrl").value.trim(),
    apiKey: $("apiKey").value.trim(),
    apiSecret: $("apiSecret").value.trim()
  };
  const result = await window.cinema.saveConfig(cfg);
  if (result.success) {
    addLog("设置已保存", "success");
    fileLog("info", "config", "saved");
    showView("home");
  } else {
    addLog("保存失败", "error");
    fileLog("error", "config", "save failed");
  }
});

// 关键事件写入日志文件（供排查用）
function fileLog(level, tag, message) {
  try { window.cinema.logToFile({ level, tag, message }); } catch {}
}

// 滚动日志到底（DOM 布局异步，rAF 后再设一次保证生效）
function scrollLogsToBottom() {
  const logs = $("logs");
  if (!logs) return;
  logs.scrollTop = logs.scrollHeight;
  // 下一帧再设一次，处理 flex/异步布局
  requestAnimationFrame(() => { logs.scrollTop = logs.scrollHeight; });
}

// addLog：同时在 UI #logs 显示 + 写文件，每次新增后自动滚到底
function addLog(message, type = "info") {
  const logs = $("logs");
  if (logs) {
    const line = document.createElement("div");
    line.className = "log " + type;
    line.textContent = message;
    logs.appendChild(line);
    // 限制最多 200 条
    while (logs.children.length > 200) logs.removeChild(logs.firstChild);
    scrollLogsToBottom();
  }
  fileLog(type === "error" ? "error" : "info", "ui", message);
  if (typeof fitLogs === "function") fitLogs();
}
fileLog("info", "init", "control center loaded");

/* 初始化时往 UI 日志区也写几条，让"日志框"打开就有内容可见 */
addLog("控制中心启动", "success");
addLog("点击右上角 ≡ → 设置，填写 LiveKit 配置", "info");

/* 主进程事件 */
window.cinema.onPublicUrl(url => {
  setPublicUrl(url);
});

if (window.cinema.onLog) {
  window.cinema.onLog(data => {
    addLog(`[${data.time}] ${data.message}`, data.type);
  });
}

/* 初始状态 */
setStreaming(false);
updateViewerList(new Map());   // 常驻显示"暂无观众"

// 加载已保存的 LiveKit 配置
window.cinema.getConfig().then(cfg => {
  $("livekitUrl").value = cfg.livekitUrl || "";
  $("apiKey").value = cfg.apiKey || "";
  $("apiSecret").value = cfg.apiSecret || "";
  if (cfg.livekitUrl && cfg.apiKey && cfg.apiSecret) {
    addLog("配置已加载（URL/API Key/Secret）", "success");
  } else {
    addLog("未配置 LiveKit，请点 ≡ → 设置填写", "warning");
  }
}).catch(() => {
  addLog("加载配置失败", "error");
});

fileLog("info", "init", "ready, click to start");
addLog("就绪，点击「▶ 一键开播」开始", "success");

// —— 日志框高度兜底：JS 计算剩余空间并强制设置（不依赖 flex 布局的不确定性）——
function fitLogs() {
  const content = document.querySelector(".content");
  const logsBlock = document.querySelector(".logs-block");
  const logs = document.getElementById("logs");
  if (!content || !logsBlock || !logs) return;
  try {
    // 用 viewport 几何（不依赖 offsetHeight / flex）：日志块顶部距视口底的距离 = 可用高度
    const logsRect = logsBlock.getBoundingClientRect();
    const padding = 14;   // .content padding-bottom
    const availH = (window.innerHeight - logsRect.top) - padding;
    if (availH > 60) {
      logsBlock.style.height = availH + "px";
      logs.style.maxHeight = (availH - 36) + "px";  // 标题 14 + block padding 22
      logs.style.overflowY = "auto";
      // 滚到底
      requestAnimationFrame(() => { logs.scrollTop = logs.scrollHeight; });
    }
  } catch {}
}
window.addEventListener("resize", fitLogs);
window.addEventListener("load", () => setTimeout(fitLogs, 300));
setTimeout(fitLogs, 300);
