/**
 * Multi-Session Transcript & SRT Storage Engine
 *
 * Persists every session's transcription and `.srt` subtitle files to:
 * 1. Local Disk (`data/sessions/<clientToken>/<sessionId>.{json,srt,th.srt,en.srt}`)
 * 2. Google Cloud Storage (GCS) in `.srt` and `.json` formats when `GCS_BUCKET` is set
 * 3. Google Cloud Firestore when `GCP_PROJECT_ID` / `GOOGLE_CLOUD_PROJECT` or `FIRESTORE_COLLECTION` is set
 *
 * Designed for zero external npm dependencies on both local machines and Google Cloud Run.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { turnsToSrt } from "../public/lib/srt.js";

const GCS_USER_AGENT = "gcs-skills/1.0 (skill:google-cloud-storage-basics)";
const METADATA_BASE = "http://metadata.google.internal/computeMetadata/v1";

let cachedToken = null;
let cachedTokenExpiresAt = 0;
let cachedProjectId = null;

/**
 * Sanitize an identifier (`clientToken` or `sessionId`) so it is safe for paths and URLs.
 */
export function sanitizeId(raw = "", fallback = "default") {
  const cleaned = String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

/**
 * Resolve Google Cloud OAuth2 access token using:
 * 1. Explicit `GCP_ACCESS_TOKEN` env var (if set)
 * 2. Application Default Credentials file (`GOOGLE_APPLICATION_CREDENTIALS` or `~/.config/gcloud/application_default_credentials.json`)
 * 3. Cloud Run / GCE Metadata Server (`http://metadata.google.internal/...`)
 */
export async function getGcpAccessToken({ fetchImpl = fetch } = {}) {
  if (process.env.GCP_ACCESS_TOKEN) {
    return process.env.GCP_ACCESS_TOKEN;
  }

  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30000) {
    return cachedToken;
  }

  // Try ADC JSON file first (Service Account or authorized_user)
  const adcPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");

  if (fs.existsSync(adcPath)) {
    try {
      const cred = JSON.parse(fs.readFileSync(adcPath, "utf8"));
      if (cred.type === "authorized_user" && cred.refresh_token) {
        const res = await fetchImpl("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: cred.client_id,
            client_secret: cred.client_secret,
            refresh_token: cred.refresh_token,
            grant_type: "refresh_token",
          }),
          signal: AbortSignal.timeout(3500),
        });
        if (res.ok) {
          const data = await res.json();
          cachedToken = data.access_token;
          cachedTokenExpiresAt = now + (Number(data.expires_in) || 3600) * 1000;
          return cachedToken;
        }
      } else if (cred.type === "service_account" && cred.private_key && cred.client_email) {
        const iat = Math.floor(now / 1000);
        const exp = iat + 3600;
        const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
          "base64url"
        );
        const claim = Buffer.from(
          JSON.stringify({
            iss: cred.client_email,
            scope: "https://www.googleapis.com/auth/cloud-platform",
            aud: cred.token_uri || "https://oauth2.googleapis.com/token",
            exp,
            iat,
          })
        ).toString("base64url");
        const signer = crypto.createSign("RSA-SHA256");
        signer.update(`${header}.${claim}`);
        const signature = signer.sign(cred.private_key, "base64url");
        const assertion = `${header}.${claim}.${signature}`;

        const res = await fetchImpl(cred.token_uri || "https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }),
          signal: AbortSignal.timeout(3500),
        });
        if (res.ok) {
          const data = await res.json();
          cachedToken = data.access_token;
          cachedTokenExpiresAt = now + (Number(data.expires_in) || 3600) * 1000;
          return cachedToken;
        }
      }
    } catch {
      // Fall through to Cloud Run metadata server
    }
  }

  // Try Cloud Run / GCE Metadata Server
  try {
    const res = await fetchImpl(`${METADATA_BASE}/instance/service-accounts/default/token`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const data = await res.json();
      cachedToken = data.access_token;
      cachedTokenExpiresAt = now + (Number(data.expires_in) || 3600) * 1000;
      return cachedToken;
    }
  } catch {
    // Not running on GCP or metadata server unreachable
  }

  return null;
}

/**
 * Resolve GCP Project ID from env vars, ADC file, or Cloud Run Metadata Server.
 */
export async function getGcpProjectId({ fetchImpl = fetch } = {}) {
  const fromEnv =
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT;
  if (fromEnv) return fromEnv.trim();
  if (cachedProjectId) return cachedProjectId;

  const adcPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
  if (fs.existsSync(adcPath)) {
    try {
      const cred = JSON.parse(fs.readFileSync(adcPath, "utf8"));
      if (cred.project_id || cred.quota_project_id) {
        cachedProjectId = cred.project_id || cred.quota_project_id;
        return cachedProjectId;
      }
    } catch {
      // Ignore
    }
  }

  try {
    const res = await fetchImpl(`${METADATA_BASE}/project/project-id`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      cachedProjectId = (await res.text()).trim();
      return cachedProjectId;
    }
  } catch {
    // Ignore
  }

  return null;
}

