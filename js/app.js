// Captain's Log (web): a read-only, offline view of the vault index for iPhone, iPad and
// the Pixel. Screens: Today, Logistics, Find (browse and search), cards, notes and Data.
import * as store from "./store.js";
import { sqlReady, Ix, card, item, KIND_LABEL, CLOSED, ddmm, money, crmState } from "./index.js";
import { briefingDates, briefingFor, nowAndNext, hhmm, prep } from "./brief.js";

const $ = (id) => document.getElementById(id);
const view = $("view");
let ix = null;
let info = null;

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false || kid === "") continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const enc = encodeURIComponent;
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const longDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortDay = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "2-digit" });
const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5);

function radarLabel(e) {
  const d = ix.get(e.uid).data;
  const role = d.role || "";
  return role ? role[0].toUpperCase() + role.slice(1) : KIND_LABEL.radar;
}
const kindLabel = (it) => (it.kind === "radar" ? radarLabel(it) : KIND_LABEL[it.kind] || it.kind);

// ---------------------------------------------------------------------------
// Markdown: sanitised, tables become cards on a phone, links resolve inside the index
// ---------------------------------------------------------------------------
const SFID_RE = /^(?:00[1-9A-Za-z]|a[0-9][0-9A-Za-z])[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/;

function mdNode(htmlOrTokens, here) {
  const html = typeof htmlOrTokens === "string" ? window.marked.parse(prep(htmlOrTokens)) : window.marked.parser(htmlOrTokens);
  const box = h("div", { class: "md" });
  box.innerHTML = window.DOMPurify.sanitize(html);
  for (const a of box.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    let target = null;
    if (href.startsWith("#wiki=")) target = ix.byPath(decodeURIComponent(href.slice(6)), here);
    else if (/^https?:/i.test(href)) { a.target = "_blank"; a.rel = "noopener noreferrer"; continue; }
    else if (/\.md(#.*)?$/i.test(href) && !/^[a-z]+:/i.test(href)) target = ix.byPath(href, here);
    else if (href.startsWith("#/")) continue;
    if (target) { a.href = "#/card/" + enc(target); a.classList.add("rec"); }
    else a.replaceWith(h("span", {}, a.textContent));
  }
  for (const c of box.querySelectorAll("code")) {
    if (c.closest("pre")) continue;
    const t = c.textContent.trim();
    if (/^\[[A-Za-z0-9][A-Za-z0-9 _./-]{0,30}\]$/.test(t)) { c.classList.add("src"); continue; }
    const uid = SFID_RE.test(t) ? ix.bySfid(t) : /^Q-\d{5}$/.test(t) ? ix.quoteByNumber(t) : null;
    if (uid) c.replaceWith(h("a", { href: "#/card/" + enc(uid), class: "rec" }, c.cloneNode(true)));
  }
  // Obsidian callouts: "> [!warning] Title" opens a coloured box
  for (const q of box.querySelectorAll("blockquote")) {
    const p = q.firstElementChild;
    const m = p && p.tagName === "P" && /^\s*\[!(\w+)\][+-]?\s*([^\n]*)/.exec(p.textContent);
    if (!m) continue;
    q.classList.add("callout", "c-" + m[1].toLowerCase());
    const first = p.firstChild;
    if (first && first.nodeType === 3) first.textContent = first.textContent.replace(/^\s*\[!\w+\][+-]?\s*/, "");
    if (!m[2].trim()) p.prepend(h("strong", {}, m[1][0].toUpperCase() + m[1].slice(1)));
  }
  for (const table of box.querySelectorAll("table")) {
    const labels = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    for (const tr of table.querySelectorAll("tbody tr")) {
      [...tr.children].forEach((td, i) => { if (labels[i]) td.setAttribute("data-label", labels[i]); });
    }
    table.replaceWith(h("div", { class: "table-wrap" }, table.cloneNode(true)));
  }
  return box;
}
const inline = (md) => { const s = h("span"); s.innerHTML = window.DOMPurify.sanitize(window.marked.parseInline(md || "")); return s; };

// ---------------------------------------------------------------------------
// Item rows and sections
// ---------------------------------------------------------------------------
function pillFor(it) {
  const today = todayISO();
  if (it.kind === "task") {
    if (it.status === "Completed") return h("span", { class: "pill ok" }, "done");
    if (it.date && it.date < today) return h("span", { class: "pill red" }, "overdue");
    if (it.date === today) return h("span", { class: "pill amber" }, "today");
    return null;
  }
  if (it.kind === "quote" && it.date && it.date < today) return h("span", { class: "pill amber" }, "expired");
  if ((it.kind === "objective" || it.kind === "action") && it.status) {
    const s = it.status.toLowerCase();
    return h("span", { class: "pill" + (/(red|risk|overdue|blocked)/.test(s) ? " red" : /(amber|open|todo|pending)/.test(s) ? " amber" : /(done|met|green)/.test(s) ? " ok" : "") }, it.status);
  }
  return null;
}

function row(it, showKind) {
  const linkable = it.uid && ix.ent.has(it.uid);
  const side = [];
  if (it.date && !["opportunity", "account", "radar", "project"].includes(it.kind)) side.push(h("div", {}, ddmm(it.date)));
  if (it.kind === "meeting" && it.status) side.push(h("div", {}, it.status));
  const pill = pillFor(it);
  const main = h("div", { class: "main" },
    h("div", { class: "t" }, showKind ? [h("span", { class: "pill kind" }, kindLabel(it)), " "] : null, it.title),
    it.subtitle && it.kind !== "document" ? h("div", { class: "s" }, it.subtitle) : null,
    it.kind === "document" && it.subtitle ? h("div", { class: "s" }, it.subtitle) : null,
    it.note ? h("div", { class: "n" }, it.note) : null);
  const el = h(linkable ? "a" : "div", { class: "item", href: linkable ? "#/card/" + enc(it.uid) : null },
    main, side.length || pill ? h("div", { class: "side" }, pill, ...side) : null);
  return h("li", {}, el);
}

const CAP = 8;
function section(title, items, opts = {}) {
  const kinds = new Set(items.map((i) => i.kind));
  const showKind = opts.showKind ?? kinds.size > 1;
  const list = h("ul", { class: "items" });
  const cap = opts.cap ?? CAP;
  items.slice(0, cap).forEach((it) => list.append(row(it, showKind)));
  const box = h("div", { class: "card" }, list);
  if (items.length > cap) {
    const more = h("button", { class: "more", onclick: () => {
      items.slice(cap).forEach((it) => list.append(row(it, showKind)));
      more.remove();
    } }, `Show ${items.length - cap} more`);
    box.append(more);
  }
  const head = [title, " ", h("span", { class: "count" }, items.length)];
  if (opts.folded) return h("details", { class: "fold" }, h("summary", {}, ...head), box);
  return h("div", { class: "sec" }, h("h2", {}, ...head), box);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function setTitle(t) { $("title").textContent = t; document.title = t === "Captain's Log" ? t : `${t} · Captain's Log`; }

function viewToday(params) {
  const dates = briefingDates(ix);
  const today = todayISO();
  const date = params.get("d") || dates.find((d) => d <= today) || dates[0];
  setTitle("Today");
  if (!date) return [h("p", { class: "empty" }, "No Meeting Brief or Start of Day in the index yet.")];
  const b = briefingFor(ix, date);
  const i = dates.indexOf(date);
  const out = [];
  out.push(h("div", { class: "daybar" },
    h("button", { "aria-label": "Earlier day", disabled: i >= dates.length - 1, onclick: () => go(`#/today?d=${dates[i + 1]}`) }, "‹"),
    h("h2", {}, longDate(date)),
    h("button", { "aria-label": "Later day", disabled: i <= 0, onclick: () => go(`#/today?d=${dates[i - 1]}`) }, "›")));
  if (date !== today) {
    const n = daysBetween(date, today);
    out.push(h("div", { class: "banner" }, n > 0
      ? `This is the briefing for ${shortDay(date)}, ${n} day${n === 1 ? "" : "s"} ago. There is none for today in the index.`
      : `This briefing is for ${shortDay(date)}, ${-n} day${n === -1 ? "" : "s"} ahead.`));
  }
  if (b.title) out.push(h("p", { class: "note" }, b.title));

  if (date === today && b.diary.length) {
    const now = new Date();
    const [cur, next] = nowAndNext(b.diary, now.getHours() * 60 + now.getMinutes());
    const tile = (label, r) => h("div", { class: "card" }, h("div", { class: "kicker" }, label),
      r ? [h("div", { class: "t" }, r.time, " · ", inline(r.title)),
        r.start != null && label === "Next" ? h("div", { class: "s" }, `in ${fmtMins(r.start - (now.getHours() * 60 + now.getMinutes()))}`) : null]
        : h("div", { class: "s" }, label === "Now" ? "Nothing under way" : "Nothing else today"));
    out.push(h("div", { class: "nownext" }, tile("Now", cur), tile("Next", next)));
  }
  if (date === today || !params.get("d")) out.push(logisticsPointer());   // live, whichever briefing is showing

  if (b.before) out.push(h("div", { class: "sec" }, h("h2", {}, "Before anything else"), h("div", { class: "card" }, mdNode(Object.assign([b.before], { links: {} })))));

  if (b.diary.length) {
    const nowM = date === today ? new Date().getHours() * 60 + new Date().getMinutes() : null;
    const list = h("ul", { class: "items timeline" });
    for (const r of b.diary) {
      const end = r.end || (r.start != null ? r.start + 60 : null);
      const past = nowM != null && end != null && end <= nowM;
      const now = nowM != null && r.start != null && r.start <= nowM && end > nowM;
      const body = h("div", { class: "main" }, h("div", { class: "t" }, inline(r.title)),
        r.who ? h("div", { class: "s" }, inline(r.who)) : null,
        r.state ? h("div", { class: "n" }, inline(r.state)) : null);
      const href = r.workupId ? `#/workup/${date}/${r.workupId}` : null;
      list.append(h("li", {}, h(href ? "a" : "div", { class: "item" + (past ? " past" : "") + (now ? " now" : ""), href },
        h("div", { class: "time" }, r.time || "—", r.end ? h("div", { class: "n" }, hhmm(r.end)) : null), body,
        r.cls ? h("div", { class: "side" }, h("span", { class: "pill" }, r.cls)) : null)));
    }
    out.push(h("div", { class: "sec" }, h("h2", {}, "The day ", h("span", { class: "count" }, b.diary.length)), h("div", { class: "card" }, list)));
  } else {
    const cal = calendar(date);
    if (cal) out.push(cal);
  }

  for (const g of b.logistics) {
    if (!g.tokens.length) continue;
    out.push(h("div", { class: "sec" }, h("h2", {}, g.title || "Logistics"), h("div", { class: "card" }, mdNode(g.tokens))));
  }
  if (b.bite) out.push(h("div", { class: "sec" }, h("h2", {}, "Dates that bite"), h("div", { class: "card" }, mdNode(Object.assign([b.bite], { links: {} })))));

  if (b.diary.length && date !== today) { const cal = calendar(today, true); if (cal) out.push(cal); }
  out.push(tasksDue(today));
  out.push(section("The day's files", b.docs.map((d) => item(ix, d.uid)), { showKind: false }));
  return out;
}

function fmtMins(m) { return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; }

function calendar(date, folded) {
  const rows = ix.rows("SELECT date, time, subject, organiser, location FROM diary WHERE date = ? ORDER BY time", [date]);
  if (!rows.length) return null;
  const items = rows.map((r) => ({ uid: null, kind: "meeting", title: r.subject, subtitle: [r.organiser, r.location].filter(Boolean).join(" · "),
    date: null, status: r.time, note: "" }));
  return section(`Calendar for ${shortDay(date)} (crm.json)`, items, { folded, showKind: false, cap: 20 });
}

function tasksDue(today) {
  const items = ix.all("task").map((u) => item(ix, u)).filter((t) => t.status !== "Completed" && t.date && t.date <= today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return section("Tasks overdue or due today", items, { folded: true, showKind: false, cap: 30 });
}

function viewWorkup(date, id) {
  const b = briefingFor(ix, date);
  const w = b.workups.find((x) => x.id === id);
  setTitle("Meeting");
  if (!w) return [h("p", { class: "empty" }, "That meeting is not in the briefing.")];
  const order = ["tldr", "watch", "starters"];
  const ps = [...w.parts].sort((a, b2) => (order.indexOf(a.kind) + 1 || 9) - (order.indexOf(b2.kind) + 1 || 9));
  const out = [h("div", { class: "kicker" }, `${shortDay(date)} · ${w.time}`), h("h2", { class: "headline" }, w.title)];
  if (w.where) out.push(h("p", { class: "note" }, w.where));
  if (w.intro.length) out.push(h("div", { class: "card" }, mdNode(w.intro)));
  for (const p of ps) {
    const body = h("div", { class: "card part " + p.kind }, h("h2", {}, p.label));
    if (p.lead) body.append(mdNode(p.lead));
    if (p.tokens.length) body.append(mdNode(p.tokens));
    out.push(body);
  }
  const mb = b.docs.find((d) => d.series === "Meeting Brief");
  if (mb) out.push(h("p", {}, h("a", { href: "#/card/" + enc(mb.uid) }, "Open the whole Meeting Brief")));
  return out;
}

// ---------------------------------------------------------------------------
// Logistics: DiaryCheck's read of the diary, the same assessment as the Captain's Log
// Logistics tab. Every entry opens with where to be and how to get there, then every
// invitee and their response; problems are boxed with their potential actions. The
// numbers are DiaryCheck's own, so an answer by number means the same thing everywhere.
// ---------------------------------------------------------------------------
const RESP = { accepted: "ok", organiser: "ok", tentative: "amber", none: "amber", declined: "red" };
const SIDE = { dv: "DataVita", external: "External", self: "You", unknown: "not classified" };
const SIDE_ORDER = { dv: 0, external: 1, unknown: 2 };
const QUIET_CLS = ["solo", "personal", "hold", "travel"];
const minsOf = (s) => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ""); return m ? +m[1] * 60 + +m[2] : null; };
const nowMins = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return isoOf(d); };
const weekend = (iso) => [0, 6].includes(new Date(iso + "T12:00:00").getDay());
const dayHead = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const stamp = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(s || ""); return m ? `${m[3]}/${m[2]} ${m[4]}` : s || "?"; };
const anchor = (key) => "ev-" + [...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7).toString(36);
/** An organiser as a name: diarycheck.py's split_name ("Mark.Hagart@gov.scot", "Brett, Serena", "(Datavita) Danny Quinn"). */
function orgName(raw) {
  let n = (raw || "").trim();
  const angle = /^(.*?)\s*<[^>]+@[^>]+>$/.exec(n);
  if (angle) n = angle[1];
  else if (/^[^\s@]+@[^\s@]+$/.test(n)) n = n.split("@")[0];
  n = n.replace(/\((?:datavita|external)\)/gi, "").trim();
  if (n.includes(",")) { const [last, first] = n.split(/,(.*)/s).map((p) => p.trim()); n = `${first} ${last}`; }
  if (n.includes(".") && !n.includes(" ")) n = n.split(".").map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
  return n.replace(/\s+/g, " ").trim();
}

function diaryCheck() {
  if (!ix || !ix.meta.diarycheck) return null;
  try { return JSON.parse(ix.meta.diarycheck); } catch { return null; }
}

/** The DiaryCheck read as of this moment: past entries and their checks drop out by this device's clock. */
function diaryNow(dc) {
  const today = todayISO(), m = nowMins();
  const past = (e) => e.date < today || (e.date === today && minsOf(e.end) != null && minsOf(e.end) <= m);
  const pastKeys = new Set(dc.events.filter(past).map((e) => e.key));
  const live = (c) => !c.event.split(" × ").some((k) => pastKeys.has(k));
  const open = dc.open.filter(live);
  return { today, past, open, ruled: dc.ruled.filter(live),
    problems: open.filter((c) => c.sev === "red"), checks: open.filter((c) => c.sev === "amber") };
}

function respPill(r) {
  r = (r || "unknown").toLowerCase();
  return h("span", { class: "pill " + (RESP[r.split(" ")[0]] || "") }, r === "none" ? "no response" : r);
}

function whereLine(ev) {
  const w = ev.where || {};
  const badge = (cls, t) => h("span", { class: "wb " + cls }, t);
  if (ev.attending === false) return [badge("unknown", "NOT GOING"), h("b", {}, "Off the plan")];
  if (w.mode === "in-person") {
    const name = w.place_name || w.place || ev.location || "place not known";
    const addr = w.place_address || w.address;
    return [badge("person", "IN PERSON"), h("b", {}, name), w.room && !name.includes(w.room) ? ` · ${w.room}` : null, addr ? h("div", { class: "addr" }, addr) : null];
  }
  if (w.mode === "hybrid") return [badge("teams", "TEAMS"), h("b", {}, "Online"), w.room ? ` · room ${w.room} booked` : null];
  if (w.mode === "teams") return [badge("teams", "TEAMS"), h("b", {}, "Online")];
  if (w.mode === "phone") return [badge("teams", "PHONE"), h("b", {}, "Call")];
  return [badge("unknown", "WHERE NOT KNOWN"), h("b", {}, "No location, no Teams link")];
}

function invitees(ev) {
  const ppl = (ev.people || []).filter((a) => a.side !== "self").sort((a, b) =>
    ((a.type !== "organiser") - (b.type !== "organiser")) || ((SIDE_ORDER[a.side] ?? 3) - (SIDE_ORDER[b.side] ?? 3))
    || ((a.type === "optional") - (b.type === "optional")) || a.name.localeCompare(b.name));
  if (!ppl.length) return null;
  const list = h("ul", { class: "items lg-people" });
  for (const a of ppl) {
    const r = a.response || "unknown";
    let warn = null;
    if (!["accepted", "organiser"].includes(r)) {
      warn = a.side === "dv" && a.type !== "optional" ? h("div", { class: "lg-flag red" }, "⚠ DataVita, required, not accepted")
        : a.side === "dv" ? h("div", { class: "lg-flag amber" }, "⚑ DataVita, optional")
          : h("div", { class: "lg-flag amber" }, "⚑ external, not accepted");
    }
    const req = a.type === "organiser" ? "organiser" : a.type || "required";
    list.append(h("li", {}, h("div", { class: "item" },
      h("div", { class: "main" }, h("div", { class: "t" }, a.name), h("div", { class: "s" }, `${SIDE[a.side] || a.side} · ${req}`), warn),
      h("div", { class: "side" }, respPill(r)))));
  }
  if (ppl.length <= 8) return list;
  const acc = ppl.filter((a) => ["accepted", "organiser"].includes(a.response)).length;
  return h("details", { class: "lg-ppl" }, h("summary", {}, `${ppl.length} invitees · ${acc} accepted · ${ppl.length - acc} not`), list);
}

function checkBox(c) {
  const mark = { red: "⚠", amber: "⚑" }[c.sev] || "ℹ";
  if (c.sev === "info") return h("div", { class: "lg-flag info" }, `${mark} ${c.text}`);
  return h("div", { class: "lg-prob " + c.sev },
    h("b", {}, `${mark} ${c.sev === "red" ? "PROBLEM" : "CHECK"}${c.n ? " #" + c.n : ""} `), c.text,
    c.changed_since ? " (changed since you settled it)" : null,
    c.actions && c.actions.length ? h("ul", {}, c.actions.map((a) => h("li", {}, a))) : null);
}

function entryCard(ev, flags, ruled) {
  const off = ev.attending === false;
  const org = orgName(ev.organiser);
  const self = (ev.people || []).find((p) => p.side === "self");
  const mine = !org || (self && orgName(self.name).toLowerCase() === org.toLowerCase());
  const card = h("div", { class: "card lg-ev" + (flags.some((c) => c.sev === "red") ? " warn" : "") + (off ? " off" : ""), id: anchor(ev.key) },
    h("div", { class: "lg-where" }, whereLine(ev)));
  const how = ev.logistics;
  if (how && !off) card.append(h("div", { class: "lg-how" + (/not (known|timed)|not in places/.test(how) ? " unknown" : "") }, how));
  card.append(h("div", { class: "lg-title" }, `${ev.start || ""}–${ev.end || ""} · ${ev.subject || ""}`),
    h("div", { class: "lg-org" }, mine ? "your entry" : `from ${org.split(" ")[0]}`, mine ? null : [" · you: ", respPill(ev.my_response)], ev.recurring ? " · recurring" : null));
  for (const c of flags) card.append(checkBox(c));
  const ppl = invitees(ev);
  if (ppl) card.append(ppl);
  for (const c of ruled) card.append(h("div", { class: "lg-ruled" }, h("s", {}, c.text), h("div", {}, `Ruled ${ddmm((c.ruling && c.ruling.at) || "").slice(0, 5)}: ${(c.ruling && c.ruling.ruling) || ""}`)));
  for (const n of ev.notes || []) card.append(h("div", { class: "lg-mini" }, n[0].toUpperCase() + n.slice(1)));
  return card;
}

function viewLogistics() {
  setTitle("Logistics");
  const dc = diaryCheck();
  if (!dc) return [h("p", { class: "empty" }, "No DiaryCheck read in this index yet. StartOfDay and EndOfDay run it; the next index build carries it here.")];
  const st = diaryNow(dc);
  const { today } = st;
  const out = [];
  const w = dc.window || {};
  let last = today, k = 0;
  while (k < 6) { last = addDays(last, 1); if (!weekend(last)) k++; }
  const stale = [];
  const age = (Date.now() - new Date(dc.read_at)) / 36e5;
  if (!(age <= 20)) stale.push(Number.isFinite(age) ? `the diary was read ${(age / 24).toFixed(1)} days ago` : "the read time is not recorded");
  if (w.to && w.to < last) stale.push(w.to < today ? "the read has no days left in it" : `the read covers only to ${shortDay(w.to)}`);
  out.push(h("p", { class: "note" }, `Read from Outlook ${stamp(dc.read_at)} by DiaryCheck: where to be, how to get there, and who has not accepted.`));
  if (stale.length) out.push(h("div", { class: "banner" }, `Stale: ${stale.join("; ")}. StartOfDay and EndOfDay re-read it.`));

  const ahead = dc.events.filter((e) => e.cls !== "banner" && !st.past(e));
  const inPerson = ahead.filter((e) => e.where && e.where.mode === "in-person" && e.attending !== false);
  out.push(h("div", { class: "lg-tiles" },
    [[ahead.length, "ahead", ""], [inPerson.length, "in person", ""], [st.problems.length, "problems", " red"], [st.checks.length, "to check", " amber"], [st.ruled.length, "settled", ""]]
      .map(([n, l, c]) => h("div", { class: "lg-tile" + (n ? c : "") }, h("b", {}, n), h("span", {}, l)))));

  const needs = [...st.problems, ...st.checks].sort((a, b) => (a.n || 999) - (b.n || 999));
  if (needs.length) {
    const list = h("ul", { class: "items" });
    for (const c of needs) {
      const target = anchor(c.event.split(" × ")[0]);
      list.append(h("li", {}, h("button", { class: "item lg-need", onclick: () => { const el = document.getElementById(target); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); } },
        h("div", { class: "main" }, h("div", { class: "s" }, `#${c.n} · ${shortDay(c.date)} ${c.start || ""}`),
          h("div", { class: "t lg-flag " + c.sev }, `${c.sev === "red" ? "⚠" : "⚑"} ${c.text}`),
          (c.actions || []).map((a) => h("div", { class: "n" }, "→ " + a))))));
    }
    out.push(h("div", { class: "sec" }, h("h2", {}, "Needs you ", h("span", { class: "count" }, needs.length)),
      h("p", { class: "note" }, "Problems first, then things to check. Nothing is done until you say so; answer by number."),
      h("div", { class: "card" }, list)));
  }

  const byEv = new Map(), ruledEv = new Map();
  for (const c of st.open) for (const key of c.event.split(" × ")) push2(byEv, key, c);
  for (const c of st.ruled) for (const key of c.event.split(" × ")) push2(ruledEv, key, c);
  const end = w.to && w.to > last ? w.to : last;
  for (let d = today; d <= end; d = addDays(d, 1)) {
    const des = dc.events.filter((e) => e.date === d).sort((a, b) => (a.start || "").localeCompare(b.start || "") || a.subject.localeCompare(b.subject));
    const rest = des.filter((e) => e.cls !== "banner");
    if (weekend(d) && !rest.length) continue;
    const info = (dc.days || {})[d] || {};
    const txt = [...(info.banners || [])];
    if (info.base && rest.some((e) => e.where && e.where.mode === "in-person" && e.attending !== false)) txt.push(`day starts from ${info.base.name}${info.base.assumed ? " (assumed)" : ""}`);
    const sec = h("div", { class: "sec lg-day" }, h("h2", {}, dayHead(d), d === today ? h("span", { class: "count" }, "today") : null),
      txt.length ? h("p", { class: "note" }, txt.join(" · ")) : null);
    out.push(sec);
    if (w.to && d > w.to) { sec.append(h("div", { class: "lg-mini" }, "Not read yet.")); continue; }
    if (!rest.length) { sec.append(h("div", { class: "lg-mini" }, "Nothing in the diary.")); continue; }
    const quiet = rest.filter((e) => e.cls === "internal" && ["teams", "hybrid"].includes(e.where && e.where.mode) && !byEv.has(e.key) && !st.past(e));
    for (const e of rest) {
      if (quiet.includes(e)) continue;
      if (st.past(e)) sec.append(h("div", { class: "lg-mini" }, `${e.start || ""} ${e.subject} · done`));
      else if (QUIET_CLS.includes(e.cls) && ["none", "teams"].includes(e.where && e.where.mode) && !byEv.has(e.key))
        sec.append(h("div", { class: "lg-mini" }, `${e.start || ""}–${e.end || ""} ${e.subject} · ${e.cls}`));
      else sec.append(entryCard(e, byEv.get(e.key) || [], ruledEv.get(e.key) || []));
    }
    if (quiet.length) sec.append(h("details", { class: "fold lg-int" }, h("summary", {}, `${quiet.length} internal Teams call${quiet.length === 1 ? "" : "s"}, every DataVita invitee accepted`),
      quiet.map((e) => entryCard(e, [], ruledEv.get(e.key) || []))));
  }
  out.push(h("p", { class: "note" }, "Read-only: nothing here accepts, declines or sends. DiaryCheck's numbers are the ones its runs print."));
  return out;
}
function push2(m, k, v) { if (!m.has(k)) m.set(k, []); m.get(k).push(v); }

