// Where the index comes from, and the copy kept on the device.
//
// The app is read-only: it never writes to the vault. It downloads vault.db (built by
// .claude/skills/_shared/build_index.py, published by .github/workflows/vault-index.yml)
// and keeps it in IndexedDB, so it opens offline and only connects to refresh.

const DB_NAME = "captains-log";
const STORE = "kv";

// A browser cannot download a release asset (GitHub's asset storage sends no CORS headers,
// tested 24/10/2026), but the Contents API serves a file of up to 100 MB raw and
// cross-origin. So the GitHub route reads vault.db.gz from a repository: by default a
// separate private repo that holds only the latest index, so the phone's token can read
// nothing else. Hosting option a, chosen 28/10/2026: the app on GitHub Pages, the index here.
export const DEFAULTS = { owner: "magicthise", repo: "DataVita-index", branch: "main", path: "vault.db.gz" };

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const get = (k) => tx("readonly", (s) => s.get(k));
export const put = (k, v) => tx("readwrite", (s) => s.put(v, k));
export const del = (k) => tx("readwrite", (s) => s.delete(k));

// ---------------------------------------------------------------------------
// The GitHub token: fine-grained, read-only Contents on this repository only. It is kept
// encrypted with a key the browser will not export, and sent only to api.github.com.
// ---------------------------------------------------------------------------
async function tokenKey() {
  let k = await get("tokenKey");
  if (!k) {
    k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await put("tokenKey", k);
  }
  return k;
}

export async function saveToken(token) {
  if (!token) return del("token");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(), new TextEncoder().encode(token));
  return put("token", { iv, ct });
}

export async function loadToken() {
  const t = await get("token");
  if (!t) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: t.iv }, await tokenKey(), t.ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetching the database
// ---------------------------------------------------------------------------
const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unpack(buf) {
  const bytes = new Uint8Array(buf);
  return isGzip(bytes) ? gunzip(bytes) : bytes;
}

/** data/vault.db.gz or data/vault.db beside the app, for a host that serves the data with
 *  the app (and for local preview). Null when the host has none. */
export async function fromSite() {
  for (const name of ["data/vault.db.gz", "data/vault.db"]) {
    let r;
    try {
      r = await fetch(name, { cache: "no-store" });
    } catch {
      return null;
    }
    const type = r.headers.get("content-type") || "";
    if (r.ok && !type.includes("text/html")) {
      return { bytes: await unpack(await r.arrayBuffer()), source: "this site", detail: name };
    }
  }
  return null;
}

/** vault.db.gz from a GitHub repository, through the Contents API with the token. */
export async function fromGitHub({ owner, repo, branch, path }, token, onProgress) {
  const file = path.split("/").map(encodeURIComponent).join("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${file}?ref=${encodeURIComponent(branch)}`;
  let r;
  try {
    r = await fetch(url, { cache: "no-store", headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28" } });
  } catch (e) {
    throw new Error("Could not reach GitHub (" + e.message + "). Are you online?");
  }
  if (r.status === 401) throw new Error("GitHub refused the token (401). Check it has not expired.");
  if (r.status === 403) throw new Error("GitHub said no (403): the token may lack Contents read on this repository, or the rate limit was hit.");
  if (r.status === 404) throw new Error(`Nothing at ${owner}/${repo}/${path} on ${branch}, or the token cannot see that repository (404).`);
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
  const size = +r.headers.get("content-length") || 0;
  const buf = await readWithProgress(r, size, onProgress);
  return { bytes: await unpack(buf), source: "GitHub", detail: `${owner}/${repo}/${path} (${branch})` };
}

async function readWithProgress(response, total, onProgress) {
  if (!response.body || !onProgress) return response.arrayBuffer();
  const reader = response.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out.buffer;
}

/** A vault.db or vault.db.gz picked from Files, iCloud Drive or OneDrive. */
export async function fromFile(file) {
  return { bytes: await unpack(await file.arrayBuffer()), source: "a file", detail: file.name };
}

/** Keep the database on the device. */
export async function keep(got) {
  await put("db", got.bytes);
  await put("dbInfo", { source: got.source, detail: got.detail, fetched_at: new Date().toISOString(), size: got.bytes.length });
}

export const kept = () => get("db");
export const keptInfo = () => get("dbInfo");

export async function settings() {
  return { ...DEFAULTS, ...((await get("settings")) || {}) };
}
export const saveSettings = (s) => put("settings", s);
