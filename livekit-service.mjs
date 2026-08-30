import {
  LiveKitAPI,
  AccessToken,
  IngressInput
} from "livekit-server-sdk";

const ROOM_NAME = "berlin-cinema";

// WHIP 直通推流（不转码）：
// 免费层 Ingress 转码配额只有 60 分钟/月，RTMP 会强制转码，
// 看一部电影都不够。WHIP 直通不消耗转码配额，只算下行流量。
const INGRESS_NAME = "Berlin Cinema WHIP";

const PARTICIPANT_IDENTITY = "obs-whip";

const PARTICIPANT_NAME = "Berlin Cinema WHIP";

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

function getApi() {
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;

  if (!url) {
    throw new Error("LIVEKIT_URL 未设置");
  }

  if (!key) {
    throw new Error("LIVEKIT_API_KEY 未设置");
  }

  if (!secret) {
    throw new Error("LIVEKIT_API_SECRET 未设置");
  }

  return new LiveKitAPI({
    // 服务端 SDK 需要 http(s)://，环境变量可能是 wss://
    host: normalizeHttpUrl(url),
    apiKey: key,
    secret
  });
}

export async function getIngress() {
  const api = getApi();

  const list = await api.ingress.listIngress({
    roomName: ROOM_NAME
  });

  let ingress = list.find(
    (item) =>
      item.name === INGRESS_NAME ||
      item.participantIdentity === PARTICIPANT_IDENTITY
  );

  if (!ingress) {
    ingress = await api.ingress.createIngress(
      IngressInput.WHIP_INPUT,
      {
        name: INGRESS_NAME,
        roomName: ROOM_NAME,
        participantIdentity: PARTICIPANT_IDENTITY,
        participantName: PARTICIPANT_NAME,

        // WHIP 直通，不转码（免费层不消耗转码配额）
        enableTranscoding: false
      }
    );
  }

  return ingress;
}

export async function getViewerToken() {
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;

  const token = new AccessToken(
    key,
    secret,
    {
      identity:
        "viewer-" +
        Math.random()
          .toString(36)
          .substring(2),

      name: "Berlin Cinema Viewer",

      ttl: "12h"
    }
  );

  token.addGrant({
    roomJoin: true,
    room: ROOM_NAME,
    canPublish: false,
    canSubscribe: true
  });

  return await token.toJwt();
}

// 主播凭证：允许推流（屏幕共享），固定身份便于识别
export async function getBroadcasterToken() {
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;

  const token = new AccessToken(
    key,
    secret,
    {
      identity: "broadcaster",
      name: "Berlin Cinema Broadcaster",
      ttl: "12h"
    }
  );

  token.addGrant({
    roomJoin: true,
    room: ROOM_NAME,
    canPublish: true,
    canSubscribe: true
  });

  return await token.toJwt();
}

export async function getBroadcastInfo() {
  const broadcasterToken =
    await getBroadcasterToken();

  return {
    roomName: ROOM_NAME,
    broadcasterToken,
    livekitUrl: normalizeWsUrl(
      process.env.LIVEKIT_URL
    )
  };
}

export async function getCinemaInfo() {
  const ingress = await getIngress();

  const viewerToken =
    await getViewerToken();

  return {
    roomName: ROOM_NAME,

    ingressId:
      ingress.ingressId,

    // WHIP 推流地址（OBS 服务 URL）
    whipUrl:
      ingress.url,

    // WHIP Bearer Token（OBS 流密钥）
    bearerToken:
      ingress.streamKey,

    viewerToken,

    // 浏览器端 livekit-client 连接地址统一为 wss://
    livekitUrl:
      normalizeWsUrl(
        process.env.LIVEKIT_URL
      ),

    state:
      ingress.state
  };
}

if (
  process.argv[1] &&
  process.argv[1].endsWith(
    "livekit-service.mjs"
  )
) {
  const info =
    await getCinemaInfo();

  console.log(
    JSON.stringify(
      info,
      null,
      2
    )
  );
}