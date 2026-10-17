
/**
 * Streaming Service
 * Fetches audio stream URLs from Piped and Invidious instances.
 */

type StreamingInstanceList = {
  piped: string[];
  invidious: string[];
};

let instancesCache: StreamingInstanceList | null = null;
let instancesCacheTime = 0;

const CACHE_DURATION = 5 * 60 * 1000;
const REQUEST_TIMEOUT = 8000;

const PIPED_INSTANCES = [
  "https://api.piped.private.coffee",
  "https://pipedapi.darkness.services",
  "https://pipedapi.r4fo.com",
  "https://api.piped.yt",
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.in.projectsegfau.lt",
  "https://api.piped.projectsegfau.lt",
  "https://pipedapi.leptons.xyz",
];

const FALLBACK_INVIDIOUS_INSTANCES = [
  "https://y.com.sb",
  "https://inv.nadeko.net",
];

async function getDynamicInstances(): Promise<StreamingInstanceList> {
  const now = Date.now();

  if (
    instancesCache &&
    now - instancesCacheTime < CACHE_DURATION
  ) {
    return instancesCache;
  }

  try {
    const response = await fetch(
      "https://raw.githubusercontent.com/n-ce/Uma/main/dynamic_instances.json",
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT) },
    );

    if (!response.ok) {
      throw new Error(`Instance list HTTP ${response.status}`);
    }

    const data = await response.json();

    instancesCache = {
      // Keep the configured Piped list and use the fetched
      // Invidious list when it is valid.
      piped: PIPED_INSTANCES,
      invidious:
        Array.isArray(data?.invidious) && data.invidious.length > 0
          ? data.invidious.filter(
              (url: unknown): url is string =>
                typeof url === "string" &&
                url.startsWith("https://"),
            )
          : FALLBACK_INVIDIOUS_INSTANCES,
    };

    instancesCacheTime = now;
    return instancesCache;
  } catch (err) {
    console.warn("Could not load dynamic instances:", String(err));

    return {
      piped: PIPED_INSTANCES,
      invidious: FALLBACK_INVIDIOUS_INSTANCES,
    };
  }
}

export async function fetchFromPiped(videoId: string) {
  const instances = await getDynamicInstances();

  for (const instance of instances.piped) {
    try {
      const response = await fetch(
        `${instance}/streams/${encodeURIComponent(videoId)}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        },
      );

      if (!response.ok) {
        console.warn(`Piped ${instance}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();

      if (
        !Array.isArray(data?.audioStreams) ||
        data.audioStreams.length === 0
      ) {
        console.warn(`Piped ${instance}: no audio streams`);
        continue;
      }

      const instanceUrl = new URL(instance);
      const proxyHost = instanceUrl.host
        .replace("pipedapi", "pipedproxy")
        .replace("api.", "proxy.");

      return {
        success: true,
        service: "piped",
        instance,
        streamingUrls: data.audioStreams
          .filter((s: any) => typeof s.url === "string" && s.url)
          .map((s: any) => ({
            url: s.url,
            quality: s.quality,
            mimeType: s.mimeType,
            bitrate: s.bitrate,
            proxyHost,
          })),
        metadata: {
          id: videoId,
          title: data.title,
          uploader: data.uploader,
          thumbnail: data.thumbnailUrl,
          duration: data.duration,
          views: data.views,
        },
        hlsUrl: data.hls,
      };
    } catch (err) {
      console.warn(`Piped ${instance} failed:`, String(err));
    }
  }

  return {
    success: false,
    error: "No working Piped instances found",
  };
}

export async function fetchFromInvidious(videoId: string) {
  const instances = await getDynamicInstances();

  for (const instance of instances.invidious) {
    try {
      const response = await fetch(
        `${instance}/api/v1/videos/${encodeURIComponent(videoId)}`,
        {
          headers: {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        },
      );

      if (!response.ok) {
        console.warn(`Invidious ${instance}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();

      const audioFormats = (
        Array.isArray(data?.adaptiveFormats) ? data.adaptiveFormats : []
      ).filter(
        (f: any) =>
          typeof f.url === "string" &&
          f.url &&
          (
            f.type?.includes("audio") ||
            f.mimeType?.includes("audio")
          ),
      );

      if (audioFormats.length === 0) {
        console.warn(`Invidious ${instance}: no audio formats`);
        continue;
      }

      return {
        success: true,
        service: "invidious",
        instance,
        streamingUrls: audioFormats.map((f: any) => ({
          url: `${instance}/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(String(f.itag))}`,
          directUrl: f.url,
          bitrate: f.bitrate,
          type: f.type || f.mimeType,
          audioQuality: f.audioQuality,
          itag: f.itag,
        })),
        metadata: {
          id: videoId,
          title: data.title,
          author: data.author,
          thumbnail: data.videoThumbnails?.[0]?.url,
          lengthSeconds: data.lengthSeconds,
          viewCount: data.viewCount,
        },
      };
    } catch (err) {
      console.warn(`Invidious ${instance} failed:`, String(err));
    }
  }

  return {
    success: false,
    error: "No working Invidious instances found",
  };
}
