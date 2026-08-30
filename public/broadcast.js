const LK = window.LivekitClient;

const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const videoOnlyBtn = document.getElementById("videoOnlyBtn");

let room = null;
let localStream = null;

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = cls ? cls : "";
}

function showVideoOnlyOption() {
  videoOnlyBtn.style.display = "inline-block";
}

async function startShare(withAudio = true) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus("当前浏览器不支持屏幕共享，请用 Chrome / Edge", "error");
    return;
  }

  try {
    setStatus("请选择要共享的屏幕…");

    const videoConstraints = {
      frameRate: { ideal: 30, max: 30 },
      width: { ideal: 2560, max: 3840 },
      height: { ideal: 1440, max: 2160 }
    };

    const mediaOptions = {
      video: videoConstraints,
      audio: withAudio ? {
        echoCancellation: false,   // 关闭回声消除（电影不需要，且会破坏音质）
        noiseSuppression: false,   // 关闭噪声抑制（保留原始音质）
        autoGainControl: false,    // 关闭自动增益（解决"声音忽大忽小"）
        sampleRate: 48000,         // 48kHz 采样率
        channelCount: 2            // 立体声
      } : false
    };
    if (withAudio) {
      // 关键：让 Chrome/Edge 提供「共享系统音频」选项（而不是只有标签页音频）
      mediaOptions.systemAudio = "include";
    }

    try {
      localStream = await navigator.mediaDevices.getDisplayMedia(mediaOptions);
    } catch (audioErr) {
      const msg = String(audioErr.message || audioErr);
      if (withAudio && (msg.toLowerCase().includes("audio") || msg.includes("Could not start"))) {
        // 系统音频被占用：不自动二次弹窗，提示用户处理
        setStatus("系统音频被占用（请关闭 OBS 等音频程序）后重试，或点下方「仅共享画面」", "error");
        showVideoOnlyOption();
        return;
      }
      throw audioErr;
    }

    // 本地预览
    const vtrack = localStream.getVideoTracks()[0];

    setStatus("正在连接影院…");

    // 获取主播凭证
    const resp = await fetch("/api/broadcast", { cache: "no-store" });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || "获取主播凭证失败");

    // 连接房间
    room = new LK.Room({
      adaptiveStream: false,
      dynacast: false
    });

    room.on(LK.RoomEvent.Disconnected, () => {
      if (localStream) setStatus("连接已断开", "error");
    });

    await room.connect(data.livekitUrl, data.broadcasterToken);

    // 发布屏幕共享：H.264（Safari 兼容）+ 高码率
    if (vtrack) {
      await room.localParticipant.publishTrack(vtrack, {
        name: "screen",
        source: LK.Track.Source.ScreenShare,
        videoCodec: "h264",       // H.264 兼容 iOS/iPadOS Safari
        simulcast: false,         // 单观众无需多路
        screenShareEncoding: {
          maxBitrate: 12_000_000,  // 12 Mbps（1440p30 高质量）
          maxFramerate: 30
        }
      });
    }

    const atrack = localStream.getAudioTracks()[0];
    if (atrack) {
      await room.localParticipant.publishTrack(atrack, {
        name: "audio",
        source: LK.Track.Source.ScreenShareAudio,
        audioPreset: { maxBitrate: 128000 },  // 128kbps Opus 高音质
        forceStereo: false                      // 非强制立体声
      });
      setStatus("● 直播中（含音频）", "live");
    } else {
      setStatus("● 直播中（仅画面，未勾系统音频）", "live");
    }

    // 用户点了浏览器「停止共享」时自动收尾
    if (vtrack) {
      vtrack.addEventListener("ended", stopShare);
    }

    setStatus("● 直播中", "live");
    startBtn.style.display = "none";
    videoOnlyBtn.style.display = "none";
    stopBtn.style.display = "inline-block";

  } catch (err) {
    console.error(err);
    setStatus("启动失败：" + err.message, "error");
    cleanup();
  }
}

function stopShare() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (room) {
    room.disconnect();
    room = null;
  }
  setStatus("已停止");
  startBtn.style.display = "inline-block";
  videoOnlyBtn.style.display = "none";
  stopBtn.style.display = "none";
}

function cleanup() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (room) {
    room.disconnect();
    room = null;
  }
}

startBtn.addEventListener("click", () => startShare(true));
videoOnlyBtn.addEventListener("click", () => startShare(false));
stopBtn.addEventListener("click", stopShare);
