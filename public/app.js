// 资源加载失败检测：livekit-client 未加载时给出明确提示（避免"空白页"）
if (typeof LivekitClient === "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    try {
      showError("资源加载失败（livekit-client 未就绪），请刷新页面重试");
      const st = document.getElementById("statusText");
      if (st) st.textContent = "ERROR";
    } catch {}
  });
}

let video = document.getElementById("video");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("statusText");
const waiting = document.getElementById("waiting");
const errorBox = document.getElementById("error");
const fullscreenBtn = document.getElementById("fullscreen");
const startOverlay = document.getElementById("startOverlay");
const qualityOverlay = document.getElementById("qualityOverlay");

let room = null;
const mediaElements = [];
let unmutedOk = false;   // 标记是否已成功去静音（iOS 上 false，需要用户点开始按钮）

function setStatus(text, live = false) {
  statusText.textContent = text;
  statusEl.classList.toggle("live", live);
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.style.display = "block";
}

function hideError() {
  errorBox.style.display = "none";
}

// 开启声音（需用户手势，iOS Safari 自动播放策略要求）
function enableSound() {
  mediaElements.forEach(el => {
    el.muted = false;
    el.play().catch(() => {});
  });
}

function attachTrack(track) {
  if (!track) return;

  reportLog("info", `attachTrack: kind=${track.kind}, name=${track.name}, muted=${track.isMuted}`);
  const element = track.attach();
  element.autoplay = true;
  element.playsInline = true;
  element.controls = false;

  if (track.kind === "video") {
    element.muted = true;     // 先静音保证自动播画面（iOS autoplay 策略要求）
    video.replaceWith(element);
    element.id = "video";
    video = element;
    livekitVideoTrack = track;  // 保留 livekit track 引用（兼容旧调用）
    setupBufferingMonitor(element);   // 监听缓冲事件（卡顿检测）
    enableRvfMonitor(element);        // 实际渲染帧率检测（rVFC）
    if (qualityOverlay) {         // 显示质量浮层（等首次 sendStatsOnce 后填值）
      qualityOverlay.textContent = "延迟 ···";
      qualityOverlay.className = "";
      qualityOverlay.style.display = "block";
    }
    debugShow(`画面已就绪 (${video.videoWidth}x${video.videoHeight})`);
    reportLog("info", `video attached: ${video.videoWidth}x${video.videoHeight}, srcObject=${!!video.srcObject}`);
    startStatsReport();       // 有画面后开始上报网络统计
  }

  mediaElements.push(element);

  waiting.style.display = "none";
  setStatus("LIVE", true);

  // 自动播放：先 muted 播画面（保证任何浏览器都能自动出画面）
  const playMuted = () => {
    element.muted = true;
    const p = element.play();
    if (p && p.catch) p.catch(() => {});
  };
  // 尝试去静音（Android/桌面直接有声；iOS 会被 autoplay 策略拒绝，保持 muted）
  const tryUnmute = () => {
    try {
      element.muted = false;
      const p = element.play();
      if (p && p.catch) {
        p.then(() => {
          unmutedOk = true;
          if (startOverlay) startOverlay.style.display = "none";
        }).catch(() => {
          element.muted = true;
          unmutedOk = false;
          reportLog("info", "autoplay with sound denied, showing start button (iOS policy)");
          if (startOverlay) startOverlay.style.display = "flex";
        });
      }
    } catch (e) {
      element.muted = true;
      unmutedOk = false;
      if (startOverlay) startOverlay.style.display = "flex";
    }
  };

  try {
    const p = element.play();
    if (p && p.catch) {
      p.then(() => {
        // 画面已自动播放，尝试带声音（非 iOS 设备直接生效）
        tryUnmute();
      }).catch(() => {
        playMuted();
        setTimeout(tryUnmute, 500);
      });
    } else {
      playMuted();
      setTimeout(tryUnmute, 500);
    }
  } catch (e) {
    playMuted();
  }
}

