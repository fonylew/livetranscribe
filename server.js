/**
 * Lightweight zero-dependency HTTP + HTTPS multiplexed server (on a single port!)
 * and WebSocket relay hub.
 *
 * Why multiplex HTTP and HTTPS on the SAME port (0.0.0.0:3000)?
 * - When accessing the app via a LAN IP (e.g. `http://192.168.10.61:3000`), Chrome/Edge/Safari
 *   block `navigator.mediaDevices.getUserMedia` and `AudioWorklet` on plain `http://`
 *   (`navigator.mediaDevices` is `undefined`).
 * - By sniffing the first byte of each TCP connection on port 3000 (`0x16` = TLS vs plain HTTP),
 *   the server accepts BOTH `http://...:3000` and `https://...:3000` on the same port, and
 *   automatically redirects plain HTTP operator visits on LAN IPs to `https://<host>:3000/`
 *   so `getUserMedia` and `AudioWorklet` always work!
 * - Meanwhile, `http://<host>:3000/?view=display` (OBS Browser Source) continues to work over
 *   both plain HTTP and HTTPS without requiring mic permissions.
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
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Connected WebSocket clients on `/ws-relay` (shared across HTTP and HTTPS) */
const clients = new Set();

/** Latest snapshot so a newly opened OBS Browser Source catches up immediately */
let latestSnapshot = null;

function isLoopbackHost(hostHeader = "") {
  const hostname = String(hostHeader).split(":")[0].toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function handleHttpRequest(req, res) {
  const isEncrypted = Boolean(req.socket?.encrypted);
  const hostHeader = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url || "/", `${isEncrypted ? "https" : "http"}://${hostHeader}`);

  // If an operator opens plain HTTP on a non-localhost IP (e.g. http://192.168.10.61:3000/),
  // browsers disable `navigator.mediaDevices.getUserMedia`. Redirect automatically to
  // `https://<host>:3000/` on the same port so the browser enables Microphone/Line-In access!
  const isDisplayView = url.searchParams.get("view") === "display" || url.searchParams.get("obs") === "1";
  if (
    !isEncrypted &&
    !isLoopbackHost(hostHeader) &&
    !isDisplayView &&
    (url.pathname === "/" || url.pathname === "/index.html")
  ) {
    res.writeHead(302, {
      Location: `https://${hostHeader}${req.url || "/"}`,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, clients: clients.size, https: isEncrypted }));
    return;
  }

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
    clients.add(socket);

    if (latestSnapshot) {
      sendWsText(socket, JSON.stringify(latestSnapshot));
    }

    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const frame = decodeWsFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.totalLength);

        if (frame.opcode === 0x8) {
          clients.delete(socket);
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
              latestSnapshot = parsed;
            }
          } catch {
            // Ignore malformed JSON
          }
          for (const peer of clients) {
            if (peer !== socket && !peer.destroyed) {
              sendWsText(peer, text);
            }
          }
        }
      }
    });

    const cleanup = () => {
      clients.delete(socket);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
}

function getOrCreateTlsCredentials() {
  const certDir = path.join(os.tmpdir(), "livetranscribe-cert-v2");
  const keyPath = path.join(certDir, "key.pem");
  const certPath = path.join(certDir, "cert.pem");

  try {
    fs.mkdirSync(certDir, { recursive: true });
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      // Collect local IPv4 addresses for Subject Alternative Name (SAN)
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

/**
 * Create a single server that accepts BOTH HTTP and HTTPS connections on the same port.
 */
export function createAppServer() {
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
      // 0x16 is the TLS handshake record content type
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
    console.log(`LiveTranscribe (HTTP + HTTPS multiplexed) listening on ${HOST}:${PORT}`);
    console.log(`  Local Operator View:  http://localhost:${PORT}/`);
    console.log(`  LAN Operator View:    https://192.168.10.61:${PORT}/  (http:// auto-redirects to https://)`);
    console.log(`  OBS Browser Source:   http://localhost:${PORT}/?view=display`);
  });
}