/** Today's one-line pointer to the Logistics screen, when DiaryCheck has something open. */
function logisticsPointer() {
  const dc = diaryCheck();
  if (!dc) return null;
  const st = diaryNow(dc);
  const todays = [...st.problems, ...st.checks].filter((c) => c.date === st.today);
  const all = st.problems.length + st.checks.length;
  if (!all) return null;
  const red = todays.some((c) => c.sev === "red") || st.problems.length;
  return h("a", { class: "card lg-pointer" + (red ? " warn" : ""), href: "#/logistics" },
    h("div", { class: "kicker" }, "Logistics"),
    h("div", { class: "t" }, todays.length ? `${todays.length} to look at today` : "Nothing to look at today",
      ` · ${st.problems.length} problem${st.problems.length === 1 ? "" : "s"} and ${st.checks.length} to check in the next 7 working days ›`));
}

const BROWSE = [
  ["account", "Clients"], ["opportunity", "Opportunities"], ["quote", "Quotes"], ["task", "Tasks"],
  ["project", "Projects"], ["event", "Events"], ["radar", "Partners and interests"], ["document", "Notes"],
];

function listOf(kind) {
  const its = ix.all(kind).map((u) => item(ix, u));
  const today = todayISO();
  const by = {
    account: (a, b) => (ix.get(b.uid).data.book_mrr || 0) - (ix.get(a.uid).data.book_mrr || 0) || a.title.localeCompare(b.title),
    opportunity: (a, b) => (CLOSED.has(a.status) - CLOSED.has(b.status)) || (ix.get(b.uid).data.mrr || 0) - (ix.get(a.uid).data.mrr || 0),
    quote: (a, b) => (b.date || "").localeCompare(a.date || ""),
    task: (a, b) => (a.status === "Completed") - (b.status === "Completed") || (a.date || "9999").localeCompare(b.date || "9999"),
    event: (a, b) => ((a.date || "") < today) - ((b.date || "") < today) || (a.date || "").localeCompare(b.date || ""),
    project: (a, b) => (ix.get(a.uid).data.order || 999) - (ix.get(b.uid).data.order || 999),
    radar: (a, b) => (ix.get(a.uid).data.category || "").localeCompare(ix.get(b.uid).data.category || "") || a.title.localeCompare(b.title),
    document: (a, b) => (b.date || "").localeCompare(a.date || "") || a.title.localeCompare(b.title),
  }[kind];
  return its.sort(by);
}