// 用户点击"开始观看"按钮：触发 play + unmute（video + 独立 audio element 都要解除静音）
function handleStartClick() {
  if (!video) return;
  video.muted = false;
  const p = video.play();
  // 解除所有媒体元素（含独立音频轨）的静音 —— 之前只处理 video，导致 iOS 上没声音
  mediaElements.forEach(el => {
    if (el !== video) {
      el.muted = false;
      const ep = el.play();
      if (ep && ep.catch) ep.catch(() => {});
    }
  });
  if (p && p.catch) {
    p.then(() => {
      unmutedOk = true;
      if (startOverlay) startOverlay.style.display = "none";
      reportLog("info", "用户点击开始按钮，播放成功（video + audio 均已解除静音）");
    }).catch(err => {
      reportLog("warn", `点击开始后 play() 仍被拒: ${err.message}`);
    });
  } else {
    unmutedOk = true;
    if (startOverlay) startOverlay.style.display = "none";
  }
}

// —— 观众端：每 5 秒通过 HTTP 上报接收质量给主播端（绕开 WebRTC DataChannel，更可靠）——
let statsTimer = null;
let cachedLocation = null;
let livekitVideoTrack = null;
const VIEWER_ID = (crypto && crypto.randomUUID) ? crypto.randomUUID() : "v-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

// 主动离场通知：页面关闭/切后台时立即通知 viewer-server 删除（避免 30s 离线延迟）
function notifyDisconnect() {
  if (!VIEWER_ID) return;
  try {
    // sendBeacon 默认 text/plain，必须用 Blob 指定 application/json 才能被 express.json 解析
    const blob = new Blob([JSON.stringify({ viewerId: VIEWER_ID })], { type: "application/json" });
    navigator.sendBeacon("/api/disconnect", blob);
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") notifyDisconnect();
});
window.addEventListener("pagehide", notifyDisconnect);
window.addEventListener("beforeunload", notifyDisconnect);

// 页面调试条：底部固定条始终显示当前状态（成功绿色，错误红色）
function debugShow(msg, isError = false) {
  try {
    const el = document.getElementById("debugInfo");
    if (el) {
      el.textContent = msg;
      el.style.color = isError ? "#f87171" : "#5eead4";
    }
  } catch {}
}

// 观众端日志：POST 到 /api/report（type:"log"），服务端写入 logs/viewer.log
// 同时本地 localStorage 兜底（bc_log），避免 HTTP 也不可用时丢日志
function reportLog(level, msg) {
  try {
    fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viewerId: VIEWER_ID, type: "log", level, msg, t: Date.now() })
    }).catch(() => {});
  } catch {}
  try {
    const key = "bc_log";
    const old = localStorage.getItem(key) || "";
    localStorage.setItem(key, (old + `[${new Date().toISOString().slice(11, 19)}] ${level} ${msg}\n`).slice(-8000));
  } catch {}
  try { console.log(`[${level}] ${msg}`); } catch {}
}

