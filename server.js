/**
 * LiveTranscribe Server (Cloud Run + Local LAN Ready)
 *
 * Capabilities:
 * 1. Loads `.env` (`GEMINI_API_KEY`, `GCS_BUCKET`, `FIRESTORE_COLLECTION`, `GCP_PROJECT_ID`).
 * 2. Isolates multiple concurrent sessions by browser cookie (`lt_token`) and/or `?token=` query param
 *    so multiple events/operators can use the same Cloud Run deployment simultaneously, and OBS views
 *    opened in the same browser (via cookie) or OBS Studio Browser Source (via `?token=`) pair automatically.
 * 3. Persists session transcriptions in SubRip (`.srt`) format locally, in Google Cloud Storage (GCS),
 *    and in Google Cloud Firestore.
 * 4. Multiplexes HTTP and HTTPS on a single port (`PORT`, default 3000) for local LAN microphone access
 *    while supporting Cloud Run's `x-forwarded-proto: https` header.
 */

import net from "node:net";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "./lib/env.js";
import { sanitizeId, SessionStore } from "./lib/storage.js";

loadDotEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function parseCookies(cookieHeader = "") {
  const out = {};
  for (const pair of String(cookieHeader).split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Resolve or mint the browser/channel token (`lt_token`) that links an Operator tab,
 * its OBS Display View, and its saved `.srt` sessions.
 */
function resolveClientToken(req, url) {
  const fromQuery = url.searchParams.get("token");
  if (fromQuery && sanitizeId(fromQuery, "")) {
    return { token: sanitizeId(fromQuery), isNew: true };
  }

  const fromHeader = req.headers["x-lt-token"];
  if (fromHeader && sanitizeId(fromHeader, "")) {
    return { token: sanitizeId(fromHeader), isNew: false };
  }

  const cookies = parseCookies(req.headers.cookie || "");
  if (cookies.lt_token && sanitizeId(cookies.lt_token, "")) {
    return { token: sanitizeId(cookies.lt_token), isNew: false };
  }

  const generated = `lt_${crypto.randomBytes(8).toString("hex")}`;
  return { token: generated, isNew: true };
}

function isLoopbackHost(hostHeader = "") {
  const hostname = String(hostHeader).split(":")[0].toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function readJsonBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

export function createAppServer({
  dataDir = path.join(__dirname, "data", "sessions"),
  fetchImpl = fetch,
  sessionStore = null,
  envApiKey: explicitEnvApiKey = undefined,
} = {}) {
  const store = sessionStore || new SessionStore({ dataDir, fetchImpl });

  /**
   * Isolated rooms keyed by `clientToken`:
   * Map<string, { clients: Set<net.Socket>, latestSnapshot: object | null }>
   */
  const rooms = new Map();

  function getRoom(token) {
    let room = rooms.get(token);
    if (!room) {
      room = { clients: new Set(), latestSnapshot: null };
      rooms.set(token, room);
    }
    return room;
  }

  async function handleHttpRequest(req, res) {
    const isEncrypted =
      Boolean(req.socket?.encrypted) ||
      String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
    const hostHeader = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url || "/", `${isEncrypted ? "https" : "http"}://${hostHeader}`);

    const { token: clientToken, isNew } = resolveClientToken(req, url);
    const cookieHeader = isNew
      ? {
          "Set-Cookie": `lt_token=${encodeURIComponent(clientToken)}; Path=/; Max-Age=31536000; SameSite=Lax`,
        }
      : {};

    // Auto-redirect plain HTTP operator requests on non-loopback LAN IPs to HTTPS
    const isDisplayView =
      url.searchParams.get("view") === "display" || url.searchParams.get("obs") === "1";
    if (
      !isEncrypted &&
      !isLoopbackHost(hostHeader) &&
      !isDisplayView &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      res.writeHead(302, {
        Location: `https://${hostHeader}${req.url || "/"}`,
        "Cache-Control": "no-store",
        ...cookieHeader,
      });
      res.end();
      return;
    }

    // 1. Health endpoint
    if (url.pathname === "/api/health") {
      let totalClients = 0;
      for (const r of rooms.values()) totalClients += r.clients.size;
      sendJson(
        res,
        200,
        {
          ok: true,
          clients: totalClients,
          rooms: rooms.size,
          https: isEncrypted,
        },
        cookieHeader
      );
      return;
    }

    // 2. Runtime Config & .env API key endpoint
    if (url.pathname === "/api/config" && req.method === "GET") {
      const envApiKey = (
        explicitEnvApiKey ??
        process.env.GEMINI_API_KEY ??
        process.env.GOOGLE_API_KEY ??
        ""
      ).trim();
      sendJson(
        res,
        200,
        {
          ok: true,
          clientToken,
          hasEnvApiKey: Boolean(envApiKey),
          envApiKey,
          storage: {
            local: true,
            gcs: Boolean(store.gcsBucket),
            gcsBucket: store.gcsBucket || null,
            firestore: Boolean(store.firestoreEnabled),
            firestoreEnabled: store.firestoreEnabled,
            firestoreCollection: store.firestoreCollection,
          },
        },
        cookieHeader
      );
      return;
    }

    // 3. List or Save Sessions (`/api/sessions`)
    if (url.pathname === "/api/sessions") {
      if (req.method === "GET") {
        const sessions = await store.listSessions(clientToken);
        sendJson(res, 200, { ok: true, clientToken, sessions }, cookieHeader);
        return;
      }

      if (req.method === "POST") {
        try {
          const body = await readJsonBody(req);
          const saved = await store.saveSession(clientToken, body, {
            syncCloud: body.syncCloud !== false,
          });
          sendJson(res, 200, { ok: true, session: saved }, cookieHeader);
        } catch (err) {
          sendJson(
            res,
            400,
            { ok: false, error: err?.message || "Invalid session data" },
            cookieHeader
          );
        }
        return;
      }
    }

    // 4. Get Single Session or Download `.srt` (`/api/sessions/:sessionId[/srt]`)
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)(\/srt)?$/);
    if (sessionMatch && req.method === "GET") {
      const sessionId = sessionMatch[1];
      const isSrtDownload = Boolean(sessionMatch[2]);
      const session = await store.getSession(clientToken, sessionId);
      if (!session) {
        sendJson(res, 404, { ok: false, error: "Session not found" }, cookieHeader);
        return;
      }

      if (isSrtDownload) {
        const lang = url.searchParams.get("lang") || "combined";
        const content =
          lang === "th"
            ? session.srtThai
            : lang === "en"
              ? session.srtEnglish
              : session.srtCombined;
        const suffix = lang === "th" ? ".th.srt" : lang === "en" ? ".en.srt" : ".srt";
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${session.sessionId}${suffix}"`,
          "Cache-Control": "no-store",
          ...cookieHeader,
        });
        res.end(content || "");
        return;
      }

      sendJson(res, 200, { ok: true, session }, cookieHeader);
      return;
    }

    // 5. Static Files
    let reqPath = decodeURIComponent(url.pathname);
    if (reqPath === "/") reqPath = "/index.html";

    const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        ...cookieHeader,
      });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  function attachWsRelay(server) {
    server.on("upgrade", (req, socket) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== "/ws-relay") {
        socket.destroy();
        return;
      }

      const key = req.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }

      const { token: clientToken } = resolveClientToken(req, url);
      const room = getRoom(clientToken);

      const accept = crypto
        .createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "\r\n",
        ].join("\r\n")
      );

      socket.setNoDelay(true);
      room.clients.add(socket);

      // Immediately send the room's latest snapshot to a newly opened OBS view
      if (room.latestSnapshot) {
        sendWsText(socket, JSON.stringify(room.latestSnapshot));
      }

      let buffer = Buffer.alloc(0);

      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const frame = decodeWsFrame(buffer);
          if (!frame) break;
          buffer = buffer.subarray(frame.totalLength);

          if (frame.opcode === 0x8) {
            room.clients.delete(socket);
            socket.end();
            return;
          }
          if (frame.opcode === 0x9) {
            sendWsFrame(socket, 0x0a, frame.payload);
            continue;
          }
          if (frame.opcode === 0x1) {
            const text = frame.payload.toString("utf8");
            try {
              const parsed = JSON.parse(text);
              if (parsed.type === "snapshot") {
                room.latestSnapshot = parsed;
              }
            } catch {
              // Ignore malformed JSON
            }
            for (const peer of room.clients) {
              if (peer !== socket && !peer.destroyed) {
                sendWsText(peer, text);
              }
            }
          }
        }
      });

      const cleanup = () => {
        room.clients.delete(socket);
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    });
  }

  const httpServer = http.createServer(handleHttpRequest);
  attachWsRelay(httpServer);

  const creds = getOrCreateTlsCredentials();
  if (!creds) {
    return httpServer;
  }

  const httpsServer = https.createServer(creds, handleHttpRequest);
  attachWsRelay(httpsServer);

  const muxServer = net.createServer((socket) => {
    socket.once("readable", () => {
      const chunk = socket.read(1);
      if (!chunk) return;
      socket.unshift(chunk);
      if (chunk[0] === 0x16) {
        httpsServer.emit("connection", socket);
      } else {
        httpServer.emit("connection", socket);
      }
    });
    socket.on("error", () => {});
  });

  return muxServer;
}

