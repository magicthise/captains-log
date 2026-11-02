// The vault index in the browser: a port of .claude/skills/_shared/query.py, so a card here
// shows what `query.py <name>` prints. Keep the two in step.

// The official SQLite WebAssembly build: it carries FTS5, which the index's search table
// needs (sql.js 1.10 has FTS3/4 only — checked 24/10/2026).
export const SQLITE = "https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.46.1-build1/sqlite-wasm/jswasm/";
let sqlite3 = null;

export async function sqlReady() {
  if (!sqlite3) {
    const mod = await import(SQLITE + "sqlite3.mjs");
    sqlite3 = await mod.default({ print: () => {}, printErr: () => {} });
  }
  return sqlite3;
}

// Which kind wins when a name matches several records: the organisation first, then what
// hangs off it. "Jisc" is the account before it is the Marketing programme.
export const KIND_ORDER = ["account", "event", "project", "radar", "opportunity", "quote", "task", "document"];
export const KIND_LABEL = { account: "Client", opportunity: "Opportunity", quote: "Quote", task: "Task",
  project: "Project", event: "Event", radar: "Radar", document: "Note" };
export const CLOSED = new Set(["Closed Won", "Closed Lost", "Closed/Dead"]);
const SFID = /^(?:00[1-9A-Za-z]|a[0-9][0-9A-Za-z])[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/;

export const money = (n) => "£" + Math.round(n || 0).toLocaleString("en-GB");

export function ddmm(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || "");
}

export class Ix {
  constructor(bytes) {
    this.db = new sqlite3.oo1.DB();
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    this.db.checkRc(sqlite3.capi.sqlite3_deserialize(this.db.pointer, "main", p, bytes.byteLength, bytes.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE));
    this.meta = {};
    for (const r of this.rows("SELECT key, value FROM meta")) this.meta[r.key] = r.value;
    if (this.meta.schema_version !== "1") {
      throw new Error(`This index is schema ${this.meta.schema_version || "?"}; the app reads schema 1.`);
    }
    // Every record and link is small; holding them in memory keeps cards instant.
    this.ent = new Map();
    for (const r of this.rows("SELECT uid, kind, title, subtitle, sfid, status, date, path, series, data FROM entity")) {
      this.ent.set(r.uid, r);
    }
    this.outMap = new Map();
    this.inMap = new Map();
    for (const r of this.rows("SELECT src, dst, rel, via FROM link")) {
      push(this.outMap, r.src, [r.dst, r.rel, r.via]);
      push(this.inMap, r.dst, [r.src, r.rel, r.via]);
    }
    this.fts = true;
    try {
      this.rows("SELECT uid FROM search WHERE search MATCH 'a' LIMIT 1");
    } catch {
      this.fts = false; // no FTS5 in this SQLite build: read the shadow table instead
    }
  }

  close() { this.db.close(); }

  rows(sql, params) {
    return this.db.exec({ sql, bind: params && params.length ? params : undefined, rowMode: "object", returnValue: "resultRows" });
  }

  get(uid) {
    const e = this.ent.get(uid);
    if (!e) return null;
    if (!e.parsed) {
      try { e.data = JSON.parse(e.data || "{}"); } catch { e.data = {}; }
      e.parsed = true;
    }
    return e;
  }

  kind(uid) { const e = this.ent.get(uid); return e ? e.kind : null; }
  out(uid, rel) { return (this.outMap.get(uid) || []).filter((x) => !rel || x[1] === rel); }
  inn(uid, rel) { return (this.inMap.get(uid) || []).filter((x) => !rel || x[1] === rel); }