// 全局捕获 JS 错误 / Promise 异常，上报到日志
window.addEventListener("error", e => {
  reportLog("error", `JS错误: ${e.message} @${(e.filename || "").split("/").pop()}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", e => {
  const r = e.reason;
  reportLog("error", `Promise异常: ${(r && (r.message || r)) || "unknown"}`);
});
reportLog("info", "app loaded, viewerId=" + VIEWER_ID.slice(0, 8));

async function getLocation() {
  if (cachedLocation) return cachedLocation;
  try {
    const r = await fetch("https://ip-api.com/json/?lang=zh-CN");
    const d = await r.json();
    let loc = d.city || d.regionName || "";
    loc = String(loc).replace(/市$/, "");
    if (loc.length > 6) loc = loc.slice(0, 6);
    cachedLocation = loc || "未知";
  } catch (e) {
    cachedLocation = "未知";
  }
  return cachedLocation;
}

// 用标准 MediaStreamTrack.getStats() 读真实的视频接收统计（不依赖 livekit 私有 API）
// 注意：iOS Safari 不支持 MediaStreamTrack.getStats()，iPhone 上直接跳过（无 RTT/丢包数据）
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

async function getViewerStats() {
  if (isIOS) {
    return null;  // iOS 不支持，详见页面顶部提示
  }
  const vtrack = video && video.srcObject ? video.srcObject.getVideoTracks()[0] : null;
  if (!vtrack) return null;
  if (typeof vtrack.getStats !== "function") return null;  // 旧浏览器/Safari
  try {
    const stats = await vtrack.getStats();
    let rtt = 0, jitter = 0, packetsLost = 0, width = 0, height = 0, fps = 0;
    stats.forEach(s => {
      if (s.type === "inbound-rtp" && (s.kind === "video" || s.mediaType === "video")) {
        rtt = (s.roundTripTime || 0) * 1000;
        jitter = (s.jitter || 0) * 1000;
        packetsLost = s.packetsLost || 0;
        fps = s.framesPerSecond || 0;
      }
      if (s.type === "track" && s.frameWidth) {
        width = s.frameWidth;
        height = s.frameHeight;
      }
    });
    return { rtt, jitter, packetsLost, width, height, fps, t: Date.now() };
  } catch (e) {
    return null;
  }
}

// —— 实际渲染帧率检测（requestVideoFrameCallback，iOS 15.4+/现代浏览器支持）——
// currentTime 平滑（音频轨驱动）不代表画面帧都渲染了；rVFC 每渲染一帧回调，测真实流畅度
let rvfcStats = { frames: 0, lastTs: 0, stuckCount: 0, lastReport: 0, active: false };
function enableRvfMonitor(videoEl) {
  if (!videoEl || typeof videoEl.requestVideoFrameCallback !== "function") {
    reportLog("warn", "rvfc: 浏览器不支持 requestVideoFrameCallback");
    return;
  }
  if (rvfcStats.active) return;
  rvfcStats.active = true;
  const s = rvfcStats;
  s.frames = 0; s.lastTs = 0; s.stuckCount = 0; s.lastReport = 0;
  const onFrame = (now) => {
    s.frames++;
    if (s.lastTs) {
      const gap = now - s.lastTs;
      if (gap > 150) {   // 帧间隔 >150ms ≈ 画面停 5+ 帧
        s.stuckCount++;
        reportLog("warn", `渲染卡顿#${s.stuckCount}: 帧间隔 ${Math.round(gap)}ms (期望 ≤33ms) t=${videoEl.currentTime.toFixed(1)}s`);
      }
    }
    s.lastTs = now;
    // 每 5 秒汇总实际渲染 fps
    if (!s.lastReport) s.lastReport = now;
    if (now - s.lastReport >= 5000) {
      const elapsed = (now - s.lastReport) / 1000;
      const fps = s.frames / elapsed;
      reportLog("info", `实际渲染 ${fps.toFixed(1)}fps / 期望 30 · 卡顿 ${s.stuckCount} 次`);
      s.frames = 0; s.lastReport = now; s.stuckCount = 0;
    }
    videoEl.requestVideoFrameCallback(onFrame);
  };
  videoEl.requestVideoFrameCallback(onFrame);
}

// 观众端：更新视频角落质量浮层（延迟/网络状况），iOS 也能看到自己到服务器的延迟
function updateQuality(rtt) {
  if (!qualityOverlay) return;
  if (!rtt || rtt <= 0) {
    qualityOverlay.textContent = "延迟 ···";
    qualityOverlay.className = "";
    return;
  }
  qualityOverlay.textContent = `延迟 ${rtt}ms`;
  qualityOverlay.className = rtt > 500 ? "bad" : rtt > 200 ? "warn" : "";
  qualityOverlay.style.display = "block";
}