export class SessionStore {
  constructor({
    dataDir = path.resolve(process.cwd(), "data", "sessions"),
    gcsBucket,
    gcsPrefix,
    projectId,
    firestoreCollection,
    firestoreDatabase,
    fetchImpl = fetch,
  } = {}) {
    this.dataDir = dataDir;
    this._gcsBucket = gcsBucket;
    this._gcsPrefix = gcsPrefix;
    this._projectId = projectId;
    this._firestoreCollection = firestoreCollection;
    this._firestoreDatabase = firestoreDatabase;
    this.fetchImpl = fetchImpl;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  get gcsBucket() {
    return String(this._gcsBucket ?? process.env.GCS_BUCKET ?? "")
      .trim()
      .replace(/^gs:\/\//, "")
      .replace(/\/+$/, "");
  }

  get gcsPrefix() {
    const raw = String(this._gcsPrefix ?? process.env.GCS_PREFIX ?? "livetranscribe/sessions").trim();
    return raw.replace(/^\/+|\/+$/g, "");
  }

  get firestoreCollection() {
    return String(
      this._firestoreCollection ?? process.env.FIRESTORE_COLLECTION ?? "livetranscribe_sessions"
    ).trim();
  }

  get firestoreDatabase() {
    return String(this._firestoreDatabase ?? process.env.FIRESTORE_DATABASE ?? "(default)").trim();
  }

  get firestoreEnabled() {
    if (process.env.ENABLE_FIRESTORE === "false") return false;
    if (process.env.ENABLE_FIRESTORE === "true") return true;
    if (this._projectId || this._firestoreCollection) return true;
    // Automatically enable on Cloud Run (where K_SERVICE is defined) when project/collection is set
    if (process.env.K_SERVICE) {
      return Boolean(
        process.env.FIRESTORE_COLLECTION ||
          process.env.GCP_PROJECT_ID ||
          process.env.GOOGLE_CLOUD_PROJECT
      );
    }
    return false;
  }

  _clientDir(clientToken) {
    const safeToken = sanitizeId(clientToken, "default");
    const dir = path.join(this.dataDir, safeToken);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Save or update a session (turns + generated `.srt` files) locally and asynchronously
   * sync to Google Cloud Storage (`.srt`) and Firestore if configured.
   */
  async saveSession(clientToken, sessionData, { syncCloud = true } = {}) {
    const safeToken = sanitizeId(clientToken, "default");
    const sessionId = sanitizeId(sessionData.sessionId, `sess_${Date.now()}`);
    const turns = Array.isArray(sessionData.turns) ? sessionData.turns : [];
    const createdAt = sessionData.createdAt || new Date().toISOString();
    const updatedAt = new Date().toISOString();
    const startEpochMs =
      sessionData.startEpochMs ||
      sessionData.startedAtEpochMs ||
      Date.parse(createdAt) ||
      Date.now();

    const srtCombined = turnsToSrt(turns, "combined", startEpochMs);
    const srtThai = turnsToSrt(turns, "th", startEpochMs);
    const srtEnglish = turnsToSrt(turns, "en", startEpochMs);

    const record = {
      sessionId,
      clientToken: safeToken,
      title: sessionData.title || `Session ${createdAt.slice(0, 19).replace("T", " ")}`,
      createdAt,
      updatedAt,
      startEpochMs,
      turnCount: turns.length,
      turns,
      srtCombined,
      srtThai,
      srtEnglish,
      storageStatus: {
        local: true,
        gcs: Boolean(sessionData.storageStatus?.gcs),
        firestore: Boolean(sessionData.storageStatus?.firestore),
        gcsUri: sessionData.storageStatus?.gcsUri || null,
      },
    };

    // 1. Write local JSON + SRT files
    const dir = this._clientDir(safeToken);
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(record, null, 2), "utf8");
    fs.writeFileSync(path.join(dir, `${sessionId}.srt`), srtCombined, "utf8");
    fs.writeFileSync(path.join(dir, `${sessionId}.th.srt`), srtThai, "utf8");
    fs.writeFileSync(path.join(dir, `${sessionId}.en.srt`), srtEnglish, "utf8");

    // 2. Cloud sync (GCS + Firestore) if configured
    if (syncCloud && (this.gcsBucket || this.firestoreEnabled)) {
      const cloudStatus = await this._syncToCloud(record);
      record.storageStatus = {
        ...record.storageStatus,
        ...cloudStatus,
      };
      fs.writeFileSync(
        path.join(dir, `${sessionId}.json`),
        JSON.stringify(record, null, 2),
        "utf8"
      );
    }

    return record;
  }

  async _syncToCloud(record) {
    const status = {
      gcs: false,
      firestore: false,
      gcsUri: null,
    };

    const token = await getGcpAccessToken({ fetchImpl: this.fetchImpl });
    if (!token) return status;

    const tasks = [];

    if (this.gcsBucket) {
      tasks.push(
        this._uploadToGcs(token, record)
          .then((uri) => {
            status.gcs = Boolean(uri);
            status.gcsUri = uri;
          })
          .catch(() => {})
      );
    }

    if (this.firestoreEnabled) {
      tasks.push(
        this._saveToFirestore(token, record)
          .then((ok) => {
            status.firestore = ok;
          })
          .catch(() => {})
      );
    }

    await Promise.all(tasks);
    return status;
  }

  /**
   * Upload `.srt` (combined, Thai, English) and `.json` files to Google Cloud Storage.
   */
  async _uploadToGcs(accessToken, record) {
    const bucket = this.gcsBucket;
    if (!bucket) return null;

    const baseObj = `${this.gcsPrefix}/${record.clientToken}/${record.sessionId}`;
    const uploads = [
      { name: `${baseObj}.srt`, body: record.srtCombined, contentType: "text/plain; charset=utf-8" },
      { name: `${baseObj}.th.srt`, body: record.srtThai, contentType: "text/plain; charset=utf-8" },
      { name: `${baseObj}.en.srt`, body: record.srtEnglish, contentType: "text/plain; charset=utf-8" },
      {
        name: `${baseObj}.json`,
        body: JSON.stringify(record),
        contentType: "application/json; charset=utf-8",
      },
    ];

    for (const item of uploads) {
      const url =
        `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
        `?uploadType=media&name=${encodeURIComponent(item.name)}`;
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": GCS_USER_AGENT,
          "Content-Type": item.contentType,
        },
        body: item.body,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        throw new Error(`GCS upload failed with status ${res.status}`);
      }
    }

    return `gs://${bucket}/${baseObj}.srt`;
  }

  /**
   * Save session document (including SRT content and turns) to Google Cloud Firestore.
   */
  async _saveToFirestore(accessToken, record) {
    const projectId =
      this._projectId || (await getGcpProjectId({ fetchImpl: this.fetchImpl }));
    if (!projectId) return false;

    const docPath =
      `projects/${encodeURIComponent(projectId)}` +
      `/databases/${encodeURIComponent(this.firestoreDatabase)}` +
      `/documents/${encodeURIComponent(this.firestoreCollection)}` +
      `/${encodeURIComponent(record.sessionId)}`;

    const url = `https://firestore.googleapis.com/v1/${docPath}`;

    const firestoreDoc = {
      fields: {
        sessionId: { stringValue: record.sessionId },
        clientToken: { stringValue: record.clientToken },
        title: { stringValue: record.title || "" },
        createdAt: { stringValue: record.createdAt },
        updatedAt: { stringValue: record.updatedAt },
        turnCount: { integerValue: String(record.turnCount || 0) },
        srtCombined: { stringValue: record.srtCombined || "" },
        srtThai: { stringValue: record.srtThai || "" },
        srtEnglish: { stringValue: record.srtEnglish || "" },
        turnsJson: { stringValue: JSON.stringify(record.turns || []) },
      },
    };

    const res = await this.fetchImpl(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(firestoreDoc),
      signal: AbortSignal.timeout(5000),
    });

    return res.ok;
  }

  /**
   * List all saved sessions for a given `clientToken` (newest first).
   */
  async listSessions(clientToken) {
    const dir = this._clientDir(clientToken);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const sessions = [];

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        sessions.push({
          sessionId: data.sessionId,
          clientToken: data.clientToken,
          title: data.title,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          turnCount: data.turnCount ?? (data.turns?.length || 0),
          storageStatus: data.storageStatus || { local: true },
        });
      } catch {
        // Ignore corrupted file
      }
    }

    sessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return sessions;
  }

  /**
   * Retrieve a single session (including turns and `.srt` strings) by `clientToken` and `sessionId`.
   */
  async getSession(clientToken, sessionId) {
    const dir = this._clientDir(clientToken);
    const safeSessionId = sanitizeId(sessionId, "");
    if (!safeSessionId) return null;
    const jsonPath = path.join(dir, `${safeSessionId}.json`);
    if (!fs.existsSync(jsonPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch {
      return null;
    }
  }
}
