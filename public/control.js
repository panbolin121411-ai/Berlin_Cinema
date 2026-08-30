const $ = id => document.getElementById(id);

let currentPublicUrl = "";
let room = null;
let localStream = null;

function addLog(message, type = "info") {
  const logs = $("logs");
  const line = document.createElement("div");
  line.className = "log " + type;
  line.textContent = message;
  logs.appendChild(line);
  logs.scrollTop = logs.scrollHeight;
}

function setPublicUrl(url) {
  currentPublicUrl = url || "";
  $("publicUrl").textContent = url || "等待公网地址…";
  $("copyBtn").disabled = !url;
}

function setStreaming(streaming) {
  $("globalDot").classList.toggle("on", streaming);
  $("globalStatus").textContent = streaming ? "直播中" : "未开播";
  $("startBtn").style.display = streaming ? "none" : "block";
  $("stopBtn").style.display = streaming ? "block" : "none";
}

async function stopStreaming() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (room) {
    room.disconnect();
    room = null;
  }
}

async function startBroadcast() {
  // 检查 LiveKit 配置是否完整
  const cfg = await window.cinema.getConfig();
  if (!cfg.livekitUrl || !cfg.apiKey || !cfg.apiSecret) {
    addLog("请先填写 LiveKit 配置（点下方「⚙ 设置」）", "error");
    $("settings").style.display = "flex";
    $("livekitUrl").value = cfg.livekitUrl || "";
    $("apiKey").value = cfg.apiKey || "";
    $("apiSecret").value = cfg.apiSecret || "";
    return;
  }

  $("startBtn").disabled = true;
  $("startBtn").textContent = "启动中…";

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
      width: { ideal: 2560, max: 3840 },
      height: { ideal: 1440, max: 2160 }
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2
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

    // 4. 连接 LiveKit 并推流
    const LK = window.LivekitClient;
    room = new LK.Room({ adaptiveStream: false, dynacast: false });
    await room.connect(info.livekitUrl, info.broadcasterToken);

    const vtrack = stream.getVideoTracks()[0];
    if (vtrack) {
      await room.localParticipant.publishTrack(vtrack, {
        name: "screen",
        source: LK.Track.Source.ScreenShare,
        videoCodec: "h264",
        simulcast: false,
        screenShareEncoding: { maxBitrate: 12000000, maxFramerate: 30 }
      });
    }

    const atrack = stream.getAudioTracks()[0];
    if (atrack) {
      await room.localParticipant.publishTrack(atrack, {
        name: "audio",
        source: LK.Track.Source.ScreenShareAudio,
        audioPreset: { maxBitrate: 128000 },
        forceStereo: true
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

  } catch (err) {
    addLog("开播失败：" + (err.message || err), "error");
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
});

/* 窗口控制 */
$("btnMin").addEventListener("click", () => window.cinema.minimize());
$("btnClose").addEventListener("click", () => window.cinema.close());

/* 设置区 */
$("settingsToggle").addEventListener("click", () => {
  const el = $("settings");
  el.style.display = el.style.display === "none" ? "flex" : "none";
});

$("saveBtn").addEventListener("click", async () => {
  const cfg = {
    livekitUrl: $("livekitUrl").value.trim(),
    apiKey: $("apiKey").value.trim(),
    apiSecret: $("apiSecret").value.trim()
  };
  const result = await window.cinema.saveConfig(cfg);
  if (result.success) {
    addLog("设置已保存", "success");
    $("settings").style.display = "none";
  } else {
    addLog("保存失败", "error");
  }
});

/* 主进程事件 */
window.cinema.onLog(data => {
  addLog(`[${data.time}] ${data.message}`, data.type);
});

window.cinema.onPublicUrl(url => {
  setPublicUrl(url);
});

/* 初始状态 */
setStreaming(false);

// 加载已保存的 LiveKit 配置
window.cinema.getConfig().then(cfg => {
  $("livekitUrl").value = cfg.livekitUrl || "";
  $("apiKey").value = cfg.apiKey || "";
  $("apiSecret").value = cfg.apiSecret || "";
}).catch(() => {});

addLog("点击「一键开播」开始", "success");