// 观众端：获取公网 IPv4 出口（用于服务端定位，GeoIP 对 IPv4 定位准确）
// iOS 15+ 的 WebRTC ICE 候选是 mDNS 格式（如 xxx.local）拿不到真公网 IP，所以多服务兜底
let cachedIpv4 = null;
async function fetchIpv4FromService(url, timeoutMs = 3500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    const text = (await r.text()).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(text)) return text;
  } catch {}
  return null;
}
async function getPublicIpv4() {
  if (cachedIpv4) return cachedIpv4;
  // 尝试多个公网 IPv4 服务（iOS 移动网络下至少一个能通）
  const services = [
    "https://api.ipify.org",
    "https://ipv4.icanhazip.com",
    "https://4.ipinfo.io/ip",
    "https://checkip.amazonaws.com",
    "https://ifconfig.me/ip"
  ];
  for (const url of services) {
    const ip = await fetchIpv4FromService(url);
    if (ip) {
      cachedIpv4 = ip;
      reportLog("info", `ipv4 定位成功: ${ip} (via ${url})`);
      return ip;
    }
  }
  reportLog("warn", "ipv4 定位失败：所有公网服务均不可达");
  return null;
}

// 页面加载时立即预取（不等 sendStatsOnce），争取 2 秒内拿到
setTimeout(() => { getPublicIpv4(); }, 200);

async function sendStatsOnce() {
  let report = null;
  if (!isIOS) {
    report = await getViewerStats();
    if (!report) {
      report = { rtt: 0, jitter: 0, packetsLost: 0, width: 0, height: 0, fps: 0 };
    }
  }
  // t 必须等所有 await 完成后记录（真实发送时刻，否则延迟虚高）
  const payload = {
    viewerId: VIEWER_ID,
    client: isIOS ? "iOS" : "Web",
    ipv4: await getPublicIpv4(),   // 观众 IPv4 出口（服务端用它定位，避免 IPv6 定位不准）
    rtt: report?.rtt || 0,
    jitter: report?.jitter || 0,
    packetsLost: report?.packetsLost || 0,
    width: report?.width || 0,
    height: report?.height || 0,
    fps: report?.fps || 0,
    t: 0   // 下方赋值
  };
  payload.t = Date.now();
  const sendTime = payload.t;
  try {
    const r = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    // 测一次 round-trip time（HTTP 上报到响应回来）作为观众延迟的近似
    const rtt = Date.now() - sendTime;
    updateQuality(rtt);
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    if (isIOS) {
      debugShow(`✓ ${time} 已上报 | 延迟 ${rtt}ms | ${VIEWER_ID.slice(0, 6)}`);
    } else if (report && report.rtt > 0) {
      debugShow(`✓ ${time} 已上报 | WebRTC RTT ${report.rtt.toFixed(0)}ms 丢包 ${report.packetsLost}`);
    } else {
      debugShow(`✓ ${time} 已上报 | ${VIEWER_ID.slice(0, 6)}`);
    }
  } catch (e) {
    debugShow(`✗ 上报失败: ${e.message} | viewerId=${VIEWER_ID.slice(0, 6)}`, true);
  }
}

// —— 对齐检测：接收主播端的时间戳，计算端到端延迟并自动追赶 ——
let catchingUp = false;
let lastDelay = 0;

function handleSync(serverTime) {
  const delay = Date.now() - serverTime;
  lastDelay = delay;
  const v = video;
  if (!v || catchingUp) return;
  // 延迟超过 5 秒：短暂加速追赶（playbackRate 1.1，8 秒后恢复）
  if (delay > 5000) {
    catchingUp = true;
    v.playbackRate = 1.1;
    setTimeout(() => {
      if (video) video.playbackRate = 1.0;
      catchingUp = false;
    }, 8000);
    reportLog("info", `sync: delay ${Math.round(delay)}ms, speed up to catch up`);
  } else if (delay < 2000 && v.playbackRate !== 1.0) {
    v.playbackRate = 1.0;
    catchingUp = false;
  }
}

function startStatsReport() {
  if (statsTimer) clearInterval(statsTimer);
  setTimeout(sendStatsOnce, 2000);                       // 首次延迟 2s
  statsTimer = setInterval(sendStatsOnce, 5000);        // 之后每 5s
}

// 播放卡顿检测：记录 waiting（缓冲饥饿）事件 + 播放/暂停恢复，直接反映观众端卡顿
let bufferingCount = 0;
let lastBufferingAt = 0;
let prevPlaybackTime = null;
let prevPlaybackReal = null;

