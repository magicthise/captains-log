// Captain's Log (web): a read-only, offline view of the vault index for iPhone, iPad and
// the Pixel. Five tabs (Richard, 02/11/2026): News and signals, Diary, Meetings, Research and
// Projects, Media and Events. Find and Data sit in the header; Today, Logistics, cards, notes
// and meeting workups are reached from the tabs.
import * as store from "./store.js";
import { sqlReady, Ix, card, item, KIND_LABEL, CLOSED, ddmm, money, crmState } from "./index.js";
import { briefingDates, briefingFor, nowAndNext, hhmm, prep } from "./brief.js";
import { dashboard, fresh, staleOf, markOf, stamp, workingDays } from "./dash.js";
import { mountPage } from "./fullpage.js";

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
  const out = [h("div", { class: "kicker" }, `${shortDay(date)} · ${w.time}`), h("h2", { class: "headline" }, w.title)];
  if (w.where) out.push(h("p", { class: "note" }, w.where));
  out.push(...workupNodes(w));
  const mb = b.docs.find((d) => d.series === "Meeting Brief");
  if (mb) out.push(h("p", {}, h("a", { href: "#/card/" + enc(mb.uid) }, "Open the whole Meeting Brief")));
  return out;
}

/** A workup's parts as cards, TL;DR, Watch out and starters first. */
function workupNodes(w) {
  const order = ["tldr", "watch", "starters"];
  const ps = [...w.parts].sort((a, b2) => (order.indexOf(a.kind) + 1 || 9) - (order.indexOf(b2.kind) + 1 || 9));
  const out = [];
  if (w.intro.length) out.push(h("div", { class: "card" }, mdNode(w.intro)));
  for (const p of ps) {
    const body = h("div", { class: "card part " + p.kind }, h("h2", {}, p.label));
    if (p.lead) body.append(mdNode(p.lead));
    if (p.tokens.length) body.append(mdNode(p.tokens));
    out.push(body);
  }
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

/** The boxes at the top of a screen, each a filter (Richard, 02/11/2026): tap one to show only
 *  what it counts, tap it again for everything. The filter lives in the address (?f=), so the
 *  breadcrumbs and Back keep it. */
function filterTiles(base, active, tiles, cls = "") {
  return h("div", { class: "lg-tiles " + cls }, tiles.map(([key, n, label, tone]) => {
    const on = Boolean(key) && active === key;
    return h("a", { class: "lg-tile" + (n ? tone : "") + (on ? " on" : ""), href: on || !key ? base : `${base}?f=${key}`,
      "aria-pressed": on ? "true" : "false" }, h("b", {}, n), h("span", {}, label));
  }));
}

function filterLine(base, label) {
  return h("div", { class: "filt" }, `Showing ${label} only · `, h("a", { href: base }, "show everything"));
}

const LG_FILTERS = { person: "in person", problems: "problems", check: "things to check", settled: "settled points" };

function viewLogistics(params) {
  setTitle("Logistics");
  const f = LG_FILTERS[params && params.get("f")] ? params.get("f") : null;
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
  out.push(filterTiles("#/logistics", f, [[null, ahead.length, "ahead", ""], ["person", inPerson.length, "in person", ""],
    ["problems", st.problems.length, "problems", " red"], ["check", st.checks.length, "to check", " amber"], ["settled", st.ruled.length, "settled", ""]]));
  if (f) out.push(filterLine("#/logistics", LG_FILTERS[f]));

  const needs = [...(f === "check" ? [] : st.problems), ...(f === "problems" ? [] : st.checks)].sort((a, b) => (a.n || 999) - (b.n || 999));
  if (needs.length && f !== "person" && f !== "settled") {
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
  const keep = {
    person: (e) => e.where && e.where.mode === "in-person" && e.attending !== false,
    problems: (e) => (byEv.get(e.key) || []).some((c) => c.sev === "red"),
    check: (e) => (byEv.get(e.key) || []).some((c) => c.sev === "amber"),
    settled: (e) => ruledEv.has(e.key),
  }[f];
  for (let d = today; d <= end; d = addDays(d, 1)) {
    const des = dc.events.filter((e) => e.date === d).sort((a, b) => (a.start || "").localeCompare(b.start || "") || a.subject.localeCompare(b.subject));
    if (keep) {                                  // a filter: only the matching entries, each in full
      const hits = des.filter((e) => e.cls !== "banner" && !st.past(e) && keep(e));
      if (hits.length) out.push(h("div", { class: "sec lg-day" }, h("h2", {}, dayHead(d), d === today ? h("span", { class: "count" }, "today") : null),
        hits.map((e) => entryCard(e, byEv.get(e.key) || [], ruledEv.get(e.key) || []))));
      continue;
    }
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

// ---------------------------------------------------------------------------
// The five tabs (Richard, 02/11/2026): News and signals, Diary, Meetings, Research and
// Projects, Media and Events. Their data is prepare.py's (meta "dashboard"); people, places
// and problems are DiaryCheck's (meta "diarycheck"), joined on the entry key. Every record
// that rests on Outlook, mail or Salesforce carries an out-of-date marker once its source is
// older than that source's limit, worked out on this device when the page is drawn.
// ---------------------------------------------------------------------------
const MARK = { ok: "✓", warn: "⚠" };
const STANCE = { for: "ok", against: "red", qualified: "amber", watch: "" };
const TONE = { green: "ok", amber: "amber", red: "red", blue: "blue" };

function noDashboard() {
  return [h("p", { class: "empty" }, "This index has no prepared data for the five tabs yet. Refresh it from Data once the Mac or the cloud has published a new one.")];
}

/** ⚠ or ✓ for a diary entry. A ✓ resting on out-of-date facts is grey, never green. */
function markEl(rec, d) {
  const m = markOf(rec);
  if (!m) return null;
  const old = m === "ok" && staleOf(d, rec.src);
  return h("span", { class: `mk ${m}${old ? " old" : ""}`, title: m === "warn" ? "Needs attention" : old ? "Ticked from out-of-date facts" : "In hand" }, MARK[m]);
}

/** The out-of-date marker beside a record: ⏱ out of date · Outlook 02/11 09:40. */
function oodEl(d, srcs) {
  const f = staleOf(d, srcs);
  return f ? h("div", {}, h("span", { class: "ood" }, `⏱ out of date · ${f.label} ${stamp(f.at)}`)) : null;
}

/** A tab's first lines: when each of its sources was last read, and a banner for any out of date. */
function sourcesLine(d, keys, extra) {
  const fs = keys.map((k) => fresh(d, k));
  const out = [h("p", { class: "note srcs" }, ...fs.map((f, i) => [i ? " · " : "", `${f.label} ${stamp(f.at)}`]),
    `${fs.length ? " · " : ""}prepared ${stamp(d.prepared_at)}`)];
  const old = fs.filter((f) => f.stale);
  if (old.length) out.push(h("div", { class: "banner" }, h("b", {}, "⏱ Out of date. "),
    old.map((f) => `${f.label} was last read ${stamp(f.at)}, ${f.why}.`).join(" "), extra ? " " + extra : ""));
  return out;
}

/** prepare.py's entries joined to DiaryCheck's, one per key, in time order. */
function joined(d) {
  const dc = diaryCheck();
  if (!dc) return [];
  const byKey = new Map(dc.events.map((e) => [e.key, e]));
  const seen = new Set();
  return d.diary.entries.filter((r) => byKey.has(r.key) && !seen.has(r.key) && seen.add(r.key))
    .map((r) => ({ r, e: byKey.get(r.key) }))
    .sort((a, b) => a.e.date.localeCompare(b.e.date) || (a.e.start || "").localeCompare(b.e.start || ""));
}

function whereShort(e) {
  const w = e.where || {};
  if (w.mode === "in-person") return w.place_name || e.location || "In person";
  if (w.mode === "hybrid") return `Teams${w.room ? " · " + w.room + " booked" : ""}`;
  if (w.mode === "teams") return "Teams";
  if (w.mode === "phone") return "Call";
  return e.location || "";
}

function reasonsOf(r) {
  const warn = [...(r.logistics && r.logistics.state === "warn" ? r.logistics.reasons : []),
    ...(r.prep && r.prep.state === "warn" ? r.prep.reasons : [])];
  return { warn, ok: warn.length ? [] : [r.prep && r.prep.state === "ok" ? r.prep.reasons[0] : null].filter(Boolean) };
}

function entryRow(x, d, past) {
  const { r, e } = x;
  const rs = reasonsOf(r);
  return h("li", {}, h("a", { class: "item" + (past ? " past" : ""), href: "#/meeting/" + enc(r.key) },
    h("div", { class: "time" }, e.all_day ? "all day" : e.start || "—", e.end ? h("div", { class: "n" }, e.end) : null),
    h("div", { class: "main" }, h("div", { class: "t" }, e.subject),
      whereShort(e) ? h("div", { class: "s" }, whereShort(e)) : null,
      rs.warn.map((t) => h("div", { class: "n warn-t" }, "⚠ " + t)),
      rs.ok.map((t) => h("div", { class: "n" }, t)),
      past ? null : oodEl(d, r.src)),
    h("div", { class: "side" }, markEl(r, d))));
}

// ---------------------------------------------------------------------------
// Quick wins (Richard, 03/11/2026: "I would love to have the quick wins part in the app"):
// the Meeting Dashboard's jobs of 10 minutes or less, from Sales/state/app/immediate.json
// (meta "immediate"), written by every dashboard build. A tick is kept on this device only;
// it closes nothing in Salesforce or Outlook.
// ---------------------------------------------------------------------------
function todayJobs() {
  try { return ix && ix.meta.immediate ? JSON.parse(ix.meta.immediate) : null; } catch { return null; }
}
const quickOf = (t) => ((t && t.queue) || []).filter((x) => x.mins && x.mins <= 10);
function ticksOf(day) { try { return JSON.parse(localStorage.getItem("cl.ticks." + day) || "{}"); } catch { return {}; } }
function saveTicks(day, t) { try { localStorage.setItem("cl.ticks." + day, JSON.stringify(t)); } catch { /* private mode: this visit only */ } }

async function copyText(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* refused: the label says so */ }
  const was = btn.textContent;
  btn.textContent = ok ? "Copied: paste it to Claude" : `Copy this: ${text}`;
  setTimeout(() => { btn.textContent = was; }, 2200);
}

function quickWins() {
  const t = todayJobs();
  const items = quickOf(t);
  if (!items.length) return null;
  const box = h("div", { class: "sec qw" });
  let open = false;
  const draw = () => {
    const ticks = ticksOf(t.day);
    const sorted = [...items].sort((a, b) => (!!ticks[a.id] - !!ticks[b.id]));
    const left = sorted.filter((x) => !ticks[x.id]);
    const mins = left.reduce((s, x) => s + x.mins, 0);
    const list = h("ul", { class: "items" });
    for (const x of open ? sorted : sorted.slice(0, 5)) {
      const done = !!ticks[x.id];
      const tick = h("button", { class: "qbox", "aria-pressed": String(done), "aria-label": (done ? "Mark not done: " : "Mark done: ") + x.what,
        onclick: () => { const tk = ticksOf(t.day); if (tk[x.id]) delete tk[x.id]; else tk[x.id] = new Date().toISOString(); saveTicks(t.day, tk); draw(); } }, "✓");
      list.append(h("li", { class: done ? "done" : "" }, h("div", { class: "item" }, tick,
        h("div", { class: "main" }, h("div", { class: "t" }, x.what), x.why ? h("div", { class: "s" }, x.why) : null,
          done ? null : (x.links || []).map(([label, href]) => h("a", { class: "qlink", href,
            target: /^https?:/.test(href) ? "_blank" : null, rel: /^https?:/.test(href) ? "noopener noreferrer" : null }, label + " ›")),
          done ? null : (x.answers || []).length ? h("div", { class: "qans" }, x.answers.map((a) =>
            h("button", { class: "chip", onclick: (e) => copyText(a, e.currentTarget) }, `Copy “${a}”`))) : null),
        h("div", { class: "side" }, h("div", {}, h("span", { class: "pill kind" }, `${x.mins} min`)),
          h("div", {}, h("span", { class: "pill " + (done ? "" : x.tone === "red" ? "red" : "amber") }, x.due))))));
    }
    const more = !open && sorted.length > 5 ? h("button", { class: "more", onclick: () => { open = true; draw(); } }, `Show ${sorted.length - 5} more`) : null;
    const old = t.day !== todayISO();
    box.replaceChildren(
      h("h2", {}, "Quick wins ", h("span", { class: "count" }, left.length ? `${left.length} left · about ${mins} min` : "all done")),
      old ? h("div", { class: "banner" }, `⏱ These are the quick wins from ${shortDay(t.day)}. The next StartOfDay or EndOfDay brings today's.`)
        : h("p", { class: "note" }, "Each takes 10 minutes or less. Clear a few in one sitting. Ticks stay on this phone."),
      h("div", { class: "card" }, list, more));
  };
  draw();
  return box;
}

/** A one-line pointer to the quick wins, for the News tab. */
function quickWinsPointer() {
  const t = todayJobs();
  const items = quickOf(t);
  if (!items.length || t.day !== todayISO()) return null;
  const ticks = ticksOf(t.day);
  const left = items.filter((x) => !ticks[x.id]);
  return h("a", { class: "card lg-pointer", href: "#/diary" }, h("div", { class: "kicker" }, "Quick wins"),
    h("div", { class: "t" }, left.length ? `${left.length} left, about ${left.reduce((s, x) => s + x.mins, 0)} min in all ›` : "All done for today ✓"));
}

function viewDiary(params) {
  setTitle("Diary");
  const d = dashboard(ix), dc = diaryCheck();
  if (!d || !dc) return noDashboard();
  const f = ["warn", "ok"].includes(params && params.get("f")) ? params.get("f") : null;
  const pass = (x) => !f || markOf(x.r) === f;
  const st = diaryNow(dc);
  const xs = joined(d);
  const to = (dc.window || {}).to;
  const out = sourcesLine(d, ["outlook"], "Anything added in Outlook since then is not shown; StartOfDay and EndOfDay re-read it.");
  if (!f) out.push(quickWins());
  const ahead = xs.filter((x) => x.e.cls !== "banner" && x.e.attending !== false && !st.past(x.e));
  out.push(filterTiles("#/diary", f, [[null, ahead.length, "ahead", ""], ["warn", ahead.filter((x) => markOf(x.r) === "warn").length, "⚠ to sort", " amber"],
    ["ok", ahead.filter((x) => markOf(x.r) === "ok").length, "✓ in hand", ""]], "three"));
  if (f) out.push(filterLine("#/diary", f === "warn" ? "what needs sorting" : "what is in hand"));

  out.push(h("h2", { class: "tabh" }, "Next 3 days"));
  for (const day of workingDays(st.today, 3)) {
    const des = xs.filter((x) => x.e.date === day);
    const banners = [...new Set(des.filter((x) => x.e.cls === "banner").map((x) => x.e.subject))];
    const rest = des.filter((x) => x.e.cls !== "banner" && x.e.attending !== false && pass(x) && !(f && st.past(x.e)));
    const sec = h("div", { class: "sec" }, h("h2", {}, dayHead(day), day === st.today ? h("span", { class: "count" }, "today") : null),
      banners.length ? h("p", { class: "note" }, banners.join(" · ")) : null);
    if (to && day > to) sec.append(h("div", { class: "lg-mini" }, "Not read from Outlook yet."));
    else if (!rest.length) sec.append(h("div", { class: "lg-mini" }, f ? "Nothing that matches." : "Nothing in the diary."));
    else sec.append(h("div", { class: "card" }, h("ul", { class: "items timeline" }, rest.map((x) => entryRow(x, d, st.past(x.e))))));
    out.push(sec);
  }

  out.push(h("h2", { class: "tabh" }, "The week"));
  const week = h("div", { class: "card week" });
  for (const day of workingDays(st.today, 7)) {
    const rest = xs.filter((x) => x.e.date === day && !["banner", "travel"].includes(x.e.cls) && x.e.attending !== false && !st.past(x.e) && pass(x));
    const chips = rest.map((x) => {
      const m = markOf(x.r);
      const old = m === "ok" && staleOf(d, x.r.src);
      const label = x.e.subject.split(/\s+/).slice(0, 4).join(" ");
      return h("a", { class: `chip ${m || ""}${old ? " old" : ""}`, href: "#/meeting/" + enc(x.r.key) },
        x.e.start || "all day", m ? " " + MARK[m] : "", " ", label);
    });
    week.append(h("div", { class: "wk-day" }, h("div", { class: "wk-d" }, shortDay(day)),
      h("div", { class: "wk-chips" }, to && day > to ? h("span", { class: "lg-mini" }, "not read yet") : chips.length ? chips : h("span", { class: "lg-mini" }, "nothing"))));
  }
  out.push(week, h("p", { class: "note" }, "⚠ needs sorting · ✓ logistics and prep in hand · grey ✓ ticked from out-of-date facts. ",
    h("a", { href: "#/today" }, "Today's full briefing ›")));
  return out;
}

const RESP_MARK = { accepted: "✓", organiser: "✓", tentative: "?", declined: "✗" };

function meetingBlock(x, d, st) {
  const { r, e } = x;
  const b = r.brief || {};
  const ev = r.event ? (d.events || []).find((v) => v.uid === r.event) : null;
  const ppl = (e.people || []).filter((p) => p.side !== "self");
  const acc = ppl.filter((p) => ["accepted", "organiser"].includes(p.response)).length;
  const past = st.past(e);
  const rs = reasonsOf(r);
  const row = (label, ...kids) => h("div", { class: "mt-row" }, h("b", {}, label), ...kids);
  const about = b.tldr || (ev && (ev.headline || ev.brief)) || null;
  return h("div", { class: "card mt" + (past ? " past" : "") },
    h("div", { class: "mt-head" }, h("div", { class: "t" }, `${e.all_day ? "All day" : `${e.start || ""}–${e.end || ""}`} · ${e.subject}`), markEl(r, d)),
    h("div", { class: "lg-where" }, whereLine(e)),
    e.logistics ? h("div", { class: "lg-how" }, e.logistics) : null,
    row("About", about || h("span", { class: "faint" }, b.path ? "Brief ready, with no summary line." : r.prep && r.prep.state === "warn" ? "No brief yet." : "No brief: internal or personal.")),
    ppl.length ? row("Who", ppl.slice(0, 8).flatMap((p, i) => [i ? " · " : "", p.name, " ", h("span", { class: "rm " + (RESP[p.response] || "amber") }, RESP_MARK[p.response] || "…")]),
      ppl.length > 8 ? ` · +${ppl.length - 8}` : null)
      : b.who && b.who.length ? row("Who", b.who.map((p) => p.name).join(" · ")) : null,
    b.want ? row("Aim", b.want) : null,
    row("Organised", ppl.length ? `${acc} of ${ppl.length} accepted.` : "",
      rs.warn.length ? rs.warn.map((t) => h("div", { class: "warn-t" }, "⚠ " + t))
        : (r.logistics && r.logistics.reasons.filter((t) => t !== e.logistics && t !== "Nothing open").map((t) => " " + t))),
    past ? null : oodEl(d, r.src),
    h("a", { class: "btn-link", href: "#/meeting/" + enc(r.key) }, b.path ? "Full brief and links ›" : "Details and links ›"));
}

function viewMeetings() {
  setTitle("Meetings");
  const d = dashboard(ix), dc = diaryCheck();
  if (!d || !dc) return noDashboard();
  const st = diaryNow(dc);
  const xs = joined(d).filter((x) => x.e.cls !== "banner" && x.e.attending !== false
    && (["external", "internal"].includes(x.e.cls) || x.r.event || x.r.brief));
  const to = (dc.window || {}).to;
  const out = sourcesLine(d, ["outlook"], "Who has accepted may have changed since.");
  for (const day of workingDays(st.today, 7)) {
    if (to && day > to) break;
    const ms = xs.filter((x) => x.e.date === day);
    if (!ms.length) continue;
    out.push(h("div", { class: "sec" }, h("h2", {}, dayHead(day), day === st.today ? h("span", { class: "count" }, "today") : null),
      ms.map((x) => meetingBlock(x, d, st))));
  }
  if (out.length <= 2) out.push(h("p", { class: "empty" }, "No meetings in the diary read."));
  out.push(h("p", { class: "note" }, h("a", { href: "#/logistics" }, "DiaryCheck's full logistics and numbered problems ›")));
  return out;
}

/** The records a brief names, at the top of its drill-down: Ids, quote numbers, files, the event. */
function linkedItems(r) {
  const uids = new Set();
  const l = (r.brief && r.brief.links) || {};
  for (const id of l.sfids || []) { const u = ix.bySfid(id); if (u) uids.add(u); }
  for (const q of l.quotes || []) { const u = ix.quoteByNumber(q); if (u) uids.add(u); }
  for (const p of l.paths || []) { const u = ix.byPath(p); if (u) uids.add(u); }
  if (r.event && ix.ent.has(r.event)) uids.add(r.event);
  const rank = { account: 0, opportunity: 1, quote: 2, event: 3, project: 4, radar: 5, task: 6, document: 7 };
  return [...uids].map((u) => item(ix, u)).sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
}

// ---------------------------------------------------------------------------
// Full pages (Richard, 03/11/2026: "the full monty in both"): the meeting briefs, event
// briefs and project pages exactly as the Meeting Dashboard renders them, with the model
// chain, the pressure lens, lean in / lean out and the rest. They come from
// Sales/state/app/pages.json, carried in the index as meta "pages", and are shown by
// fullpage.js, the same file the dashboard uses.
// ---------------------------------------------------------------------------
let pagesCache;
function pagesOf() {
  if (pagesCache !== undefined && pagesCache.ix === ix) return pagesCache.doc;
  let doc = null;
  try { doc = ix && ix.meta.pages ? JSON.parse(ix.meta.pages) : null; } catch { doc = null; }
  pagesCache = { ix, doc };
  return doc;
}
const PURIFY = { ADD_TAGS: ["style"], ADD_ATTR: ["target"], FORCE_BODY: true };
const asText = (a) => a.replaceWith(Object.assign(document.createElement("span"), { textContent: a.textContent }));

/** A page's links: a vault file opens as its record here; a link to another site opens
 *  outside; anything else (the Mac's own paths) stays as text. */
function pageLink(a) {
  const href = a.getAttribute("href") || "";
  if (href.startsWith("#vault=")) {
    const uid = ix.byPath(decodeURIComponent(href.slice(7)));
    if (uid) a.setAttribute("href", "#/card/" + enc(uid)); else asText(a);
  } else if (/^https?:/i.test(href)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  else if (href !== "#" && !href.startsWith("#/")) asText(a);
}

/** Where a project page's cross-link to another project or event goes. */
function gotoRoute(pid) {
  const doc = pagesOf();
  if (!doc) return null;
  if (doc.index.events["event:" + pid]) return "#/page/" + doc.index.events["event:" + pid];
  if (doc.index.projects["project:" + pid]) return "#/project/" + enc("project:" + pid);
  return null;
}

function pageNode(key, sub) {
  const doc = pagesOf();
  const p = doc && doc.pages[key];
  if (!p) return h("p", { class: "empty" }, "That page is not in this index yet. The next Meeting Dashboard build adds it.");
  const host = h("div", { class: "fullhost" });
  mountPage(host, { css: doc.css, html: window.DOMPurify.sanitize(p.html, PURIFY), sub,
    onGoto: (pid) => { const r = gotoRoute(pid); if (r) location.hash = r; }, onLink: pageLink });
  return host;
}

function builtLine() {
  const doc = pagesOf();
  return doc ? h("p", { class: "note" }, `As the Meeting Dashboard built it, ${stamp(doc.built_at)}.`) : null;
}

function viewPage(key, params) {
  const doc = pagesOf();
  setTitle((doc && doc.pages[key] && doc.pages[key].label) || "Page");
  return [builtLine(), pageNode(key, params.get("sub"))];
}

function viewProjectPage(uid) {
  const doc = pagesOf();
  const d = dashboard(ix);
  const p = d && d.projects.find((x) => x.uid === uid);
  setTitle(p ? p.title : "Project");
  const x = doc && doc.index.projects[uid];
  const all = h("p", {}, h("a", { class: "btn-link", href: "#/card/" + enc(uid) }, "Everything joined to it ›"));
  if (!x) return [h("p", { class: "empty" }, "No project page in this index yet."), all];
  return [builtLine(), pageNode(x.page),
    ...(x.extra || []).map(([title, key]) => h("div", { class: "pagesec" }, h("h2", { class: "tabh" }, title), pageNode(key))), all];
}

function viewMeeting(key) {
  setTitle("Meeting");
  const d = dashboard(ix), dc = diaryCheck();
  const r = d && d.diary.entries.find((x) => x.key === key);
  const e = dc && dc.events.find((x) => x.key === key);
  if (!r || !e) return [h("p", { class: "empty" }, "That entry is not in the diary read.")];
  const out = [h("div", { class: "kicker" }, `${shortDay(e.date)} · ${e.all_day ? "all day" : `${e.start || ""}–${e.end || ""}`}`),
    h("div", { class: "mt-head" }, h("h2", { class: "headline" }, e.subject), markEl(r, d)), oodEl(d, r.src)];
  const state = (label, s) => s && s.state !== "none" ? h("div", { class: "mt-row" }, h("b", {}, label),
    h("span", { class: "mk sm " + (s.state === "warn" ? "warn" : s.state === "ok" ? "ok" : "") }, s.state === "warn" ? "⚠" : s.state === "ok" ? "✓" : "–"), " ", s.reasons.join(" · ")) : null;
  out.push(h("div", { class: "card" }, state("Logistics", r.logistics), state("Prep", r.prep)));
  const linked = linkedItems(r);
  if (linked.length) out.push(section("Linked records", linked, { cap: 12 }));

  const full = pagesOf() && pagesOf().index.diary[key];
  if (full) {
    out.push(h("h2", { class: "tabh" }, "The full brief"), pageNode(full[0], full[1]));
    const doc = r.brief && ix.byPath(r.brief.path);
    if (doc) out.push(h("p", {}, h("a", { href: "#/card/" + enc(doc) }, "Open the whole Meeting Brief ›")));
  } else if (r.brief) {
    const b = briefingFor(ix, e.date);
    const w = b.workups.find((x) => x.time === r.brief.time && x.title === r.brief.title) || b.workups.find((x) => x.time === r.brief.time);
    out.push(h("h2", { class: "tabh" }, "The brief"));
    if (w) out.push(...workupNodes(w));
    else out.push(h("p", { class: "note" }, `In ${r.brief.path}, ${r.brief.time} — ${r.brief.title}.`));
    const doc = ix.byPath(r.brief.path);
    if (doc) out.push(h("p", {}, h("a", { href: "#/card/" + enc(doc) }, "Open the whole Meeting Brief ›")));
  } else {
    const ev = r.event ? (d.events || []).find((v) => v.uid === r.event) : null;
    if (ev && ev.tab && ix.byPath(ev.tab)) out.push(h("p", {}, h("a", { class: "btn-link", href: "#/card/" + enc(ix.byPath(ev.tab)) }, `The event brief: ${ev.short || ev.title} ›`)));
    else out.push(h("p", { class: "note" }, r.prep && r.prep.state === "warn"
      ? "No brief yet. MeetingBrief writes one for the day; the cloud Prepare run will write them ahead."
      : "No brief: an internal or personal entry."));
  }

  out.push(h("h2", { class: "tabh" }, "Logistics and people"));
  const keyOf = (c) => c.event.split(" × ");
  out.push(entryCard(e, dc.open.filter((c) => keyOf(c).includes(key)), dc.ruled.filter((c) => keyOf(c).includes(key))));
  return out;
}

function viewNews() {
  setTitle("News & signals");
  const d = dashboard(ix);
  if (!d) return noDashboard();
  const n = d.news, s = d.signals;
  const out = sourcesLine(d, ["newsdesk", "mail"], "Signals come from the Start of Day's mail sweep.");
  out.push(quickWinsPointer());
  if (n) {
    out.push(h("div", { class: "sec" }, h("h2", {}, n.title),
      n.bottom_line ? h("div", { class: "card" }, h("p", {}, h("b", {}, "Bottom line. "), n.bottom_line)) : null));
    for (const it of n.items) {
      const st = (it.stance || "").toLowerCase();
      out.push(h("div", { class: "card news" },
        h("div", { class: "t" }, `${it.n}. ${it.title}`),
        h("div", { class: "pills" }, it.stance ? h("span", { class: "pill " + (STANCE[st] ?? "") }, it.stance) : null,
          it.effect ? h("span", { class: "pill kind" }, it.effect) : null, it.issues ? h("span", { class: "pill kind" }, it.issues) : null),
        it.what ? h("p", {}, it.what) : null,
        it.why ? h("p", { class: "note" }, h("b", {}, "Why it matters: "), it.why) : null,
        it.line ? h("div", { class: "quote" }, it.line) : null,
        it.careful ? h("div", { class: "careful" }, h("b", {}, "Careful: "), it.careful) : null,
        it.url ? h("a", { class: "btn-link", href: it.url, target: "_blank", rel: "noopener noreferrer" }, "Source ↗") : null));
    }
    const doc = ix.byPath(n.brief);
    const earlier = (n.earlier || []).map((p) => ix.byPath(p)).filter(Boolean).map((u) => item(ix, u));
    if (doc) out.push(h("p", {}, h("a", { href: "#/card/" + enc(doc) }, "The whole Issues Brief, with external positions ›")));
    if (earlier.length) out.push(section("Earlier briefs", earlier, { folded: true, showKind: false }));
  } else out.push(h("p", { class: "empty" }, "No Issues Brief in the index yet. NewsDesk runs in the cloud at 08:00."));

  if (s) {
    const list = h("ul", { class: "items" }, s.rows.map((x) => h("li", {}, h("div", { class: "item" },
      h("div", { class: "main" }, h("div", { class: "t" }, x.source), h("div", { class: "s" }, x.what),
        x.matches ? h("div", { class: "n" }, "Matches: " + x.matches) : null,
        x.action && x.action !== "—" ? h("div", { class: "n act" }, "→ " + x.action) : null)))));
    const doc = ix.byPath(s.doc);
    out.push(h("div", { class: "sec" }, h("h2", {}, "Incoming signals ", h("span", { class: "count" }, s.window || "")),
      oodEl(d, ["mail"]), h("div", { class: "card" }, list),
      doc ? h("p", { class: "note" }, h("a", { href: "#/card/" + enc(doc) }, `From the Start of Day ${stamp(s.date)} ›`)) : null));
  }
  return out;
}

function nextList(next, today, n = 3) {
  const open = (next || []).filter((a) => !a.status || !/done|met/i.test(a.status)).slice(0, n);
  if (!open.length) return null;
  return h("ul", { class: "nx" }, open.map((a) => h("li", {},
    a.due ? h("span", { class: "pill " + (a.due < today ? "red" : a.due === today ? "amber" : "kind") }, ddmm(a.due).slice(0, 5)) : null,
    " ", a.what, a.who ? h("span", { class: "faint" }, ` · ${a.who}`) : null)));
}

function viewProjects() {
  setTitle("Research & Projects");
  const d = dashboard(ix);
  if (!d) return noDashboard();
  const today = todayISO();
  const out = sourcesLine(d, []);
  const rank = { red: 0, amber: 1, green: 2 };
  const ps = [...d.projects].sort((a, b) => ((rank[(a.health || {}).status] ?? 3) - (rank[(b.health || {}).status] ?? 3)) || a.title.localeCompare(b.title));
  const names = new Map(d.projects.map((p) => [p.uid.split(":")[1], p.title]));
  out.push(h("h2", { class: "tabh" }, "Projects ", h("span", { class: "count" }, ps.length)));
  for (const p of ps) {
    const hs = (p.health || {}).status;
    const dates = (p.dates || []).filter((k) => k.date >= today).slice(0, 2);
    const full = pagesOf() && pagesOf().index.projects[p.uid];
    const href = full ? "#/project/" + enc(p.uid) : "#/card/" + enc(p.uid);
    out.push(h("div", { class: "card pj" },
      p.parent && names.get(p.parent) ? h("div", { class: "kicker" }, names.get(p.parent)) : null,
      h("div", { class: "mt-head" }, h("a", { class: "t", href }, p.title),
        hs ? h("span", { class: "pill " + (TONE[hs] || "") }, hs) : null),
      p.health && p.health.note ? h("p", {}, p.health.note) : p.goal ? h("p", { class: "note" }, p.goal) : null,
      nextList(p.next, today),
      dates.length ? h("ul", { class: "nx" }, dates.map((k) => h("li", {}, h("span", { class: "pill kind" }, ddmm(k.date).slice(0, 5)), " ", k.what))) : null,
      h("a", { class: "btn-link", href }, full ? "Full project page ›" : "Everything joined to it ›")));
  }
  out.push(h("h2", { class: "tabh" }, "Research ", h("span", { class: "count" }, d.research.length)));
  const list = h("ul", { class: "items" });
  for (const r of d.research) {
    const href = r.kind === "folder" ? "#/folder/" + enc(r.path) : ix.byPath(r.path) ? "#/card/" + enc(ix.byPath(r.path)) : null;
    const when = r.date || r.updated;
    list.append(h("li", {}, h(href ? "a" : "div", { class: "item", href },
      h("div", { class: "main" }, h("div", { class: "t" }, r.title),
        r.situation ? h("div", { class: "s clamp" }, r.situation) : null,
        r.kind === "folder" ? h("div", { class: "n" }, `${r.docs} file${r.docs === 1 ? "" : "s"} ›`) : null),
      when ? h("div", { class: "side" }, ddmm(when).slice(0, 5)) : null)));
  }
  out.push(h("div", { class: "card" }, list));
  return out;
}

function viewEvents() {
  setTitle("Media & Events");
  const d = dashboard(ix), dc = diaryCheck();
  if (!d) return noDashboard();
  const today = todayISO();
  const st = dc ? diaryNow(dc) : null;
  const xs = dc ? joined(d) : [];
  const out = sourcesLine(d, ["outlook"]);
  const upcoming = d.events.filter((v) => !v.end || v.end >= today)
    .sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999") || a.title.localeCompare(b.title));
  const past = d.events.filter((v) => v.end && v.end < today).sort((a, b) => b.end.localeCompare(a.end));
  const block = (v) => {
    const days = v.start ? daysBetween(today, v.start) : null;
    const when = v.start ? `${ddmm(v.start).slice(0, 5)}${v.end && v.end !== v.start ? "–" + ddmm(v.end).slice(0, 5) : ""}` : v.when || "date not set";
    const count = days == null ? "" : days > 0 ? ` · in ${days} day${days === 1 ? "" : "s"}` : days === 0 ? " · today" : v.end >= today ? " · under way" : "";
    // The Event Tab's pills are kept current by StartOfDay and EndOfDay; project.json's health
    // note is not, so it shows only where there is no tab.
    const live = v.pills && v.pills.length;
    const hs = live ? null : (v.health || {}).status;
    const ents = xs.filter((x) => x.r.event === v.uid && x.e.cls !== "banner" && !(st && st.past(x.e)));
    const tab = v.tab && ix.byPath(v.tab);
    const page = pagesOf() && pagesOf().index.events[v.uid];
    return h("div", { class: "card ev" },
      h("div", { class: "kicker" }, [v.type, v.our_role].filter(Boolean).join(" · ")),
      h("div", { class: "mt-head" }, h("a", { class: "t", href: "#/card/" + enc(v.uid) }, v.title), hs ? h("span", { class: "pill " + (TONE[hs] || "") }, hs) : null),
      h("div", { class: "s" }, when + count, v.venue ? " · " + v.venue : ""),
      live ? h("div", { class: "pills" }, v.pills.map((p) => h("span", { class: "pill " + (TONE[p.tone] || "") }, p.text))) : null,
      !live && v.health && v.health.note ? h("p", {}, v.health.note) : !live && v.brief ? h("p", { class: "note" }, v.brief) : null,
      ents.length ? h("ul", { class: "items timeline" }, ents.map((x) => entryRow(x, d, false))) : null,
      nextList(v.next, today, 2),
      page ? h("a", { class: "btn-link", href: "#/page/" + page }, "Full event brief ›")
        : tab ? h("a", { class: "btn-link", href: "#/card/" + enc(tab) }, "Full event brief ›") : null,
      v.tab_updated ? h("div", { class: "n faint" }, "Event tab updated " + v.tab_updated) : null);
  };
  out.push(h("h2", { class: "tabh" }, "Events ", h("span", { class: "count" }, upcoming.length)), ...upcoming.map(block));

  const media = xs.filter((x) => x.r.media && !x.r.event && x.e.cls !== "banner" && !(st && st.past(x.e)));
  out.push(h("h2", { class: "tabh" }, "Media"));
  if (media.length) out.push(h("div", { class: "card" }, h("ul", { class: "items timeline" }, media.map((x) => entryRow(x, d, false)))));
  const docs = (d.media || []).map((m) => ({ m, u: ix.byPath(m.path) })).filter((x) => x.u);
  if (docs.length) out.push(section("Panel packs and media notes", docs.map((x) => item(ix, x.u, x.m.situation)), { showKind: false }));
  if (!media.length && !docs.length) out.push(h("p", { class: "note" }, "Nothing in the diary or the vault marked as media."));
  if (past.length) out.push(h("details", { class: "fold" }, h("summary", {}, "Past events ", h("span", { class: "count" }, past.length)), past.map(block)));
  return out;
}

function viewFolder(path) {
  setTitle(path.split("/").pop());
  const docs = [...ix.ent.values()].filter((e) => e.kind === "document" && e.path && e.path.startsWith(path + "/"))
    .map((e) => item(ix, e.uid)).sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.title.localeCompare(b.title));
  return [h("p", { class: "note" }, path), docs.length ? section("Documents", docs, { cap: 60, showKind: false })
    : h("p", { class: "empty" }, "No notes from this folder are in the index (only Markdown is indexed).")];
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

// Breadcrumbs (Richard, 02/11/2026): the recent pages as one line under the header, oldest
// first. Going to a page already on the line cuts the line back to it; it holds the last six,
// and lasts as long as the app is open.
const CRUMBS_MAX = 6;
let crumbs = (() => { try { return JSON.parse(sessionStorage.getItem("crumbs") || "[]"); } catch { return []; } })();
function noteCrumb(hash, title) {
  const path = (x) => x.split("?")[0];
  const i = crumbs.findIndex((c) => c.hash === hash);
  if (i >= 0) crumbs = crumbs.slice(0, i + 1);
  else if (crumbs.length && path(crumbs[crumbs.length - 1].hash) === path(hash)) crumbs[crumbs.length - 1] = { hash, title };  // a filter changed
  else crumbs = [...crumbs, { hash, title }].slice(-CRUMBS_MAX);
  crumbs[crumbs.length - 1].title = title;
  try { sessionStorage.setItem("crumbs", JSON.stringify(crumbs)); } catch { /* private mode */ }
  const el = $("crumbs");
  el.replaceChildren(...crumbs.flatMap((c, j) => [j ? h("span", { class: "sep", "aria-hidden": "true" }, "›") : null,
    j === crumbs.length - 1 ? h("span", { class: "cur", "aria-current": "page" }, c.title || "…") : h("a", { href: c.hash }, c.title || "…")]).filter(Boolean));
  el.hidden = crumbs.length < 2;
  el.scrollLeft = el.scrollWidth;
}

const scrolls = new Map();
let current = "";
function go(hash, replace) {
  if (replace) { history.replaceState(null, "", hash); route(); } else location.hash = hash;
}

async function route() {
  scrolls.set(current, window.scrollY);
  const hash = location.hash || "#/news";
  current = hash;
  const [path, query] = hash.slice(1).split("?");
  const params = new URLSearchParams(query || "");
  const parts = path.split("/").filter(Boolean);
  const tab = parts[0] || "news";
  const lit = { meeting: "meetings", folder: "projects", project: "projects" }[tab] || tab;
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === lit));
  document.querySelectorAll(".bar .hbtn").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
  $("back").hidden = ["news", "diary", "meetings", "projects", "events", "today", "logistics", "browse", "settings"].includes(tab);
  let nodes;
  try {
    if (!ix && tab !== "settings") { go("#/settings", true); return; }
    if (tab === "news") nodes = viewNews();
    else if (tab === "diary") nodes = viewDiary(params);
    else if (tab === "meetings") nodes = viewMeetings();
    else if (tab === "meeting") nodes = viewMeeting(decodeURIComponent(parts.slice(1).join("/")));
    else if (tab === "projects") nodes = viewProjects();
    else if (tab === "events") nodes = viewEvents();
    else if (tab === "folder") nodes = viewFolder(decodeURIComponent(parts.slice(1).join("/")));
    else if (tab === "page") nodes = viewPage(decodeURIComponent(parts.slice(1).join("/")), params);
    else if (tab === "project") nodes = viewProjectPage(decodeURIComponent(parts.slice(1).join("/")));
    else if (tab === "today") nodes = viewToday(params);
    else if (tab === "logistics") nodes = viewLogistics(params);
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
  view.replaceChildren(...nodes.filter((n) => n != null && n !== false));
  const fl = { warn: "to sort", ok: "in hand", check: "to check", person: "in person" }[params.get("f")] || params.get("f");
  noteCrumb(hash, $("title").textContent + (fl ? " · " + fl : ""));
  if (focusSearch) { const i = view.querySelector("input[type=search]"); if (i) { i.focus(); i.setSelectionRange(caret, caret); } }
  window.scrollTo(0, scrolls.get(hash) || 0);
}

async function boot() {
  setTheme(localStorageGet("theme") || "auto");
  $("back").addEventListener("click", () => history.length > 1 ? history.back() : go("#/news"));
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
