// The Today screen's reading of a day's Meeting Brief and Start of Day. A port of the rules
// in Apps/captains-log-android/app/src/main/java/uk/co/datavita/captainslog/brief/Briefing.kt
// (documented in that app's README), over marked's tokens instead of commonmark-java's.

const BRIEF_SERIES = ["Meeting Brief", "Start of Day", "End of Day"];

export function stripFront(md) {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/<!-- backlinks:start[\s\S]*?<!-- backlinks:end -->\n?/, "");
}

const PILL = { todo: "amber", risk: "red", done: "ok", info: "" };
const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Vault conventions marked does not know: [[wikilinks]] become links the app resolves,
 *  and the dashboard's {{todo: …}} / {{risk: …}} / {{done}} markers become pills. */
export function prep(md) {
  return stripFront(md)
    .replace(/\[\[([^\]|#^]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, t, alias) => `[${alias || t}](#wiki=${encodeURIComponent(t.trim())})`)
    .replace(/\{\{([a-z]+)(?::\s*([^}]*))?\}\}/g, (_, kind, text) =>
      `<span class="pill ${PILL[kind] ?? ""}">${escape((text || kind).trim())}</span>`);
}

let scratch = null;
/** Inline Markdown -> plain text. */
export function plain(md) {
  if (!md) return "";
  scratch = scratch || document.createElement("div");
  scratch.innerHTML = window.DOMPurify.sanitize(window.marked.parseInline(md));
  return scratch.textContent;
}

const withLinks = (arr) => Object.assign(arr, { links: {} });

/** One Markdown file split at its H2 headings. */
export function parseDoc(md, meta = {}) {
  const tokens = window.marked.lexer(prep(md));
  const doc = { ...meta, title: "", preamble: withLinks([]), sections: [] };
  let cur = null;
  for (const t of tokens) {
    if (t.type === "heading" && t.depth === 1 && !doc.title) { doc.title = plain(t.text); continue; }
    if (t.type === "heading" && t.depth === 2) {
      cur = { title: t.text, plain: plain(t.text), tokens: withLinks([]) };
      doc.sections.push(cur);
      continue;
    }
    if (t.type === "space") continue;
    (cur ? cur.tokens : doc.preamble).push(t);
  }
  doc.section = (...names) => doc.sections.find((s) => names.some((n) => s.plain.toLowerCase().includes(n)));
  return doc;
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------
const TIME = /(\d{1,2})[:.](\d{2})/;
const RANGE = /(\d{1,2}[:.]\d{2})\s*[–—-]\s*(\d{1,2}[:.]\d{2})/;
// "## 11:00 — Title (where)" and, from October 2026, "## 15:30: Title".
const WORKUP_HEADING = /^\s*(\d{1,2}[:.]\d{2})(?:\s*[–—-]\s*\d{1,2}[:.]\d{2})?(?:\s+[—–-]+\s+|:\s+)(.+)$/;
const TRAILING_PAREN = /^(.*\S)\s*\(([^()]*)\)\s*$/;

/** -> minutes since midnight, or null. */
export function minutes(text) {
  const m = TIME.exec(text || "");
  if (!m) return null;
  const h = +m[1], mm = +m[2];
  return h <= 23 && mm <= 59 ? h * 60 + mm : null;
}
export const hhmm = (mins) => mins == null ? "" : `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const normTime = (text) => { const m = minutes(text); return m == null ? (text || "").trim() : hhmm(m); };

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
function column(table, ...names) {
  return table.header.findIndex((h) => {
    const t = plain(h.text).trim().toLowerCase();
    return names.some((n) => t === n || t.startsWith(n));
  });
}
const isPlaceholder = (s) => ["", "—", "-", "–"].includes((s || "").trim());

// ---------------------------------------------------------------------------
// Meeting workups
// ---------------------------------------------------------------------------
const SOURCE_TAGS = /`\[[A-Za-z0-9][A-Za-z0-9 _./-]{0,30}\]`/g;
const FOLLOWS_LABEL = new Set([",", ":", ".", "—", "–", "-", "("]);

/** "**Position.** The invite…" -> ["Position", "The invite…"]; also "**TL;DR** — …",
 *  "**In the model** `[vault]`" and a bold label alone. Null without a leading label. */
export function labelOf(text) {
  const m = /^(\*\*|__)([^*_\n][^\n]*?)\1([\s\S]*)$/.exec(text || "");
  if (!m) return null;
  const raw = m[2].trim();
  if (!raw || raw.length > 60 || raw.startsWith("`")) return null;
  const rest = m[3];
  const first = rest.trimStart()[0];
  const labelled = raw.endsWith(".") || raw.endsWith(":") || rest.replace(SOURCE_TAGS, "").trim() === "" ||
    rest.startsWith("\n") || FOLLOWS_LABEL.has(first);
  if (!labelled) return null;
  const label = raw.replace(/[.:\s]+$/, "");
  if (!label) return null;
  const lead = rest.replace(/^\s*[,:.—–-]?\s*/, "").trim();
  return [label, lead];
}

export function kindOf(label) {
  const l = label.toLowerCase();
  if (l.includes("tl;dr") || l.includes("tldr")) return "tldr";
  if (l.startsWith("watch out") || l.startsWith("cautions")) return "watch";
  if (l.includes("starter")) return "starters";
  if (l.includes("lean in")) return "lean";
  if (l.includes("who is in the room") || l === "who") return "who";
  if (l.startsWith("not established")) return "notest";
  if (l.includes("in the model")) return "model";
  if (l.includes("position") || l.includes("why this meeting")) return "position";
  if (l.includes("what they") || l.includes("what we want")) return "wants";
  if (l.startsWith("icp")) return "icp";
  if (l.includes("personalit")) return "personality";
  if (l.includes("relationship capital")) return "capital";
  return "other";
}

/** Splits a workup into parts. From September 2026 each part opens with a bold label;
 *  earlier briefings use "### Watch out" headings, in which case only headings split. */
function parts(tokens) {
  const byHeading = tokens.some((t) => t.type === "heading" && t.depth >= 3);
  const intro = withLinks([]);
  const out = [];
  let cur = null;
  for (const t of tokens) {
    let split = null;
    if (byHeading) {
      if (t.type === "heading" && t.depth >= 3) split = [plain(t.text).trim().replace(/[.:\s]+$/, ""), ""];
    } else if (t.type === "paragraph") {
      split = labelOf(t.text);
    }
    if (split) {
      cur = { label: split[0], kind: kindOf(split[0]), lead: split[1], tokens: withLinks([]) };
      out.push(cur);
    } else if (cur) {
      cur.tokens.push(t);
    } else {
      intro.push(t);
    }
  }
  return [intro, out];
}

function workups(doc) {
  const out = [];
  doc.sections.forEach((s, i) => {
    const m = WORKUP_HEADING.exec(s.plain);
    if (!m) return;
    const rest = m[2].trim();
    const p = TRAILING_PAREN.exec(rest);
    const [intro, ps] = parts(s.tokens);
    out.push({ id: `w${i}-${normTime(m[1]).replace(":", "")}`, time: normTime(m[1]), start: minutes(m[1]),
      title: p ? p[1] : rest, where: p ? p[2] : null, intro, parts: ps });
  });
  return out;
}

const words = (s) => new Set((s || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
const overlap = (a, b) => [...a].filter((w) => b.has(w)).length;

/** Links a diary row to its workup: same start time first, then shared title words. */
function match(start, title, ws) {
  const same = ws.filter((w) => start != null && w.start === start);
  if (same.length === 1) return same[0].id;
  const want = words(title);
  const pool = same.length ? same : ws;
  let best = null, score = 0;
  for (const w of pool) { const s = overlap(words(w.title), want); if (s > score) { best = w; score = s; } }
  return best && score >= (same.length ? 1 : 2) ? best.id : null;
}

/** Start -> end from a Logistics table whose When column carries ranges like 11:00–11:30. */
function endTimes(section) {
  const out = new Map();
  if (!section) return out;
  for (const t of section.tokens) {
    if (t.type !== "table") continue;
    const c = column(t, "when", "time");
    if (c < 0) continue;
    for (const row of t.rows) {
      const text = plain(row[c] && row[c].text);
      if (text.includes("/")) continue; // dated rows belong to other days
      const m = RANGE.exec(text);
      if (!m) continue;
      const s = minutes(m[1]), e = minutes(m[2]);
      if (s != null && e != null && e > s && !out.has(s)) out.set(s, e);
    }
  }
  return out;
}

function diary(section, ws, ends) {
  if (!section) return [];
  const table = section.tokens.find((t) => t.type === "table" && column(t, "time", "when") >= 0);
  if (!table) return [];
  const c = { time: column(table, "time", "when"), title: column(table, "meeting", "what"), who: column(table, "who"),
    cls: column(table, "class"), icp: column(table, "icp"), state: column(table, "one-line", "one line", "state", "brief") };
  return table.rows.map((row) => {
    const cell = (i) => (i >= 0 && row[i] && !isPlaceholder(plain(row[i].text)) ? row[i].text : null);
    const time = plain(cell(c.time) || "");
    const start = minutes(time);
    const r = RANGE.exec(time);
    const title = cell(c.title) || "";
    return { time: normTime(time), start, end: r ? minutes(r[2]) : (start != null && ends.has(start) ? ends.get(start) : null),
      title, who: cell(c.who), cls: plain(cell(c.cls) || "").trim() || null, icp: cell(c.icp), state: cell(c.state),
      workupId: match(start, plain(title), ws) };
  });
}

function groups(tokens) {
  const out = [];
  let cur = { title: null, tokens: withLinks([]) };
  for (const t of tokens) {
    if (t.type === "heading" && t.depth >= 3) {
      if (cur.title || cur.tokens.length) out.push(cur);
      cur = { title: plain(t.text).trim(), tokens: withLinks([]) };
    } else {
      cur.tokens.push(t);
    }
  }
  if (cur.title || cur.tokens.length) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// A day's briefing, from the index
// ---------------------------------------------------------------------------
const suffixOf = (title) => ((/\d{8}\s*(.*)$/.exec(title) || [])[1] || "").trim().replace(/^[-\s]+|[-\s]+$/g, "") || null;

/** Every date that has a Meeting Brief or Start of Day, newest first. */
export function briefingDates(ix) {
  const dates = new Set();
  for (const e of ix.ent.values()) {
    if (e.kind === "document" && (e.series === "Meeting Brief" || e.series === "Start of Day") && e.date) dates.add(e.date);
  }
  return [...dates].sort().reverse();
}

export function briefingFor(ix, date) {
  const docs = [...ix.ent.values()]
    .filter((e) => e.kind === "document" && e.date === date && BRIEF_SERIES.includes(e.series))
    .map((e) => ({ uid: e.uid, series: e.series, suffix: suffixOf(e.title), path: e.path, title: e.title }))
    .sort((a, b) => BRIEF_SERIES.indexOf(a.series) - BRIEF_SERIES.indexOf(b.series) || (a.suffix || "").localeCompare(b.suffix || ""));
  const parsed = docs.map((d) => parseDoc(ix.body(d.uid), d));
  const mb = parsed.find((d) => d.series === "Meeting Brief" && !d.suffix) || parsed.find((d) => d.series === "Meeting Brief");
  const sod = parsed.find((d) => d.series === "Start of Day");

  const ws = mb ? workups(mb) : [];
  const logSection = (mb && mb.section("logistics")) || (sod && sod.section("logistics"));
  const ends = endTimes(logSection);
  const icpByTime = new Map();
  if (sod) for (const r of diary(sod.section("today's diary", "diary"), [], new Map())) if (r.icp) icpByTime.set(r.time, r.icp);
  const diarySection = (mb && mb.section("day at a glance", "today's diary", "diary")) || (sod && sod.section("today's diary", "diary"));
  const rows = diary(diarySection, ws, ends).map((r) => (r.icp || !icpByTime.has(r.time) ? r : { ...r, icp: icpByTime.get(r.time) }));

  const first = (name, type) => {
    for (const d of parsed) {
      const s = d.section(name);
      const t = s && s.tokens.find((x) => x.type === type);
      if (t) return t;
    }
    return null;
  };
  const doc = mb || sod || parsed[0];
  return {
    date, docs: parsed, title: doc ? doc.title : "",
    sources: doc ? doc.preamble : [],
    before: first("before anything else", "list"),
    diary: rows,
    workups: ws,
    logistics: logSection ? groups(logSection.tokens) : [],
    bite: first("dates that bite", "table"),
    transcripts: mb && mb.section("transcripts") ? mb.section("transcripts").tokens : null,
  };
}

/** The meeting under way at `now` (minutes) and the next to start. */
export function nowAndNext(rows, now) {
  const timed = rows.filter((r) => r.start != null).sort((a, b) => a.start - b.start);
  let current = null, next = null;
  timed.forEach((r, i) => {
    const later = timed[i + 1] && timed[i + 1].start > r.start ? timed[i + 1].start : null;
    const end = r.end || later || r.start + 60;
    if (now >= r.start && now < end) current = r;
    if (!next && r.start > now) next = r;
  });
  return [current, next];
}