function viewBrowse(params) {
  const q = params.get("q") || "";
  const k = params.get("k") || "";
  setTitle("Find");
  const input = h("input", { type: "search", placeholder: "Search clients, deals, partners and notes", value: q,
    autocapitalize: "off", autocomplete: "off", enterkeyhint: "search" });
  let t = null;
  input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => go(qs({ q: input.value, k }), true), 250); });
  const chips = h("div", { class: "chips" }, h("a", { class: "chip" + (k ? "" : " on"), href: qs({ q }) }, "All"),
    ...BROWSE.map(([kind, label]) => h("a", { class: "chip" + (k === kind ? " on" : ""), href: qs({ q, k: kind }) }, label)));
  const out = [h("div", { class: "searchbox" }, input, chips)];
  const results = h("div");
  out.push(results);

  if (!q && !k) {
    results.append(section("Clients", listOf("account").filter((a) => ix.get(a.uid).data.open || ix.get(a.uid).data.book_mrr), { showKind: false, cap: 6 }));
    results.append(section("Open opportunities", listOf("opportunity").filter((o) => !CLOSED.has(o.status)), { showKind: false, cap: 6 }));
    results.append(section("Events", listOf("event").filter((e) => (e.date || "") >= todayISO()), { showKind: false, cap: 6 }));
    results.append(section("Projects", listOf("project"), { showKind: false, cap: 6 }));
    results.append(section("Partners and interests", listOf("radar").filter((r) => ix.get(r.uid).data.status !== "closed"), { showKind: true, cap: 6 }));
    return out;
  }
  if (k && !q) {
    results.append(section(BROWSE.find((x) => x[0] === k)[1], listOf(k), { showKind: k === "radar", cap: 60 }));
    return out;
  }
  const named = ix.find(q).filter((u) => !k || ix.kind(u) === k);
  const records = named.filter((u) => ix.kind(u) !== "document").slice(0, 40).map((u) => item(ix, u));
  if (records.length) results.append(section("Records", records, { cap: 12 }));
  const hits = ix.search(q, 60).filter((x) => !k || ix.kind(x.uid) === k);
  if (hits.length) {
    const list = h("ul", { class: "items" });
    for (const x of hits) {
      const it = item(ix, x.uid);
      const snip = h("div", { class: "snip" });
      snip.innerHTML = escapeHtml((x.snippet || "").replace(/\s+/g, " ")).replace(/\u0002/g, "<mark>").replace(/\u0003/g, "</mark>");
      list.append(h("li", {}, h("a", { class: "item", href: "#/card/" + enc(x.uid) },
        h("div", { class: "main" }, h("div", { class: "t" }, h("span", { class: "pill kind" }, kindLabel(it)), " ", it.title), snip),
        it.date ? h("div", { class: "side" }, ddmm(it.date)) : null)));
    }
    results.append(h("div", { class: "sec" }, h("h2", {}, "Text matches ", h("span", { class: "count" }, hits.length)), h("div", { class: "card" }, list)));
  }
  if (!records.length && !hits.length) results.append(h("p", { class: "empty" }, `Nothing matches “${q}”.`));
  if (!ix.fts) results.append(h("p", { class: "note" }, "Full-text ranking is off in this browser; matches are plain substring hits."));
  return out;
}

