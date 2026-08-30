let video = document.getElementById("video");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("statusText");
const waiting = document.getElementById("waiting");
const errorBox = document.getElementById("error");
const fullscreenBtn = document.getElementById("fullscreen");

let room = null;
const mediaElements = [];

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

  const element = track.attach();
  element.autoplay = true;
  element.playsInline = true;

  if (track.kind === "video") {
    element.muted = true;     // 先静音自动播放画面（iOS 允许）
    video.replaceWith(element);
    element.id = "video";
    video = element;
  }

  mediaElements.push(element);

  waiting.style.display = "none";
  setStatus("LIVE", true);
}

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

    room = new LivekitClient.Room({
      adaptiveStream: false,
      dynacast: false
    });

    room.on(
      LivekitClient.RoomEvent.TrackSubscribed,
      (track) => {
        if (
          track.kind === LivekitClient.Track.Kind.Video ||
          track.kind === LivekitClient.Track.Kind.Audio
        ) {
          attachTrack(track);
        }
      }
    );

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, track => {
      track.detach();
    });

    room.on(LivekitClient.RoomEvent.Disconnected, () => {
      setStatus("OFFLINE");
      waiting.style.display = "flex";
    });

    await room.connect(data.livekitUrl, data.viewerToken, {
      autoSubscribe: true,
      maxRetries: 5
    });

    setStatus("CONNECTED");

    // 处理已经存在的远程参与者
    room.remoteParticipants.forEach(participant => {
      participant.trackPublications.forEach(publication => {
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
    setStatus("ERROR");
    showError(error.message);
    setTimeout(connect, 5000);
  }
}

// 事件绑定
// 点击页面任意处开启声音（iOS 需要用户手势）
document.addEventListener("click", () => {
  if (!video.muted) return;
  enableSound();
});

fullscreenBtn.addEventListener("click", e => {
  e.stopPropagation();
  goLandscape();
});

connect();