function setupBufferingMonitor(videoEl) {
  if (!videoEl || videoEl.__bcMon) return;
  videoEl.__bcMon = true;
  videoEl.addEventListener("waiting", () => {
    bufferingCount++;
    lastBufferingAt = Date.now();
    reportLog("warn", `buffering#${bufferingCount}: 视频缓冲等待 (t=${videoEl.currentTime.toFixed(1)}s)`);
  });
  videoEl.addEventListener("playing", () => {
    if (lastBufferingAt) {
      const dur = ((Date.now() - lastBufferingAt) / 1000).toFixed(1);
      reportLog("info", `buffering 恢复, 卡了 ${dur}s`);
      lastBufferingAt = 0;
    }
  });
  videoEl.addEventListener("stalled", () => {
    reportLog("warn", `stalled: 数据不足 (t=${videoEl.currentTime.toFixed(1)}s)`);
  });
}

// 每 5 秒估计实际播放速率（currentTime 推进 vs 真实时间）
// 正常 = 1.0；<0.9 = 在掉帧/慢放；0 = 完全卡住
function checkPlaybackRate() {
  try {
    const v = video;
    if (!v) return;
    if (prevPlaybackReal) {
      const dtReal = (Date.now() - prevPlaybackReal) / 1000;
      const dtMedia = v.currentTime - prevPlaybackTime;
      if (dtReal >= 4) {
        const rate = dtMedia / dtReal;
        if (rate < 0.7) {
          reportLog("warn", `播放速率异常: ${(rate * 100).toFixed(0)}% (${dtMedia.toFixed(1)}s/${dtReal.toFixed(1)}s) t=${v.currentTime.toFixed(1)}s`);
        }
      }
    }
    prevPlaybackReal = Date.now();
    prevPlaybackTime = v.currentTime;
  } catch {}
}
setInterval(checkPlaybackRate, 5000);

// 上报统计的同时上报视频 element 的实时状态（画面是否真的在渲染）
// 每 15 秒一次（掉帧时可回溯观众端实际渲染情况）
// iOS Safari：getVideoPlaybackQuality 返回 total=0 无效，用 webkitDecoded/ DroppedFrameCount（Safari 私有但可靠）
function reportVideoState() {
  try {
    const v = video;
    if (!v) return;
    let dropped = null, total = null;
    if (typeof v.webkitDecodedFrameCount === "number") {
      total = v.webkitDecodedFrameCount;
      dropped = typeof v.webkitDroppedFrameCount === "number" ? v.webkitDroppedFrameCount : 0;
    } else {
      const st = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      if (st) {
        total = st.totalVideoFrames;
        dropped = st.droppedVideoFrames;
      }
    }
    // 帧推进速率：两次采样间 currentTime 的推进 vs 真实时间（1 = 正常播放）
    if (lastSample) {
      const dtReal = (Date.now() - lastSample.real) / 1000;
      const dtMedia = v.currentTime - lastSample.t;
      if (dtReal > 0) {
        const rate = dtMedia / dtReal;
        if (rate < 0.5) reportLog("warn", `播放卡顿: 推进速率 ${(rate * 100).toFixed(0)}% (${dtMedia.toFixed(1)}s/${dtReal.toFixed(1)}s)`);
      }
    }
    lastSample = { real: Date.now(), t: v.currentTime };
    reportLog("info", `videoState: readyState=${v.readyState}, w=${v.videoWidth}, h=${v.videoHeight}, paused=${v.paused}, t=${v.currentTime.toFixed(1)}s` +
      (dropped !== null ? `, dropped=${dropped}, total=${total}` : ""));
  } catch {}
}
let lastSample = null;
setTimeout(reportVideoState, 4000);
setTimeout(reportVideoState, 12000);
setInterval(reportVideoState, 15000);

// 全屏观看：兼容 iOS 原生全屏 / 标准全屏
function goLandscape() {
  const el = video;

  try {
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    } else if (el.webkitEnterFullscreen) {
      el.webkitEnterFullscreen();
    }
  } catch (e) {}

  try {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock("landscape").catch(() => {});
    }
  } catch (e) {}
}

