// The Captain's Log full pages: meeting briefs, event briefs, project pages, Logistics, the
// Tasks board, OppSynopsis and Sales Cadence, exactly as the builder renders them
// (meetingbrief/build_dashboard.py). The Meeting Dashboard on the Mac and this app show the
// same pages through this one file (Richard, 03/11/2026: "the full monty in both").
//
// Each page sits in its own shadow root, so the builder's styles cannot collide with the
// shell around it. Its colours come through the shell's tokens, so it follows light and dark.
// Meeting briefs get a "Jump to" bar and their TL;DR moved to the top.
//
// No imports and no other exports: the dashboard builder inlines this file into the
// Meeting Dashboard as a classic script, dropping the "export" keywords.

const JUMPS = [
  ["TL;DR", (r) => r.querySelector(".tldr")],
  ["Getting there", (r) => r.querySelector(".travel")],
  ["Who", (r) => byText(r, "b", "Who is in the room")],
  ["In the model", (r) => r.querySelector(".model")],
  ["Position", (r) => byText(r, "b", "Position")],
  ["Pressure lens", (r) => r.querySelector(".icp")],
  ["Starters", (r) => byText(r, "b", "Conversation starters")],
  ["Watch-outs", (r) => byText(r, "b", "Watch-outs")],
  ["Lean in / out", (r) => r.querySelector(".leangrid")],
  ["People and pressures", (r) => r.querySelector(".aidegrid")],
  ["Documents", (r) => byText(r, "h3", "Recent documents")],
  ["Correspondence", (r) => byText(r, "h3", "Recent correspondence")],
];

function byText(root, sel, text) {
  return [...root.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(text)) || null;
}

/** The project timeline's filters: kinds on or off, how many months back and ahead. */
function timelineApply(tl) {
  if (!tl) return;
  const lim = { past: +tl.dataset.past, future: +tl.dataset.future };
  const kinds = new Set([...tl.querySelectorAll(".pj-kind.on")].map((b) => b.dataset.k));
  const n = { past: 0, future: 0 };
  tl.querySelectorAll(".pj-item").forEach((it) => {
    const w = +it.dataset.w, side = it.dataset.side, L = lim[side];
    const ok = (L === 99 || (w > 0 && w <= L)) && kinds.has(it.dataset.k);
    it.hidden = !ok;
    if (ok) n[side]++;
  });
  tl.querySelectorAll(".pj-month").forEach((h) => {
    let x = h.nextElementSibling, any = false;
    while (x && !x.classList.contains("pj-month") && !x.classList.contains("pj-now")) {
      if (x.classList.contains("pj-item") && !x.hidden) { any = true; break; }
      x = x.nextElementSibling;
    }
    h.hidden = !any;
  });
  tl.querySelectorAll("[data-cnt]").forEach((c) => {
    const side = c.dataset.cnt, L = lim[side];
    c.textContent = `${n[side]} shown · ${L === 99 ? "all" : `${L} month${L > 1 ? "s" : ""}`}${side === "past" ? " back" : " ahead"}`;
  });
}

/** Opens every project sub-tab that contains el, outermost first. */
function openProjectTabs(el) {
  let sub = el.closest(".pj-subtab");
  while (sub) {
    const nav = sub.parentElement.querySelector(":scope > .pj-subnav");
    const b = nav && nav.querySelector(`button[data-s="${sub.id}"]`);
    if (b) b.click();
    sub = sub.parentElement.closest(".pj-subtab");
  }
}

/** A meeting brief: the jump bar under its heading, then the TL;DR. */
function arrangeBrief(root) {
  const syn = root.querySelector(".syn");
  if (!syn || syn.dataset.arranged) return;
  syn.dataset.arranged = "1";
  const h3 = syn.querySelector("h3"), tldr = syn.querySelector(".tldr");
  let after = h3;
  const jumps = JUMPS.map(([label, find]) => [label, find(root)]).filter((x) => x[1]);
  if (h3 && jumps.length > 2) {
    const bar = document.createElement("div");
    bar.className = "jump";
    bar.innerHTML = "<span>Jump to</span>";
    for (const [label, el] of jumps) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => el.scrollIntoView({ behavior: "smooth", block: "start" }));
      bar.append(b);
    }
    h3.after(bar);
    after = bar;
  }
  if (after && tldr) { after.after(tldr); tldr.classList.add("top"); }
}

/**
 * Mounts one page into host.
 *   css      the page styles (pages.json "css")
 *   html     the page itself, already sanitised by the caller where it needs to be
 *   sub      a sub-tab to open first, by its label ("Meeting briefs")
 *   onGoto   (id) => void, for a cross-link to another project or event page
 *   onLink   (a) => void, to rewrite each link (the app turns vault links into its own)
 *   scripts  true to run the page's own inline scripts against its shadow root (the Mac only)
 */
export function mountPage(host, { css, html, sub, onGoto, onLink, scripts } = {}) {
  if (host.shadowRoot) return host.shadowRoot;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${css || ""}</style><div class="fp">${html || '<p class="fp-missing">This page is not in the current build.</p>'}</div>`;
  arrangeBrief(root);
  if (onLink) root.querySelectorAll("a[href]").forEach(onLink);
  root.addEventListener("click", (e) => {
    const sb = e.target.closest(".subnav button");
    if (sb) {
      sb.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === sb));
      root.querySelectorAll(".subtab").forEach((x) => x.classList.toggle("on", x.id === sb.dataset.s));
      return;
    }
    const pb = e.target.closest(".pj-subnav button");
    if (pb) {
      const nav = pb.closest(".pj-subnav");
      nav.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === pb));
      [...nav.parentElement.children].filter((t) => t.classList.contains("pj-subtab"))
        .forEach((t) => t.classList.toggle("on", t.id === pb.dataset.s));
      return;
    }
    const go = e.target.closest("[data-goto]");
    if (go) {
      e.preventDefault();
      const local = root.querySelector(`.pj[data-pid="${go.dataset.goto}"]`);
      if (local) { openProjectTabs(local); local.scrollIntoView({ behavior: "smooth", block: "start" }); }
      else if (onGoto) onGoto(go.dataset.goto);
      return;
    }
    const kind = e.target.closest(".pj-kind");
    if (kind) { kind.classList.toggle("on"); timelineApply(kind.closest(".pj-tl")); return; }
    const span = e.target.closest(".pj-exp button");
    if (span) {
      const tl = span.closest(".pj-tl");
      tl.dataset[span.dataset.side] = span.dataset.w;
      span.parentElement.querySelectorAll("button").forEach((y) => y.classList.toggle("on", y === span));
      timelineApply(tl);
      return;
    }
    if (e.target.closest('a[href="#"]')) e.preventDefault();
  });
  root.querySelectorAll(".pj-tl").forEach(timelineApply);
  if (scripts) {
    // A page's own script (the Follow-ups selector) looks things up through "document";
    // here that is the shadow root, which answers getElementById and querySelectorAll.
    for (const s of root.querySelectorAll("script")) {
      try { new Function("document", s.textContent)(root); } catch (err) { console.warn("page script:", err); }
    }
  }
  if (sub) {
    const b = [...root.querySelectorAll(".subnav button")].find((x) => x.textContent.trim() === sub);
    if (b) b.click();
  }
  return root;
}