  /** -> ordered candidate uids. Exact keys first, then names, then full text. */
  find(term) {
    const t = term.trim();
    if (!t) return [];
    if (this.ent.has(t)) return [t];
    if (SFID.test(t)) {
      const hits = [...this.ent.values()].filter((e) => e.sfid === t.slice(0, 15));
      return hits.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)).map((e) => e.uid);
    }
    if (/^Q-\d{5}$/i.test(t)) {
      return [...this.ent.values()].filter((e) => e.kind === "quote" && e.title === t.toUpperCase()).map((e) => e.uid);
    }
    const low = t.toLowerCase();
    const rank = (e) => {
      const title = e.title.toLowerCase();
      return [title === low ? 0 : title.startsWith(low) ? 1 : 2, KIND_ORDER.indexOf(e.kind), e.title.length, e.title];
    };
    const named = [...this.ent.values()].filter((e) => e.title.toLowerCase().includes(low));
    named.sort((a, b) => cmp(rank(a), rank(b)));
    // Notes only win a name match on an exact title; otherwise records come first.
    const hits = named.filter((e) => e.kind !== "document" || e.title.toLowerCase() === low).map((e) => e.uid);
    for (const e of named) if (!hits.includes(e.uid)) hits.push(e.uid);
    return hits.length ? hits : this.search(t, 20).map((x) => x.uid);
  }

  /** Full text over every note and record -> [{uid, snippet}]. The snippet marks hits
   *  with \u0002 … \u0003. Unlike query.py, every word matches as a prefix ("pharos"
   *  finds PharosAI), because the app searches as you type. */
  search(text, limit = 25) {
    const words = text.split(/\s+/).filter(Boolean).map((w) => w.replace(/"/g, ""));
    if (!words.length) return [];
    if (this.fts) {
      const q = words.map((w) => `"${w}"*`).join(" ");
      try {
        return this.rows(
          "SELECT uid, snippet(search, 2, char(2), char(3), ' … ', 14) AS snippet FROM search " +
          "WHERE search MATCH ? ORDER BY bm25(search, 0.0, 8.0, 1.0) LIMIT ?", [q, limit]);
      } catch {
        return [];
      }
    }
    const where = words.map(() => "(c1 LIKE ? OR c2 LIKE ?)").join(" AND ");
    const params = words.flatMap((w) => [`%${w}%`, `%${w}%`]);
    return this.rows(`SELECT c0 AS uid, c2 AS body FROM search_content WHERE ${where} LIMIT ?`, [...params, limit])
      .map((r) => ({ uid: r.uid, snippet: likeSnippet(r.body || "", words[0]) }));
  }

  /** A note's Markdown. */
  body(uid) {
    const r = this.fts
      ? this.rows("SELECT body FROM search WHERE uid = ?", [uid])
      : this.rows("SELECT c2 AS body FROM search_content WHERE c0 = ?", [uid]);
    return r.length ? r[0].body || "" : "";
  }

  /** Records whose path ends with this file name, for resolving links inside a note. */
  byPath(ref, here) {
    const clean = decodeURIComponent(ref).replace(/^\.\//, "").replace(/#.*$/, "");
    const name = clean.endsWith(".md") ? clean : clean + ".md";
    if (this.ent.has("doc:" + name)) return "doc:" + name;
    if (here) {
      const dir = here.split("/").slice(0, -1);
      const parts = [...dir];
      for (const seg of name.split("/")) {
        if (seg === "..") parts.pop(); else if (seg && seg !== ".") parts.push(seg);
      }
      if (this.ent.has("doc:" + parts.join("/"))) return "doc:" + parts.join("/");
    }
    const tail = "/" + name.replace(/^\/+/, "");
    const hits = [...this.ent.keys()].filter((u) => u.startsWith("doc:") && ("/" + u.slice(4)).endsWith(tail));
    return hits.length === 1 ? hits[0] : null;
  }

  bySfid(id) {
    for (const e of this.ent.values()) if (e.sfid && e.sfid === id.slice(0, 15) && e.kind !== "document") return e.uid;
    return null;
  }

  quoteByNumber(n) {
    for (const e of this.ent.values()) if (e.kind === "quote" && e.title === n) return e.uid;
    return null;
  }

  all(kind) { return [...this.ent.values()].filter((e) => e.kind === kind).map((e) => e.uid); }
}

function push(m, k, v) { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); }

function cmp(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function likeSnippet(body, word) {
  const i = body.toLowerCase().indexOf(word.toLowerCase());
  if (i < 0) return body.slice(0, 160);
  const s = Math.max(0, i - 70);
  return (s ? "… " : "") + body.slice(s, i) + "\u0002" + body.slice(i, i + word.length) + "\u0003" +
    body.slice(i + word.length, i + word.length + 90) + " …";
}

// ---------------------------------------------------------------------------
// Cards: the record plus joined things, as sections of items (query.py card())
// ---------------------------------------------------------------------------
export function item(ix, uid, note = "") {
  const e = ix.get(uid);
  return { uid, kind: e.kind, title: e.title, subtitle: e.subtitle, date: e.date, status: e.status,
    series: e.series, note, archive: Boolean(e.data.archive) };
}

const neighbours = (ix, uid) => new Set([...ix.out(uid).map((x) => x[0]), ...ix.inn(uid).map((x) => x[0])]);
const docsOf = (ix, uid) => new Set([...neighbours(ix, uid)].filter((u) => ix.kind(u) === "document"));
const byKind = (ix, uids, kind) => [...uids].filter((u) => ix.kind(u) === kind).sort();
const union = (...sets) => { const s = new Set(); for (const x of sets) for (const v of x) s.add(v); return s; };

function taskItems(ix, uids) {
  return [...uids].map((u) => item(ix, u))
    .sort((a, b) => cmp([a.status === "Completed" ? 1 : 0, a.date || "9999"], [b.status === "Completed" ? 1 : 0, b.date || "9999"]));
}

/** Notes grouped by series (Start of Day, Meeting Brief …), newest first; undated working
 *  notes first of all. Archived and superseded notes (Richard, 24/10) go in one closed
 *  "Archive" group at the very bottom, whatever their series. */
export function docSections(ix, uids) {
  const groups = new Map();
  const archive = [];
  for (const u of uids) {
    const it = item(ix, u);
    if (it.archive) archive.push(it);
    else push(groups, it.series || "Notes", it);
  }
  const newestFirst = (a, b) => cmp([b.date || "", b.title], [a.date || "", a.title]);
  const out = [];
  for (const [title, items] of groups) {
    items.sort(newestFirst);
    out.push({ title, items });
  }
  const key = (s) => [s.title !== "Notes" ? 1 : 0, s.title === "Folder synopsis" ? 1 : 0,
    -parseInt((s.items[0].date || "0000-00-00").replace(/-/g, ""), 10)];
  out.sort((a, b) => cmp(key(a), key(b)));
  if (archive.length) out.push({ title: "Archive", items: archive.sort(newestFirst), folded: true });
  return out;
}

const plain = (o) => ({ uid: null, kind: o.kind, title: o.title, subtitle: o.subtitle || "", date: o.date || null,
  status: o.status || null, series: null, note: o.note || "" });

export function card(ix, uid) {
  const e = ix.get(uid);
  const k = e.kind;
  const d = e.data;
  const secs = [];
  const head = [];
  const sec = (title, items) => { if (items.length) secs.push({ title, items }); };
  const nb = neighbours(ix, uid);
  const projectsAndEvents = () => [...nb].sort().filter((p) => ["project", "event"].includes(ix.kind(p))).map((p) => item(ix, p));

  if (k === "account") {
    const opps = byKind(ix, nb, "opportunity");
    const radar = byKind(ix, nb, "radar");
    let hop = new Set();
    for (const o of [...opps, ...radar]) hop = union(hop, neighbours(ix, o));
    const quotes = byKind(ix, hop, "quote");
    const tasks = union(byKind(ix, nb, "task"), byKind(ix, hop, "task"));
    let docs = docsOf(ix, uid);
    for (const o of [...opps, ...radar, ...quotes]) docs = union(docs, docsOf(ix, o));
    const live = opps.filter((o) => !CLOSED.has(ix.get(o).status));
    sec("Opportunities", opps.map((o) => item(ix, o)).sort((a, b) => cmp(
      [CLOSED.has(a.status) ? 1 : 0, -(ix.get(a.uid).data.mrr || 0)], [CLOSED.has(b.status) ? 1 : 0, -(ix.get(b.uid).data.mrr || 0)])));
    sec("Quotes", quotes.map((q) => item(ix, q)).sort((a, b) => cmp([b.date || ""], [a.date || ""])));
    sec("Tasks", taskItems(ix, tasks));
    sec("Radar entry", radar.map((r) => item(ix, r)));
    sec("Projects and events", projectsAndEvents());
    head.push(`${live.length} open opportunit${live.length === 1 ? "y" : "ies"} · ${money(d.book_mrr)}/month in book`);
    if (d.source === "task") head.push("Known from its Salesforce tasks only: no open opportunity and no radar entry.");
    secs.push(...docSections(ix, docs));
  } else if (k === "radar") {
    head.push(e.subtitle);
    if (d.people && d.people.length) {
      head.push("People: " + d.people.map((p) => typeof p === "string" ? p : p.email ? `${p.name} <${p.email}>` : p.name).join("; "));
    }
    const acc = byKind(ix, nb, "account");
    let hop = new Set();
    for (const a of acc) hop = union(hop, neighbours(ix, a));
    sec("Salesforce account", acc.map((a) => item(ix, a)));
    sec("Opportunities", byKind(ix, hop, "opportunity").map((o) => item(ix, o)));
    sec("Tasks", taskItems(ix, union(byKind(ix, nb, "task"), byKind(ix, hop, "task"))));
    sec("Projects and events", projectsAndEvents());
    let docs = docsOf(ix, uid);
    for (const a of acc) docs = union(docs, docsOf(ix, a));
    secs.push(...docSections(ix, docs));
  } else if (k === "opportunity") {
    head.push(e.subtitle);
    head.push(`Owner ${d.owner || "?"} · ${d.type || "?"} · set-up ${money(d.setup)} · amount ${money(d.amount)} · ` +
      `term ${d.initial_term || "?"} · service live ${ddmm(d.service_live)}`);
    if (d.in_book) head.push("In Richard's book" + (d.book_attributed ? ` (attributed: ${d.in_book_reason})` : ""));
    const quotes = byKind(ix, nb, "quote");
    sec("Client", byKind(ix, nb, "account").map((a) => item(ix, a)));
    sec("Quotes", quotes.map((q) => item(ix, q)));
    sec("Tasks", taskItems(ix, byKind(ix, nb, "task")));
    sec("Logged activity", [...(d.activities || [])].sort((a, b) => cmp([b.date || ""], [a.date || ""]))
      .map((a) => plain({ kind: a.type, title: a.subject, subtitle: a.logged_by || "", date: a.date })));
    sec("Projects and events", projectsAndEvents());
    let docs = docsOf(ix, uid);
    for (const q of quotes) docs = union(docs, docsOf(ix, q));
    secs.push(...docSections(ix, docs));
  } else if (k === "quote") {
    head.push(e.subtitle);
    sec("Opportunity", byKind(ix, nb, "opportunity").map((o) => item(ix, o)));
    secs.push(...docSections(ix, docsOf(ix, uid)));
  } else if (k === "task") {
    head.push(e.subtitle);
    sec("On", [...nb].sort().filter((x) => ix.kind(x) !== "document").map((x) => item(ix, x)));
    secs.push(...docSections(ix, docsOf(ix, uid)));
  } else if (k === "event" || k === "project") {
    const ev = d.event || {};
    if (k === "event") {
      head.push(e.subtitle);
      if (ev.type) head.push("Type: " + ev.type);
      if (ev.our_role) head.push("Our role: " + ev.our_role);
    } else if (d.goal) {
      head.push("Goal: " + d.goal);
    }
    const h = d.health || {};
    if (h.status) head.push(`Health: ${h.status} — ${h.note || ""}`);
    if (ev.brief) head.push("Brief: " + ev.brief);
    const docs = docsOf(ix, uid);
    const tab = [...docs].filter((u) => u.endsWith(" - Event Tab.md"));
    sec("Travel plan and diary", tab.map((u) => item(ix, u)));
    sec("Objectives", (d.objectives || []).map((o) => plain({ kind: "objective", title: o.title,
      subtitle: [o.measure, o.by ? "by " + o.by : ""].filter(Boolean).join(" · "), status: o.status })));
    const acts = (d.next_actions || []).filter((a) => !["done", "dropped"].includes(a.status))
      .sort((a, b) => cmp([a.due || "9999"], [b.due || "9999"]));
    sec("Next actions", acts.map((a) => plain({ kind: "action", title: a.what,
      subtitle: [a.who, a.why ? "why: " + a.why : ""].filter(Boolean).join(" · "), date: a.due, status: a.status })));
    sec("People", (d.people || []).map((p) => plain({ kind: "person", title: p.name,
      subtitle: [p.org, p.role, p.stance].filter(Boolean).join(" · "), note: p.wants || "" })));
    sec("Organisations", (d.organisations || []).map((o) => plain({ kind: "organisation", title: o.name,
      subtitle: [o.relationship, o.role, o.aim].filter(Boolean).join(" · ") })));
    sec("Organisations linked to records", ix.out(uid, "organisation").map((x) => x[0]).sort().map((u) => item(ix, u)));
    sec("Part of", ix.out(uid).filter((x) => x[1] === "parent" || x[1] === "serves").map((x) => item(ix, x[0], x[1])));
    sec("Sub-projects and events", ix.inn(uid, "parent").map((x) => item(ix, x[0])));
    sec("Events serving this", ix.inn(uid, "serves").map((x) => item(ix, x[0])));
    sec("Related", ix.out(uid, "related").map((x) => item(ix, x[0])));
    const members = ix.out(uid, "member").map((x) => x[0]);
    for (const [kk, title] of [["opportunity", "Opportunities"], ["account", "Clients"], ["radar", "Radar entries"]]) {
      sec(title, byKind(ix, members, kk).map((u) => item(ix, u)));
    }
    sec("Tasks", taskItems(ix, byKind(ix, members, "task")));
    sec("Meetings", (d.meetings || []).map((m) => plain({ kind: "meeting", title: m.subject, subtitle: m.organiser || "",
      date: m.date, status: m.time })));
    sec("Key dates", [...(d.key_dates || [])].sort((a, b) => cmp([a.date || ""], [b.date || ""]))
      .map((x) => plain({ kind: "date", title: x.what, subtitle: x.kind || "", date: x.date, status: x.status })));
    sec("Attachments", (d.attachments || []).map((a) => plain({ kind: "file", title: a.split("/").pop(), subtitle: a })));
    const rest = new Set([...docs].filter((u) => !tab.includes(u)));
    secs.push(...docSections(ix, rest));
  } else if (k === "document") {
    head.push(e.path + (e.date ? " · " + ddmm(e.date) : ""));
    const recs = [...nb].sort().filter((u) => ix.kind(u) !== "document");
    const joined = [];
    for (const u of recs) {
      const rels = new Set([...ix.out(uid).filter((x) => x[0] === u).map((x) => x[1]),
        ...ix.inn(uid).filter((x) => x[0] === u).map((x) => x[1])]);
      for (const rel of rels) joined.push(item(ix, u, rel));
    }
    sec("Joined to", joined);
    sec("References", ix.out(uid, "references").map((x) => item(ix, x[0])));
    sec("Referenced by", ix.inn(uid, "references").map((x) => item(ix, x[0]))
      .sort((a, b) => cmp([b.date || ""], [a.date || ""])));
  }
  return { entity: e, head, sections: secs };
}

/** "CRM as at …" for every screen; warn when over a day old or incomplete. */
export function crmState(meta, now = new Date()) {
  const asAt = meta.crm_as_at || "";
  const t = new Date(asAt);
  const ageH = isNaN(t) ? null : (now - t) / 36e5;
  const complete = meta.crm_complete === "true";
  let age = "";
  if (ageH !== null && ageH > 24) age = ageH >= 48 ? `${Math.floor(ageH / 24)} days old` : `${Math.floor(ageH)} hours old`;
  return { asAt, when: asAt.slice(0, 16).replace("T", " "), complete, age, warn: !complete || Boolean(age),
    built: (meta.built_at || "").slice(0, 16).replace("T", " "), head: meta.git_head };
}