async function connect() {
  try {
    hideError();
    setStatus("CONNECTING");

    const response = await fetch("/api/cinema", { cache: "no-store" });

    if (!response.ok) {
      throw new Error("无法获取直播信息");
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || "LiveKit 信息获取失败");
    }

    reportLog("info", "fetch /api/cinema OK, room=" + (data.roomName || ""));

    room = new LivekitClient.Room({
      adaptiveStream: true,    // 观众端开启自适应：网络抖动时 LiveKit 自动降分辨率/码率保流畅（画面卡顿主因是抖动，降级比卡顿好）
      dynacast: false
    });

    room.on(
      LivekitClient.RoomEvent.TrackSubscribed,
      (track) => {
        reportLog("info", `TrackSubscribed: kind=${track.kind}, name=${track.name}`);
        if (
          track.kind === LivekitClient.Track.Kind.Video ||
          track.kind === LivekitClient.Track.Kind.Audio
        ) {
          attachTrack(track);
        }
      }
    );

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, track => {
      reportLog("info", `TrackUnsubscribed: kind=${track.kind}`);
      // detach 返回被分离的元素，同步从 mediaElements 移除，避免数组无限增长（内存泄漏）
      const els = track.detach();
      (Array.isArray(els) ? els : [els]).forEach(el => {
        if (el) {
          const i = mediaElements.indexOf(el);
          if (i >= 0) mediaElements.splice(i, 1);
        }
      });
    });

    room.on(LivekitClient.RoomEvent.TrackSubscriptionFailed, (kind, sid) => {
      reportLog("error", `TrackSubscriptionFailed: kind=${kind}, sid=${sid}`);
    });

    room.on(LivekitClient.RoomEvent.ConnectionStateChanged, state => {
      reportLog("info", `ConnectionState: ${state}`);
    });

    // 接收主播端的对齐时间戳
    room.on(LivekitClient.RoomEvent.DataReceived, (payload) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (data && data.type === "sync" && typeof data.t === "number") {
          handleSync(data.t);
        }
      } catch (e) {}
    });

    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      reportLog("warn", "房间已断开");
      setStatus("OFFLINE");
      waiting.style.display = "flex";
    });

    reportLog("info", "正在连接房间: " + data.livekitUrl);
    await room.connect(data.livekitUrl, data.viewerToken, {
      autoSubscribe: true,
      maxRetries: 5
    });
    reportLog("info", "房间连接成功, identity=" + room.localParticipant.identity);

    setStatus("CONNECTED");

    // 处理已经存在的远程参与者
    reportLog("info", `已有参与者: ${room.remoteParticipants.size} 个`);
    room.remoteParticipants.forEach(participant => {
      participant.trackPublications.forEach(publication => {
        reportLog("info", `已有发布: ${publication.trackSid}, kind=${publication.kind}, sub=${publication.isSubscribed}`);
        if (publication.isSubscribed && publication.track) {
          const track = publication.track;
          if (
            track.kind === LivekitClient.Track.Kind.Video ||
            track.kind === LivekitClient.Track.Kind.Audio
          ) {
            attachTrack(track);
          }
        }
      });
    });

  } catch (error) {
    console.error(error);
    reportLog("error", "connect 失败: " + (error && error.message ? error.message : error));
    setStatus("ERROR");
    showError(error.message);
    setTimeout(connect, 5000);
  }
}

// 事件绑定
// 开始观看按钮（覆盖视频区中央，iOS 必须点一下触发 play + unmute）
if (startOverlay) {
  startOverlay.addEventListener("click", e => {
    e.stopPropagation();
    handleStartClick();
  });
}

// 兜底：点击页面任意处，如果还 muted 就开启声音
document.addEventListener("click", () => {
  if (video && video.muted) {
    handleStartClick();
  }
});

fullscreenBtn.addEventListener("click", e => {
  e.stopPropagation();
  goLandscape();
});

connect();
