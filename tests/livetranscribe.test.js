import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";

import {
  buildBidirectionalInstruction,
  cleanTranscriptSpacing,
  detectLanguage,
  parseGlossaryText,
} from "../public/lib/instructions.js";
import {
  AUDIO_TOKENS_PER_SECOND,
  computeUsageMetrics,
  DEFAULT_MODEL,
  emptyUsage,
  formatClock,
  formatTHB,
  formatTokenCount,
  formatUSD,
  noteAudioIn,
  noteAudioOut,
  noteAudioSaved,
} from "../public/lib/usage.js";
import {
  buildSetup,
  LiveSession,
  UPLINK_CHUNK_BYTES,
} from "../public/lib/live-session.js";
import { SessionLoop } from "../public/lib/session-loop.js";
import { createAppServer } from "../server.js";

function httpGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Connection: "close", ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function encodeMaskedClientTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  const header = Buffer.from([0x81, 0x80 | payload.length]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i & 3];
  }
  return Buffer.concat([header, mask, masked]);
}

test("server: serves static assets, redirects LAN HTTP operator to HTTPS, allows HTTP OBS display, and relays /ws-relay", async () => {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    // 1. Localhost operator view returns 200 OK over HTTP
    const res = await httpGet(port, "/", { Host: `localhost:${port}` });
    assert.equal(res.status, 200);
    assert.match(res.body, /LiveTranscribe/);
    assert.match(res.body, /0 tokens/);

    // 2. LAN IP plain HTTP operator view auto-redirects (302) to HTTPS so getUserMedia works
    const lanRes = await httpGet(port, "/", { Host: `192.168.10.61:${port}` });
    assert.equal(lanRes.status, 302);
    assert.equal(lanRes.headers.location, `https://192.168.10.61:${port}/`);

    // 3. LAN IP plain HTTP OBS Display View (?view=display) returns 200 OK without redirect
    const obsRes = await httpGet(port, "/?view=display", { Host: `192.168.10.61:${port}` });
    assert.equal(obsRes.status, 200);
    assert.match(obsRes.body, /LiveTranscribe/);

    // 4. Health check endpoint
    const healthRes = await httpGet(port, "/api/health");
    assert.equal(healthRes.status, 200);
    const health = JSON.parse(healthRes.body);
    assert.equal(health.ok, true);

    // 5. WebSocket /ws-relay broadcast between Operator and OBS Display client
    const obsReceived = await new Promise((resolve, reject) => {
      const key1 = crypto.randomBytes(16).toString("base64");
      const obsReq = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/ws-relay",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key1,
          "Sec-WebSocket-Version": "13",
        },
      });

      obsReq.on("upgrade", (_res, obsSocket) => {
        obsSocket.on("data", (chunk) => {
          const len = chunk[1] & 0x7f;
          const text = chunk.subarray(2, 2 + len).toString("utf8");
          obsSocket.destroy();
          resolve(JSON.parse(text));
        });

        // Connect Operator WebSocket and send a live snapshot
        const key2 = crypto.randomBytes(16).toString("base64");
        const opReq = http.request({
          hostname: "127.0.0.1",
          port,
          path: "/ws-relay",
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Key": key2,
            "Sec-WebSocket-Version": "13",
          },
        });
        opReq.on("upgrade", (_r2, opSocket) => {
          const snapshot = JSON.stringify({
            type: "snapshot",
            running: true,
            currentTurn: { input: "สวัสดี", output: "Hello" },
          });
          opSocket.write(encodeMaskedClientTextFrame(snapshot));
          setTimeout(() => opSocket.destroy(), 20);
        });
        opReq.on("error", reject);
        opReq.end();
      });

      obsReq.on("error", reject);
      obsReq.end();
    });

    assert.equal(obsReceived.type, "snapshot");
    assert.equal(obsReceived.currentTurn.input, "สวัสดี");
    assert.equal(obsReceived.currentTurn.output, "Hello");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("instructions: builds bidirectional Thai ⇄ English prompt with glossary & context", () => {
  const glossary = parseGlossaryText("Kubernetes = Kubernetes\nกรุงเทพมหานคร -> Bangkok");
  assert.equal(glossary.length, 2);
  assert.deepEqual(glossary[0], { source: "Kubernetes", target: "Kubernetes" });
  assert.deepEqual(glossary[1], { source: "กรุงเทพมหานคร", target: "Bangkok" });

  const instruction = buildBidirectionalInstruction({
    langA: "th",
    langB: "en",
    glossary,
    eventContext: "Cloud Native Summit Bangkok",
  });

  assert.match(instruction, /Thai \(ภาษาไทย\)/);
  assert.match(instruction, /English/);
  assert.match(
    instruction,
    /When the speaker speaks in Thai \(ภาษาไทย\), interpret it directly into English/
  );
  assert.match(
    instruction,
    /When the speaker speaks in English, interpret it directly into Thai \(ภาษาไทย\)/
  );
  assert.match(instruction, /Cloud Native Summit Bangkok/);
  assert.match(instruction, /- กรุงเทพมหานคร → Bangkok/);
});

test("instructions: detects Thai vs English accurately", () => {
  assert.equal(detectLanguage("สวัสดีครับ ยินดีต้อนรับสู่การประชุม"), "th");
  assert.equal(detectLanguage("สวัสดีครับ วันนี้เราจะพูดเรื่อง Kubernetes Cluster"), "th");
  assert.equal(detectLanguage("Welcome everyone to our keynote session today."), "en");
  assert.equal(detectLanguage(""), "auto");
});