function qs(o) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return "#/browse" + (s ? "?" + s : "");
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function viewCard(uid) {
  const e = ix.get(uid);
  if (!e) { setTitle("Not found"); return [h("p", { class: "empty" }, "That record is not in this index. It may have been renamed since.")]; }
  const c = card(ix, uid);
  const label = e.kind === "radar" ? radarLabel(e) : KIND_LABEL[e.kind];
  setTitle(label);
  const out = [h("div", { class: "kicker" }, label, e.sfid ? h("span", { class: "tag" }, e.sfid) : null),
    h("h2", { class: "headline" }, e.title)];
  const lines = c.head.filter(Boolean);
  if (e.kind !== "document" && lines.length) out.push(h("div", { class: "head-lines" }, ...lines.map((l) => h("p", {}, l))));
  if (e.kind === "document") {
    out.push(h("p", { class: "note" }, lines[0] || ""));
    const joined = c.sections.find((s) => s.title === "Joined to");
    if (joined) out.push(section("Joined to", joined.items, { cap: 6 }));
    const body = ix.body(uid).replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/^\s*#\s+.*\n/, "");
    out.push(h("div", { class: "card" }, mdNode(body, e.path)));
    for (const s of c.sections) if (s.title !== "Joined to") out.push(section(s.title, s.items, { folded: true }));
    return out;
  }
  for (const s of c.sections) out.push(section(s.title, s.items, { folded: s.folded }));
  return out;
}

