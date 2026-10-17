
/**
 * Stream Routes
 * /api/stream, /api/proxy, /api/music/find
 */

import { json, error, corsHeaders } from "../helpers/response.ts";
import {
  fetchFromPiped,
  fetchFromInvidious,
} from "../services/streaming.ts";
import type { YTMusic } from "../services/ytmusic.ts";

const STREAM_TIMEOUT_MS = 25000;

export async function handleStream(
  searchParams: URLSearchParams,
): Promise<Response> {
  const id = searchParams.get("id")?.trim();

  if (!id) {
    return error("Missing id");
  }

  // Basic validation for a YouTube video ID.
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return error("Invalid video id");
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutResponse = new Promise<Response>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(
        json(
          {
            success: false,
            error: "Stream request timed out",
            message:
              "Streaming providers did not respond within 25 seconds.",
          },
          504,
        ),
      );
    }, STREAM_TIMEOUT_MS);
  });

  const streamRequest = async (): Promise<Response> => {
    // Try Piped first.
    const piped = await fetchFromPiped(id);

    if (
      piped.success &&
      Array.isArray(piped.streamingUrls) &&
      piped.streamingUrls.length > 0
    ) {
      return json({
        success: true,
        service: "piped",
        instance: piped.instance,
        streamingUrls: piped.streamingUrls,
        metadata: piped.metadata,
        requestedId: id,
        timestamp: new Date().toISOString(),
      });
    }

    console.warn("Piped did not provide a stream for:", id);

    // Try Invidious if Piped fails.
    const invidious = await fetchFromInvidious(id);

    if (
      invidious.success &&
      Array.isArray(invidious.streamingUrls) &&
      invidious.streamingUrls.length > 0
    ) {
      return json({
        success: true,
        service: "invidious",
        instance: invidious.instance,
        streamingUrls: invidious.streamingUrls,
        metadata: invidious.metadata,
        requestedId: id,
        timestamp: new Date().toISOString(),
      });
    }

    console.warn("Invidious did not provide a stream for:", id);

    return json(
      {
        success: false,
        error: "No streaming data found",
        message:
          "All configured streaming providers failed or returned no audio streams.",
        requestedId: id,
        timestamp: new Date().toISOString(),
      },
      502,
    );
  };

  try {
    return await Promise.race([
      streamRequest(),
      timeoutResponse,
    ]);
  } catch (err) {
    console.error("Stream request failed:", String(err));

    return json(
      {
        success: false,
        error: "Stream request failed",
        message: String(err),
      },
      502,
    );
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export async function handleProxy(
  searchParams: URLSearchParams,
  req: Request,
): Promise<Response> {
  const audioUrl = searchParams.get("url");

  if (!audioUrl) {
    return error("Missing url");
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(audioUrl);
  } catch {
    return error("Invalid audio URL");
  }

  // Only allow HTTPS upstream URLs.
  if (parsedUrl.protocol !== "https:") {
    return error("Only HTTPS audio URLs are allowed");
  }

  try {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*",
    };

    const rangeHeader = req.headers.get("Range");

    if (rangeHeader) {
      headers["Range"] = rangeHeader;
    }

    const upstream = await fetch(parsedUrl.toString(), {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers,
      signal: AbortSignal.timeout(20000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      console.error("Audio upstream returned:", upstream.status);

      return new Response("Audio upstream failed", {
        status: 502,
        headers: corsHeaders,
      });
    }

    const responseHeaders = new Headers(corsHeaders);

    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set(
      "Access-Control-Allow-Methods",
      "GET, HEAD, OPTIONS",
    );
    responseHeaders.set(
      "Access-Control-Allow-Headers",
      "Range, Content-Type",
    );
    responseHeaders.set(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges",
    );

    responseHeaders.set(
      "Content-Type",
      upstream.headers.get("Content-Type") || "audio/mp4",
    );

    responseHeaders.set(
      "Accept-Ranges",
      upstream.headers.get("Accept-Ranges") || "bytes",
    );

    const contentLength = upstream.headers.get("Content-Length");
    const contentRange = upstream.headers.get("Content-Range");

    if (contentLength) {
      responseHeaders.set("Content-Length", contentLength);
    }

    if (contentRange) {
      responseHeaders.set("Content-Range", contentRange);
    }

    if (upstream.status === 206) {
      responseHeaders.set("Cache-Control", "no-store");
    }

    return new Response(
      req.method === "HEAD" ? null : upstream.body,
      {
        status: upstream.status,
        headers: responseHeaders,
      },
    );
  } catch (err) {
    console.error("Audio proxy failed:", String(err));

    return new Response("Audio proxy request failed", {
      status: 502,
      headers: corsHeaders,
    });
  }
}

export async function handleMusicFind(
  searchParams: URLSearchParams,
  ytmusic: YTMusic,
): Promise<Response> {
  const name = searchParams.get("name")?.trim();
  const artist = searchParams.get("artist")?.trim();

  if (!name || !artist) {
    return error("Missing name and artist");
  }

  try {
    const searchResults = await ytmusic.search(
      `${name} ${artist}`,
      "songs",
    );

    if (!searchResults.results?.length) {
      return json(
        {
          success: false,
          error: "Song not found",
        },
        404,
      );
    }

    const normalize = (value: string) =>
      value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/gi, "")
        .toLowerCase();

    const normalizedName = normalize(name);

    const artistsList = artist
      .split(",")
      .map((value) => normalize(value))
      .filter(Boolean);

    const match = searchResults.results.find((song: any) => {
      const songName = normalize(song.title || "");

      const songArtists = (song.artists || [])
        .map((item: any) => normalize(item.name || ""))
        .filter(Boolean);

      const nameMatches =
        songName === normalizedName ||
        (
          songName.length > 0 &&
          normalizedName.length > 0 &&
          (
            songName.includes(normalizedName) ||
            normalizedName.includes(songName)
          )
        );

      const artistMatches = artistsList.some((artistName) =>
        songArtists.some(
          (songArtist: string) =>
            songArtist === artistName ||
            songArtist.includes(artistName) ||
            artistName.includes(songArtist),
        )
      );

      return nameMatches && artistMatches;
    });

    if (!match) {
      return json(
        {
          success: false,
          error: "Song not found",
        },
        404,
      );
    }

    return json({
      success: true,
      data: match,
    });
  } catch (err) {
    console.error("Music find failed:", String(err));

    return json(
      {
        success: false,
        error: "Music search failed",
      },
      502,
    );
  }
}