function getOrCreateTlsCredentials() {
  const certDir = path.join(os.tmpdir(), "livetranscribe-cert-v2");
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");

  try {
    fs.mkdirSync(certDir, { recursive: true });
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      const nets = os.networkInterfaces();
      const sanEntries = ["DNS:localhost", "IP:127.0.0.1", "IP:0.0.0.0"];
      for (const iface of Object.values(nets)) {
        for (const addr of iface || []) {
          if (addr.family === "IPv4" && !sanEntries.includes(`IP:${addr.address}`)) {
            sanEntries.push(`IP:${addr.address}`);
          }
        }
      }
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "365",
          "-subj",
          "/CN=livetranscribe.local",
          "-addext",
          `subjectAltName=${sanEntries.join(",")}`,
        ],
        { stdio: "ignore" }
      );
    }
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
  } catch {
    return null;
  }
}

function decodeWsFrame(buf) {
  if (buf.length < 2) return null;
  const firstByte = buf[0];
  const secondByte = buf[1];
  const opcode = firstByte & 0x0f;
  const isMasked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buf.length < 4) return null;
    payloadLength = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buf.length < 10) return null;
    payloadLength = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  const maskLength = isMasked ? 4 : 0;
  const totalLength = offset + maskLength + payloadLength;
  if (buf.length < totalLength) return null;

  let payload = buf.subarray(offset + maskLength, totalLength);
  if (isMasked) {
    const mask = buf.subarray(offset, offset + 4);
    const unmasked = Buffer.allocUnsafe(payloadLength);
    for (let i = 0; i < payloadLength; i++) {
      unmasked[i] = payload[i] ^ mask[i & 3];
    }
    payload = unmasked;
  }

  return { opcode, payload, totalLength };
}

function sendWsText(socket, text) {
  sendWsFrame(socket, 0x01, Buffer.from(text, "utf8"));
}

function sendWsFrame(socket, opcode, payload) {
  if (socket.destroyed) return;
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createAppServer();
  server.listen(PORT, HOST, () => {
    console.log(`LiveTranscribe listening on ${HOST}:${PORT}`);
    console.log(`  Local Operator View:  http://localhost:${PORT}/`);
    console.log(`  OBS Browser Source:   http://localhost:${PORT}/?view=display`);
  });
}