async function viewSettings() {
  setTitle("Data");
  const s = await store.settings();
  const hasToken = Boolean(await store.loadToken());
  const out = [];
  const msg = h("div");
  if (ix) {
    const st = crmState(ix.meta);
    const counts = JSON.parse(ix.meta.counts || "{}");
    out.push(h("div", { class: "card" }, h("h2", {}, "This index"), h("dl", { class: "kv" },
      h("dt", {}, "Built"), h("dd", {}, `${st.built} from ${ix.meta.git_head || "?"}`),
      h("dt", {}, "CRM as at"), h("dd", {}, st.when, st.complete ? "" : " · incomplete sync"),
      h("dt", {}, "Radar as at"), h("dd", {}, ix.meta.radar_as_at || "?"),
      h("dt", {}, "Diary read"), h("dd", {}, diaryCheck() ? `${stamp(diaryCheck().read_at)} (DiaryCheck)` : "not in this index"),
      h("dt", {}, "Records"), h("dd", {}, Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")),
      h("dt", {}, "From"), h("dd", {}, info ? `${info.source}: ${info.detail}` : "?"),
      h("dt", {}, "Fetched"), h("dd", {}, info ? new Date(info.fetched_at).toLocaleString("en-GB") : "?"),
      h("dt", {}, "Size"), h("dd", {}, info ? `${(info.size / 1e6).toFixed(1)} MB` : "?"),
      h("dt", {}, "Search"), h("dd", {}, ix.fts ? "full text (FTS5)" : "substring (no FTS5 in this browser)"))));
  } else {
    out.push(h("div", { class: "card" }, h("h2", {}, "Welcome"), h("p", { class: "note" },
      "The Captain's Log needs a copy of the vault index on this device. Download it from GitHub with a read-only token, or open a vault.db.gz you have saved to Files.")));
  }

  const busy = (b) => out.forEach((n) => n.querySelectorAll && n.querySelectorAll("button").forEach((x) => (x.disabled = b)));
  async function load(fn) {
    msg.replaceChildren(h("p", { class: "note" }, "Downloading…"));
    busy(true);
    try {
      const got = await fn((n, total) => msg.replaceChildren(h("p", { class: "note" }, `Downloading… ${(n / 1e6).toFixed(1)}${total ? " of " + (total / 1e6).toFixed(1) : ""} MB`)));
      if (!got) throw new Error("No index found at that source.");
      const next = new Ix(got.bytes);
      await store.keep(got);
      if (ix) ix.close();
      ix = next;
      info = await store.keptInfo();
      paintState();
      msg.replaceChildren(h("div", { class: "ok" }, `Loaded: CRM as at ${crmState(ix.meta).when}, built ${crmState(ix.meta).built}.`));
      setTimeout(route, 900);
    } catch (e) {
      msg.replaceChildren(h("div", { class: "err" }, e.message || String(e)));
    } finally {
      busy(false);
    }
  }

  const field = (v) => h("input", { type: "text", value: v, autocapitalize: "off", autocomplete: "off", spellcheck: "false" });
  const owner = field(s.owner), repo = field(s.repo), branch = field(s.branch), path = field(s.path);
  const token = h("input", { type: "password", placeholder: hasToken ? "Saved on this device (enter a new one to replace it)" : "github_pat_…", autocomplete: "off" });
  const fromGitHub = async (onProgress) => {
    const conf = { owner: owner.value.trim(), repo: repo.value.trim(), branch: branch.value.trim(), path: path.value.trim() };
    await store.saveSettings(conf);
    if (token.value.trim()) await store.saveToken(token.value.trim());
    const tk = await store.loadToken();
    if (!tk) throw new Error("Enter a GitHub token first.");
    return store.fromGitHub(conf, tk, onProgress);
  };
  const file = h("input", { type: "file", accept: ".db,.gz,application/gzip,application/octet-stream", hidden: true,
    onchange: () => file.files[0] && load(() => store.fromFile(file.files[0])) });

  // One tap: fetch again from wherever this copy came from
  if (info && info.source !== "a file") {
    out.push(h("div", { class: "card" }, h("h2", {}, "Refresh"),
      h("p", { class: "note" }, `Fetch the latest index from ${info.source === "GitHub" ? "GitHub" : "this site"}. The app works offline between refreshes.`),
      h("button", { class: "btn", onclick: () => load((p) => (info.source === "GitHub" ? fromGitHub(p) : store.fromSite())) }, "Refresh now")));
  }

  out.push(h("div", { class: "card form" }, h("h2", {}, "From GitHub"),
    h("p", { class: "note" }, "Reads vault.db.gz from a GitHub repository. Use a fine-grained token with read-only Contents on that repository only; it is kept encrypted on this device and sent only to api.github.com."),
    h("label", {}, "Owner"), owner, h("label", {}, "Repository"), repo, h("label", {}, "Branch"), branch, h("label", {}, "File"), path,
    h("label", {}, "Token"), token,
    h("button", { class: "btn", onclick: () => load((p) => fromGitHub(p)) }, "Download"),
    hasToken ? h("button", { class: "btn ghost", onclick: async () => { await store.saveToken(null); route(); } }, "Forget the token") : null));

  out.push(h("div", { class: "card form" }, h("h2", {}, "Open a file"),
    h("p", { class: "note" }, "Pick a vault.db or vault.db.gz from Files, iCloud Drive or OneDrive. Nothing leaves the device."),
    file, h("button", { class: "btn", onclick: () => file.click() }, "Choose file"),
    h("button", { class: "btn ghost", onclick: () => load(() => store.fromSite()) }, "Load from this site")));

  out.push(msg);

  const theme = localStorageGet("theme") || "auto";
  out.push(h("div", { class: "card" }, h("h2", {}, "Appearance"), h("div", { class: "chips" },
    ...["auto", "light", "dark"].map((t) => h("button", { class: "chip" + (theme === t ? " on" : ""), onclick: () => { setTheme(t); route(); } },
      t === "auto" ? "Follow the device" : t[0].toUpperCase() + t.slice(1))))));
  out.push(h("p", { class: "note" }, "Read-only: nothing here writes to Salesforce or the vault. ",
    h("a", { href: "#", onclick: async (ev) => { ev.preventDefault(); if (confirm("Remove the index and token from this device?")) { await store.del("db"); await store.del("dbInfo"); await store.saveToken(null); location.reload(); } } }, "Remove everything from this device")));
  return out;
}

// ---------------------------------------------------------------------------
// Theme, state strip, routing
// ---------------------------------------------------------------------------
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function setTheme(t) {
  try { if (t === "auto") localStorage.removeItem("theme"); else localStorage.setItem("theme", t); } catch { /* private mode */ }
  if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
}

function paintState() {
  const el = $("state");
  if (!ix) { el.className = "state warn"; el.textContent = "No index on this device yet."; return; }
  const st = crmState(ix.meta);
  el.className = "state" + (st.warn ? " warn" : "");
  el.replaceChildren(...[
    h("span", {}, "CRM as at ", h("b", {}, st.when)),
    st.age ? h("span", {}, h("b", {}, st.age)) : null,
    h("span", {}, st.complete ? "complete sync" : h("b", {}, "incomplete sync")),
    h("span", { class: "sep" }, "·"),
    h("span", {}, "index ", st.built)].filter(Boolean));
}

const scrolls = new Map();
let current = "";
function go(hash, replace) {
  if (replace) { history.replaceState(null, "", hash); route(); } else location.hash = hash;
}

async function route() {
  scrolls.set(current, window.scrollY);
  const hash = location.hash || "#/today";
  current = hash;
  const [path, query] = hash.slice(1).split("?");
  const params = new URLSearchParams(query || "");
  const parts = path.split("/").filter(Boolean);
  const tab = parts[0] || "today";
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === (tab === "card" || tab === "workup" ? "" : tab)));
  $("back").hidden = ["today", "logistics", "browse", "settings"].includes(tab);
  let nodes;
  try {
    if (!ix && tab !== "settings") { go("#/settings", true); return; }
    if (tab === "today") nodes = viewToday(params);
    else if (tab === "logistics") nodes = viewLogistics();
    else if (tab === "browse") nodes = viewBrowse(params);
    else if (tab === "card") nodes = viewCard(decodeURIComponent(parts.slice(1).join("/")));
    else if (tab === "workup") nodes = viewWorkup(parts[1], parts[2]);
    else if (tab === "settings") nodes = await viewSettings();
    else nodes = [h("p", { class: "empty" }, "Unknown page.")];
  } catch (e) {
    console.error(e);
    nodes = [h("div", { class: "err" }, "Something went wrong drawing this page: " + (e.message || e))];
  }
  const focusSearch = tab === "browse" && document.activeElement && document.activeElement.type === "search";
  const caret = focusSearch ? document.activeElement.selectionStart : null;
  view.replaceChildren(...nodes);
  if (focusSearch) { const i = view.querySelector("input[type=search]"); if (i) { i.focus(); i.setSelectionRange(caret, caret); } }
  window.scrollTo(0, scrolls.get(hash) || 0);
}

async function boot() {
  setTheme(localStorageGet("theme") || "auto");
  $("back").addEventListener("click", () => history.length > 1 ? history.back() : go("#/today"));
  window.addEventListener("hashchange", route);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  try {
    const missing = new Error("The app's libraries did not load. Connect once so they can be saved for offline use.");
    if (!window.marked || !window.DOMPurify) throw missing;
    await sqlReady().catch(() => { throw missing; });
    let bytes = await store.kept();
    if (!bytes) {
      const site = await store.fromSite();
      if (site) { await store.keep(site); bytes = site.bytes; }
    }
    if (bytes) { ix = new Ix(bytes); info = await store.keptInfo(); }
  } catch (e) {
    console.error(e);
    view.replaceChildren(h("div", { class: "err" }, e.message || String(e)));
    paintState();
    return;
  }
  paintState();
  route();
}

boot();
