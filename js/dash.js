// The five tabs' data (prepare.py, carried in the index as meta "dashboard") and the
// out-of-date rule (Richard, 02/11/2026): every record names its sources, and a record whose
// Outlook, mail or Salesforce facts are older than that source's limit is marked out of date.
// The marker is worked out here, on the device, when the record is looked at, so it is right
// however long ago the data was prepared. A ✓ resting on out-of-date facts is shown grey.

export function dashboard(ix) {
  if (!ix || !ix.meta.dashboard) return null;
  try { return JSON.parse(ix.meta.dashboard); } catch { return null; }
}

/** "2026-11-02T09:40" (UK local, no offset) or a full ISO time -> ms. */
export function when(s) {
  if (!s) return NaN;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T00:00" : s;
  return Date.parse(t);
}

export const stamp = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(s || "");
  return m ? `${m[3]}/${m[2]}${m[4] ? " " + m[4] : ""}` : s || "never";
};

export function ageText(hours) {
  if (!Number.isFinite(hours)) return "never read";
  if (hours < 1) return "under an hour ago";
  if (hours < 36) return `${Math.round(hours)} hours ago`;
  return `${(hours / 24).toFixed(1)} days ago`;
}

/** One source's freshness now: { key, label, at, hours, stale, why }. */
export function fresh(d, key, now = Date.now()) {
  const s = (d && d.sources && d.sources[key]) || {};
  const hours = (now - when(s.confirmed_at)) / 36e5;
  const limit = s.stale_after_hours;
  let stale = false, why = "";
  if (!s.confirmed_at) { stale = limit != null; why = "never read"; }
  else if (limit != null && hours > limit) { stale = true; why = ageText(hours); }
  if (key === "salesforce" && s.complete === false && !stale) why = "incomplete sync";
  return { key, label: s.label || key, via: s.via, at: s.confirmed_at, hours, stale, why };
}

/** The first out-of-date source among a record's sources, or null. */
export function staleOf(d, srcs, now) {
  for (const k of srcs || []) { const f = fresh(d, k, now); if (f.stale) return f; }
  return null;
}

/** A record's mark: "warn" if logistics or prep warns, "ok" if either is ok, else null. */
export function markOf(rec) {
  const s = [rec && rec.logistics && rec.logistics.state, rec && rec.prep && rec.prep.state];
  if (s.includes("warn")) return "warn";
  if (s.includes("ok")) return "ok";
  return null;
}

/** The next n working days from today (today counts if it is a weekday), by this device's clock. */
export function workingDays(today, n) {
  const out = [];
  const d = new Date(today + "T12:00:00");
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  while (out.length < n) {
    if (![0, 6].includes(d.getDay())) out.push(iso(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}