test("instructions: cleans extra spaces between Thai characters", () => {
  const raw = "สวัสดี  ครับ ทุกท่าน";
  assert.equal(cleanTranscriptSpacing(raw), "สวัสดี ครับ ทุกท่าน");
});

test("usage: calculates tokens (for main screen) and API cost (for popover) + saved tokens when mic is off", () => {
  const usage = emptyUsage();
  noteAudioIn(usage, 10); // 10s * 25 = 250 input tokens
  noteAudioOut(usage, 8); // 8s * 25 = 200 output tokens
  noteAudioSaved(usage, 20); // 20s mic off * 25 = 500 saved tokens

  const metrics = computeUsageMetrics(usage, DEFAULT_MODEL, {
    elapsedSeconds: 30,
    usdToThb: 35,
  });

  assert.equal(metrics.inTokens, 10 * AUDIO_TOKENS_PER_SECOND);
  assert.equal(metrics.outTokens, 8 * AUDIO_TOKENS_PER_SECOND);
  assert.equal(metrics.totalTokens, 450);
  assert.equal(metrics.savedTokens, 500);

  // Main screen formatter shows ONLY token count, never dollar/baht price
  const mainPillText = formatTokenCount(metrics.totalTokens);
  assert.equal(mainPillText, "450 tokens");
  assert.equal(/\$|฿/.test(mainPillText), false);

  // Popover cost calculations
  // 250 * $3/1M + 200 * $12/1M = $0.00075 + $0.0024 = $0.00315
  assert.ok(Math.abs(metrics.costUSD - 0.00315) < 1e-9);
  assert.ok(Math.abs(metrics.costTHB - 0.00315 * 35) < 1e-9);
  assert.equal(formatUSD(metrics.costUSD), "$0.0032");
  assert.equal(formatTHB(metrics.costTHB), "฿0.110");
  assert.equal(formatClock(125), "02:05");
});

test("live-session: buildSetup creates valid Gemini 3.8 Live setup and sends audioStreamEnd when mic is off", async () => {
  const setupFrame = buildSetup({ model: "gemini-3.8-live" });
  assert.equal(setupFrame.setup.model, "models/gemini-3.8-live");
  assert.deepEqual(setupFrame.setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.deepEqual(setupFrame.setup.inputAudioTranscription, {});
  assert.deepEqual(setupFrame.setup.outputAudioTranscription, {});

  const sentFrames = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      setTimeout(() => {
        this.onopen?.();
        // Server acknowledges setupComplete
        this.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
      }, 5);
    }
    send(data) {
      sentFrames.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
    }
  }

  const events = [];
  const session = new LiveSession({
    apiKey: "test-key",
    setup: setupFrame,
    onEvent: (ev) => events.push(ev),
    WebSocketClass: FakeWebSocket,
  });

  await session.open();
  assert.equal(sentFrames.length, 1);
  assert.ok(sentFrames[0].setup);

  // Send a full 32ms chunk of PCM audio
  const pcmChunk = new ArrayBuffer(UPLINK_CHUNK_BYTES);
  session.send(pcmChunk);
  assert.equal(sentFrames.length, 2);
  assert.ok(sentFrames[1].realtimeInput?.audio?.data);

  // Simulate Mic OFF -> sendAudioStreamEnd()
  session.sendAudioStreamEnd();
  assert.equal(sentFrames.length, 3);
  assert.deepEqual(sentFrames[2], {
    realtimeInput: { audioStreamEnd: true },
  });

  // Simulate server sending Thai input transcription and English output translation
  session._dispatch({
    serverContent: {
      inputTranscription: { text: "สวัสดีครับ", finished: true },
      outputTranscription: { text: "Hello.", finished: true },
      turnComplete: true,
    },
  });

  assert.equal(events.length, 3);
  assert.deepEqual(events[0], { type: "input", text: "สวัสดีครับ", finished: true });
  assert.deepEqual(events[1], { type: "output", text: "Hello.", finished: true });
  assert.deepEqual(events[2], { type: "turnComplete" });

  session.close();
});

test("session-loop: rotates session cleanly on goAway and forwards sendAudioStreamEnd", async () => {
  const openedSessions = [];
  class FakeSession {
    constructor(opts) {
      this.opts = opts;
      this.audioEndCount = 0;
      this.closed = false;
      openedSessions.push(this);
    }
    async open() {
      this.opts.onStatus?.("connected");
      return this;
    }
    send() {}
    flush() {}
    sendAudioStreamEnd() {
      this.audioEndCount += 1;
    }
    close() {
      this.closed = true;
    }
  }

  const loop = new SessionLoop({
    apiKey: "test-key",
    setup: buildSetup(),
    SessionClass: FakeSession,
  });

  loop.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(openedSessions.length, 1);

  loop.sendAudioStreamEnd();
  assert.equal(openedSessions[0].audioEndCount, 1);

  // Trigger goAway -> opens replacement session and swaps on turnComplete
  openedSessions[0].opts.onEvent({ type: "goAway", timeLeft: 30000 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(openedSessions.length, 2);

  openedSessions[0].opts.onEvent({ type: "turnComplete" });
  assert.equal(openedSessions[0].closed, true);

  loop.close();
});
