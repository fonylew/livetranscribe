import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
import {
  extractThaiAndEnglish,
  formatSrtTimestamp,
  turnsToSrt,
} from "../public/lib/srt.js";
import { parseEnvContent } from "../lib/env.js";
import { SessionStore } from "../lib/storage.js";
import { createAppServer } from "../server.js";

function httpRequest(port, method, reqPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body
      ? typeof body === "string"
        ? body
        : JSON.stringify(body)
      : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          Connection: "close",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let resBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          resBody += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: resBody })
        );
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function httpGet(port, reqPath, headers = {}) {
  return httpRequest(port, "GET", reqPath, { headers });
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-test-"));
  const store = new SessionStore({ dataDir: tmpDir });
  const server = createAppServer({ sessionStore: store, envApiKey: "env-gemini-key-123" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    // 1. Localhost operator view returns 200 OK over HTTP and sets lt_token cookie
    const res = await httpGet(port, "/", { Host: `localhost:${port}` });
    assert.equal(res.status, 200);
    assert.match(res.body, /LiveTranscribe/);
    assert.match(res.body, /0 tokens/);
    assert.match(res.body, /manifest\.webmanifest/);
    assert.ok(res.headers["set-cookie"]?.[0]?.includes("lt_token="));

    // 1b. PWA manifest and Service Worker are served with proper MIME types
    const manifestRes = await httpGet(port, "/manifest.webmanifest", { Host: `localhost:${port}` });
    assert.equal(manifestRes.status, 200);
    assert.match(manifestRes.headers["content-type"] || "", /application\/manifest\+json/);
    const manifestJson = JSON.parse(manifestRes.body);
    assert.equal(manifestJson.short_name, "LiveTranscribe");
    assert.equal(manifestJson.display, "standalone");

    const swRes = await httpGet(port, "/sw.js", { Host: `localhost:${port}` });
    assert.equal(swRes.status, 200);
    assert.match(swRes.headers["content-type"] || "", /application\/javascript/);

    // 2. LAN IP plain HTTP operator view auto-redirects (302) to HTTPS so getUserMedia works
    const lanRes = await httpGet(port, "/", { Host: `192.168.10.61:${port}` });
    assert.equal(lanRes.status, 302);
    assert.equal(lanRes.headers.location, `https://192.168.10.61:${port}/`);

    // 3. Cloud Run plain HTTP behind x-forwarded-proto: https does NOT redirect
    const cloudRunRes = await httpGet(port, "/", {
      Host: "livetranscribe-xyz.a.run.app",
      "x-forwarded-proto": "https",
    });
    assert.equal(cloudRunRes.status, 200);

    // 4. LAN IP plain HTTP OBS Display View (?view=display) returns 200 OK without redirect
    const obsRes = await httpGet(port, "/?view=display", { Host: `192.168.10.61:${port}` });
    assert.equal(obsRes.status, 200);
    assert.match(obsRes.body, /obsStage/);

    // 5. /api/config returns .env GEMINI_API_KEY and clientToken
    const cfgRes = await httpGet(port, "/api/config?token=sessionA_token_123456");
    assert.equal(cfgRes.status, 200);
    const cfg = JSON.parse(cfgRes.body);
    assert.equal(cfg.clientToken, "sessionA_token_123456");
    assert.equal(cfg.hasEnvApiKey, true);
    assert.equal(cfg.envApiKey, "env-gemini-key-123");

    // 6. Multi-session /ws-relay room isolation via cookie & token:
    //    Session A's OBS client (using Cookie: lt_token=sessionA_token_123456) receives Session A's snapshot,
    //    while Session B's OBS client (using ?token=sessionB_token_999999) does NOT receive Session A's snapshot.
    let sessionBLeaked = false;
    const obsAReceived = await new Promise((resolve, reject) => {
      const keyB = crypto.randomBytes(16).toString("base64");
      const obsBReq = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/ws-relay?token=sessionB_token_999999",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": keyB,
          "Sec-WebSocket-Version": "13",
        },
      });

      obsBReq.on("upgrade", (_resB, obsBSocket) => {
        obsBSocket.on("data", () => {
          sessionBLeaked = true;
        });

        const keyA = crypto.randomBytes(16).toString("base64");
        const obsAReq = http.request({
          hostname: "127.0.0.1",
          port,
          path: "/ws-relay",
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            Cookie: "lt_token=sessionA_token_123456",
            "Sec-WebSocket-Key": keyA,
            "Sec-WebSocket-Version": "13",
          },
        });

        obsAReq.on("upgrade", (_resA, obsASocket) => {
          obsASocket.on("data", (chunk) => {
            const len = chunk[1] & 0x7f;
            const text = chunk.subarray(2, 2 + len).toString("utf8");
            obsASocket.destroy();
            obsBSocket.destroy();
            resolve(JSON.parse(text));
          });

          // Connect Operator A WebSocket and send a live snapshot
          const keyOpA = crypto.randomBytes(16).toString("base64");
          const opAReq = http.request({
            hostname: "127.0.0.1",
            port,
            path: "/ws-relay?token=sessionA_token_123456",
            headers: {
              Connection: "Upgrade",
              Upgrade: "websocket",
              "Sec-WebSocket-Key": keyOpA,
              "Sec-WebSocket-Version": "13",
            },
          });
          opAReq.on("upgrade", (_r2, opASocket) => {
            const snapshot = JSON.stringify({
              type: "snapshot",
              running: true,
              currentTurn: { input: "สวัสดี", output: "Hello" },
            });
            opASocket.write(encodeMaskedClientTextFrame(snapshot));
            setTimeout(() => opASocket.destroy(), 20);
          });
          opAReq.on("error", reject);
          opAReq.end();
        });

        obsAReq.on("error", reject);
        obsAReq.end();
      });

      obsBReq.on("error", reject);
      obsBReq.end();
    });

    assert.equal(obsAReceived.type, "snapshot");
    assert.equal(obsAReceived.currentTurn.input, "สวัสดี");
    assert.equal(obsAReceived.currentTurn.output, "Hello");
    assert.equal(sessionBLeaked, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("srt & storage: generates .SRT files, isolates past sessions per clientToken, and syncs to GCS & Firestore", async () => {
  assert.equal(formatSrtTimestamp(0), "00:00:00,000");
  assert.equal(formatSrtTimestamp(65432), "00:01:05,432");

  const sampleTurns = [
    {
      id: "t1",
      timestamp: "10:00:01",
      epochMs: 1000,
      endEpochMs: 4000,
      sourceLang: "th",
      targetLang: "en",
      input: "สวัสดีครับทุกท่าน",
      output: "Hello everyone.",
    },
    {
      id: "t2",
      timestamp: "10:00:05",
      epochMs: 5000,
      endEpochMs: 8500,
      sourceLang: "en",
      targetLang: "th",
      input: "Welcome to Cloud Run.",
      output: "ยินดีต้อนรับสู่ Cloud Run",
    },
  ];

  // Verify extractThaiAndEnglish normalizes Thai and English regardless of speaking direction
  assert.deepEqual(extractThaiAndEnglish(sampleTurns[0]), {
    thai: "สวัสดีครับทุกท่าน",
    english: "Hello everyone.",
  });
  assert.deepEqual(extractThaiAndEnglish(sampleTurns[1]), {
    thai: "ยินดีต้อนรับสู่ Cloud Run",
    english: "Welcome to Cloud Run.",
  });

  const combinedSrt = turnsToSrt(sampleTurns, "combined", 1000);
  assert.match(combinedSrt, /1\n00:00:00,000 --> 00:00:03,000\nสวัสดีครับทุกท่าน\nHello everyone\./);
  assert.match(combinedSrt, /2\n00:00:04,000 --> 00:00:07,500\nยินดีต้อนรับสู่ Cloud Run\nWelcome to Cloud Run\./);

  const thOnlySrt = turnsToSrt(sampleTurns, "th", 1000);
  assert.match(thOnlySrt, /สวัสดีครับทุกท่าน/);
  assert.doesNotMatch(thOnlySrt, /Hello everyone\./);

  // Test SessionStore with mocked GCS and Firestore HTTP endpoints
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-store-"));
  const cloudCalls = [];
  const fakeFetch = async (url, opts = {}) => {
    cloudCalls.push({ url: String(url), headers: opts.headers || {}, method: opts.method });
    return {
      ok: true,
      status: 200,
      async json() {
        return { access_token: "fake-gcp-token", expires_in: 3600 };
      },
      async text() {
        return "OK";
      },
    };
  };

  const store = new SessionStore({
    dataDir: tmpDir,
    gcsBucket: "my-event-srt-bucket",
    gcsPrefix: "events/2026",
    projectId: "my-gcp-project",
    firestoreCollection: "livetranscribe_sessions",
    fetchImpl: fakeFetch,
  });

  const server = createAppServer({ sessionStore: store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    // Save session for Token A via POST /api/sessions
    const saveRes = await httpRequest(port, "POST", "/api/sessions?token=token_alpha_12345", {
      body: {
        sessionId: "sess-keynote-1",
        title: "Keynote Session",
        startedAtEpochMs: 1000,
        turns: sampleTurns,
      },
    });
    assert.equal(saveRes.status, 200);
    const savedBody = JSON.parse(saveRes.body);
    const savedMeta = savedBody.session || savedBody;
    assert.equal(savedMeta.sessionId, "sess-keynote-1");
    assert.equal(savedMeta.turnCount, 2);

    // Check that local .srt files were written
    const localSrtPath = path.join(tmpDir, "token_alpha_12345", "sess-keynote-1.srt");
    assert.equal(fs.existsSync(localSrtPath), true);
    assert.match(fs.readFileSync(localSrtPath, "utf8"), /Hello everyone\./);

    // Check that GCS upload used the required User-Agent header and Firestore PATCH was called
    const gcsCall = cloudCalls.find((c) => c.url.includes("storage.googleapis.com/upload/storage/v1/b/my-event-srt-bucket"));
    assert.ok(gcsCall);
    assert.equal(gcsCall.headers["User-Agent"], "gcs-skills/1.0 (skill:google-cloud-storage-basics)");

    const firestoreCall = cloudCalls.find((c) => c.url.includes("firestore.googleapis.com/v1/projects/my-gcp-project"));
    assert.ok(firestoreCall);
    assert.equal(firestoreCall.method, "PATCH");

    // Token A can list and download its .SRT file
    const listARes = await httpGet(port, "/api/sessions?token=token_alpha_12345");
    const listA = JSON.parse(listARes.body);
    assert.equal(listA.sessions.length, 1);
    assert.equal(listA.sessions[0].sessionId, "sess-keynote-1");

    const srtDownloadRes = await httpGet(
      port,
      "/api/sessions/sess-keynote-1/srt?lang=combined&token=token_alpha_12345"
    );
    assert.equal(srtDownloadRes.status, 200);
    assert.match(srtDownloadRes.body, /00:00:00,000 --> 00:00:03,000/);

    // Token B cannot see Token A's sessions
    const listBRes = await httpGet(port, "/api/sessions?token=token_beta_99999");
    const listB = JSON.parse(listBRes.body);
    assert.equal(listB.sessions.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("env: parses .env files with comments, quotes, and export prefix, and disables Firestore by default in local mode", () => {
  const parsed = parseEnvContent(`
    # Cloud Run / Local .env config
    GEMINI_API_KEY="AIzaSyTestKey123"
    export GCS_BUCKET='my-srt-bucket'
    FIRESTORE_COLLECTION=livetranscribe_sessions
  `);
  assert.equal(parsed.GEMINI_API_KEY, "AIzaSyTestKey123");
  assert.equal(parsed.GCS_BUCKET, "my-srt-bucket");
  assert.equal(parsed.FIRESTORE_COLLECTION, "livetranscribe_sessions");

  // Verify local mode does NOT enable Firestore unless ENABLE_FIRESTORE=true or K_SERVICE (Cloud Run) is set
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-local-nofs-"));
  const prevEnable = process.env.ENABLE_FIRESTORE;
  const prevKService = process.env.K_SERVICE;
  const prevProject = process.env.GCP_PROJECT_ID;
  try {
    delete process.env.ENABLE_FIRESTORE;
    delete process.env.K_SERVICE;
    process.env.GCP_PROJECT_ID = "some-local-gcloud-project";

    const localStore = new SessionStore({ dataDir: tmpDir });
    assert.equal(localStore.firestoreEnabled, false);

    // On Cloud Run (K_SERVICE set), Firestore is enabled automatically
    process.env.K_SERVICE = "livetranscribe";
    assert.equal(localStore.firestoreEnabled, true);
  } finally {
    if (prevEnable === undefined) delete process.env.ENABLE_FIRESTORE;
    else process.env.ENABLE_FIRESTORE = prevEnable;
    if (prevKService === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = prevKService;
    if (prevProject === undefined) delete process.env.GCP_PROJECT_ID;
    else process.env.GCP_PROJECT_ID = prevProject;
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
  assert.match(instruction, /RULE 1 \(Thai -> English\)/);
  assert.match(instruction, /RULE 2 \(English -> Thai\)/);
  assert.match(instruction, /RULE 3 \(Strict Translation Only/);
  assert.match(instruction, /Cloud Native Summit Bangkok/);
  assert.match(instruction, /- กรุงเทพมหานคร → Bangkok/);
});

test("instructions: detects Thai vs English accurately", () => {
  assert.equal(detectLanguage("สวัสดีครับ ยินดีต้อนรับสู่การประชุม"), "th");
  assert.equal(detectLanguage("สวัสดีครับ วันนี้เราจะพูดเรื่อง Kubernetes Cluster"), "th");
  assert.equal(detectLanguage("Welcome everyone to our keynote session today."), "en");
  assert.equal(detectLanguage(""), "auto");
});

test("instructions: cleans extra spaces between Thai characters and strips Chinese/non-Thai/non-English characters", () => {
  const raw = "สวัสดี  ครับ ทุกท่าน";
  assert.equal(cleanTranscriptSpacing(raw), "สวัสดี ครับ ทุกท่าน");
  assert.equal(cleanTranscriptSpacing("哼。"), "");
  assert.equal(cleanTranscriptSpacing("<no speech detected>"), "");
  assert.equal(cleanTranscriptSpacing("𖢄𖢄 𖢄𖢄 𖢄𖢄𖢄𖢄."), "");
  assert.equal(cleanTranscriptSpacing("哼 คือ Agent CLI ค่ะ").trim(), "คือ Agent CLI ค่ะ");
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

test("live-session: buildSetup creates valid Gemini 3.8 Live setup with low-latency VAD and sends audioStreamEnd when mic is off", async () => {
  const setupFrame = buildSetup({ model: "gemini-3.8-live", speakerLang: "th" });
  assert.equal(setupFrame.setup.model, "models/gemini-3.8-live");
  assert.deepEqual(setupFrame.setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.deepEqual(setupFrame.setup.inputAudioTranscription, {});
  assert.deepEqual(setupFrame.setup.outputAudioTranscription, {});
  assert.deepEqual(setupFrame.setup.realtimeInputConfig.automaticActivityDetection, {
    disabled: false,
    startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
    endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
    prefixPaddingMs: 150,
    silenceDurationMs: 350,
  });
  assert.match(
    setupFrame.setup.systemInstruction.parts[0].text,
    /RULE 2 \(English -> Thai\)/
  );

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
