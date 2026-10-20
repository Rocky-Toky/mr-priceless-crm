/* Mr Priceless CRM - client performance report PDF.
   Two A4 pages in the brand's black and gold, laid out like the original
   fortnightly report: page 1 is the month so far (revenue, return, the
   10-quote guarantee, pipeline, enquiry-to-job funnel); page 2 is the
   plain-English story, the top ad and the numbers explained. Uses the
   welcome pack's fonts (Bricolage Grotesque headings, Figtree text).
   Draws from a plain data object put together by app.js - nothing here
   reads CRM state. window.MPReportPDF.build(data) -> Promise<Uint8Array>.
   Needs window.PDFLib and window.fontkit loaded first. */
(function(){
"use strict";

const W = 595.28, H = 841.89, M = 40;
const C = {
  bg: "#0b0b0c", panel: "#141416", panel2: "#1c1c20", line: "#2c2a25",
  gold: "#e8c468", gold2: "#c9a13e", gold3: "#8a6a1a", text: "#f4f0e6", soft: "#d9d4c8",
  muted: "#9d9a93", dim: "#6f6b63", good: "#7fc79a", bad: "#e08a76",
};
// Light version for the performance report: paper white, dark text, gold accents.
const LIGHT = {
  bg: "#fbf8f1", panel: "#ffffff", panel2: "#f3eee2", line: "#e7dfcd",
  gold: "#b8912c", gold2: "#c9a13e", gold3: "#e3d3a4", text: "#1a1813", soft: "#3f3b33",
  muted: "#655f52", dim: "#958e7e", good: "#3f7d55", bad: "#b4532a", onGold: "#ffffff", tint: "#fdf6e3",
  bars: ["#ece0bb", "#dfc988", "#cdae5c", "#b8912c"],
};
C.onGold = C.bg; C.tint = C.panel2;
const FONT_FILES = {
  r: "assets/fonts/figtree-400.ttf", rX: "assets/fonts/figtree-ext-400.ttf",
  sb: "assets/fonts/figtree-600.ttf", sbX: "assets/fonts/figtree-ext-600.ttf",
  b: "assets/fonts/figtree-700.ttf", bX: "assets/fonts/figtree-ext-700.ttf",
  d7: "assets/fonts/bricolage-700.ttf", d7X: "assets/fonts/bricolage-ext-700.ttf",
  d8: "assets/fonts/bricolage-800.ttf", d8X: "assets/fonts/bricolage-ext-800.ttf",
};

function hex(h){ const { rgb } = window.PDFLib; return rgb(parseInt(h.slice(1,3),16)/255, parseInt(h.slice(3,5),16)/255, parseInt(h.slice(5,7),16)/255); }
const has = (v) => v != null && v !== "" && !isNaN(v);
const money = (v) => has(v) ? "$" + Math.round(Number(v)).toLocaleString("en-NZ") : "-";
const money2 = (v) => has(v) ? "$" + Number(v).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-";
const num = (v) => has(v) ? Math.round(Number(v)).toLocaleString("en-NZ") : "-";
const times = (v) => v == null || !isFinite(v) ? "-" : (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + "×";
const pct = (a, b) => b ? Math.round(a / b * 100) + "%" : "–";

// Shared drawing kit: fonts and helpers, also used by the 90-day plan PDF.
async function makeKit(opts = {}){
  const P = opts.palette || C;
  const { PDFDocument } = window.PDFLib;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(window.fontkit);
  const raw = Object.fromEntries(await Promise.all(Object.entries(FONT_FILES).map(async ([k, url]) => {
    const r = await fetch(url + "?v=2"); if (!r.ok) throw new Error("Couldn't load the report fonts.");
    return [k, await r.arrayBuffer()];
  })));
  // Alternate glyph shapes throw the spacing out in PDF viewers, so plain shapes only.
  const opt = { subset: true, features: { calt: false, liga: false, rvrn: false, rlig: false } };
  const pair = async (a, b) => {
    const m = await pdf.embedFont(raw[a], opt), x = await pdf.embedFont(raw[b], opt);
    return { m, x, mSet: new Set(m.getCharacterSet()), xSet: new Set(x.getCharacterSet()) };
  };
  const F = { r: await pair("r", "rX"), sb: await pair("sb", "sbX"), b: await pair("b", "bX"), d7: await pair("d7", "d7X"), d8: await pair("d8", "d8X") };
  // The real logo: the light version for dark pages, the original for light ones.
  const logoRes = await fetch(P === C ? "assets/logo-light.png?v=1" : "assets/logo-dark.png?v=1"); if (!logoRes.ok) throw new Error("Couldn't load the logo.");
  const logo = await pdf.embedPng(await logoRes.arrayBuffer());
  const drawLogo = (page, x, y, h) => page.drawImage(logo, { x, y, width: h * logo.width / logo.height, height: h });

  // Text in runs, so letters outside basic Latin (macrons) use the extended font.
  const runs = (f, text) => {
    const out = [];
    for (let ch of String(text)){
      let cp = ch.codePointAt(0), font = f.mSet.has(cp) ? f.m : f.xSet.has(cp) ? f.x : null;
      if (!font){ ch = ch.normalize("NFD").replace(/[̀-ͯ]/g, ""); if (!ch || !f.mSet.has(ch.codePointAt(0))) continue; font = f.m; }
      if (out.length && out[out.length-1].font === font) out[out.length-1].s += ch; else out.push({ font, s: ch });
    }
    return out;
  };
  const width = (f, s, size, ls = 0) => runs(f, s).reduce((w, r) => w + r.font.widthOfTextAtSize(r.s, size), 0) + ls * Math.max(0, [...String(s)].length - 1);
  const text = (page, str, x, y, o = {}) => {
    const f = o.f || F.r, size = o.size || 10, ls = o.ls || 0, color = hex(o.color || P.text);
    let s = o.caps ? String(str).toUpperCase() : String(str);
    if (o.maxWidth) while (s.length > 1 && width(f, s, size, ls) > o.maxWidth) s = s.slice(0, -2) + "…";
    const w = width(f, s, size, ls);
    if (o.align === "right") x -= w; else if (o.align === "center") x -= w / 2;
    for (const r of runs(f, s)){
      if (!ls){ page.drawText(r.s, { x, y, size, font: r.font, color }); x += r.font.widthOfTextAtSize(r.s, size); continue; }
      for (const ch of r.s){ page.drawText(ch, { x, y, size, font: r.font, color }); x += r.font.widthOfTextAtSize(ch, size) + ls; }
    }
    return w;
  };
  const label = (page, s, x, y, o = {}) => text(page, s, x, y, { f: F.b, size: 6.8, ls: 1.3, caps: true, color: P.muted, ...o });
  const wrap = (f, str, size, maxW) => {
    const lines = [];
    for (const para of String(str || "").split(/\n+/)){
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)){
        const next = line ? line + " " + word : word;
        if (line && width(f, next, size) > maxW){ lines.push(line); line = word; } else line = next;
      }
      if (line) lines.push(line);
    }
    return lines;
  };
  const box = (page, x, y, w, h, o = {}) => {
    const r = Math.min(o.r ?? 10, h / 2, w / 2);
    const path = `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
    page.drawSvgPath(path, { x, y: y + h, color: o.fill ? hex(o.fill) : undefined, borderColor: o.stroke ? hex(o.stroke) : undefined, borderWidth: o.stroke ? (o.bw || 0.8) : 0 });
  };
  const hr = (page, x1, x2, y, color = P.line, t = 0.7) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: t, color: hex(color) });
  const vr = (page, x, y1, y2, color = P.line) => page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: 0.7, color: hex(color) });
  const tick = (page, cx, cy, s, color) => page.drawSvgPath(`M ${-s*0.45} ${s*0.02} L ${-s*0.12} ${s*0.32} L ${s*0.48} ${-s*0.3}`, { x: cx, y: cy, borderColor: hex(color), borderWidth: s * 0.22, borderLineCap: 1 });
  return { pdf, F, runs, width, text, label, wrap, box, hr, vr, tick, drawLogo };
}

// "What we did" and "What's next" for page 2: long lists go two to a row,
// and anything that won't fit above the footer carries on onto a new page.
function drawStoryLists(k, page, y, did, next){
  const { text, label, hr, wrap, F, C, more } = k, CW = W - 2 * M, FOOT = 56;
  const ensure = (h) => { if (y - h < FOOT){ page = more(); y = H - 108; } };
  const block = (title, items) => {
    if (!items.length) return;
    const cols = items.length > 4 ? 2 : 1, colW = cols === 2 ? (CW - 24) / 2 : CW;
    const hOf = (it) => Math.max(1, wrap(F.r, it, 9.5, colW - 30).length) * 13.5 + 10;
    ensure(26 + hOf(items[0]));
    label(page, title, M, y, { color: C.gold });
    hr(page, M, M + CW, y - 8);
    y -= 26;
    for (let i = 0; i < items.length; i += cols){
      const row = items.slice(i, i + cols), h = Math.max(...row.map(hOf));
      ensure(h);
      row.forEach((it, j) => {
        const x = M + j * (colW + 24);
        text(page, String(i + j + 1).padStart(2, "0"), x, y, { f: F.d8, size: 11, color: C.gold });
        wrap(F.r, it, 9.5, colW - 30).forEach((ln, l) => text(page, ln, x + 28, y - l * 13.5, { size: 9.5, color: C.soft }));
      });
      y -= h;
    }
    y -= 10;
  };
  block("What we did", did);
  block("What's next", next);
  return { page, y };
}

async function build(data){
  const C = LIGHT;
  const { pdf, F, width, text, label, wrap, box, hr, vr, tick, drawLogo } = await makeKit({ palette: LIGHT });

  const newPage = (n) => {
    const page = pdf.addPage([W, H]);
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(C.bg) });
    drawLogo(page, M, H - 64, 34);
    label(page, "Performance report", W - M, H - 44, { align: "right", color: C.gold, size: 7, ls: 1.6 });
    text(page, `Report ${data.reportNumber} · ${data.periodLabel}`, W - M, H - 57, { align: "right", size: 8.5, color: C.muted });
    hr(page, M, W - M, H - 70, C.gold2, 0.9);
    hr(page, M, W - M, 42, C.line);
    text(page, n === 1 ? "mrpriceless.com" : `Questions? ${[data.contactName, data.contactPhone].filter(Boolean).join(" · ") || "Your account manager"} · mrpriceless.com`, M, 28, { size: 7.5, color: C.dim, maxWidth: 400 });
    pages.push([page, n]);
    return page;
  };
  const pages = [];
  const CW = W - 2 * M;

  /* ───────── Page 1: the month so far ───────── */
  const p1 = newPage(1);
  label(p1, "Prepared for", M, H - 96);
  text(p1, data.clientName || "Client", M, H - 128, { f: F.d7, size: 28, maxWidth: CW });

  // Centrepiece: the work won and the profit it's made them, big and bright.
  // What they've spent sits underneath, small and quiet.
  const heroH = 206, heroY = H - 146 - heroH;
  box(p1, M, heroY, CW, heroH, { fill: "#0e0d0b", r: 14 });
  const halfW = (CW - 44) / 2, lx = M + 24, rx = M + 24 + halfW + 22;
  label(p1, `Work won since we started${data.since ? ` · ${data.since}` : ""}`, lx, heroY + heroH - 30, { color: "#e8c468" });
  text(p1, money(data.revenueToDate), lx, heroY + heroH - 92, { f: F.d8, size: 52, color: "#f3cf6a", maxWidth: halfW + 10 });
  const jobsAll = Number(data.jobsToDate) || 0;
  text(p1, jobsAll ? `from ${num(jobsAll)} job${jobsAll === 1 ? "" : "s"} your ads brought in` : "from jobs your ads brought in", lx, heroY + heroH - 112, { size: 10, color: "#d9d3c5" });
  vr(p1, rx - 12, heroY + 64, heroY + heroH - 22, "#2e2b25");
  const profitNet = has(data.profitToDate) ? Number(data.profitToDate) - (Number(data.investedToDate) || 0) : null;
  if (profitNet != null && profitNet > 0){
    label(p1, "Profit in your pocket", rx, heroY + heroH - 30, { color: "#8fe0b0" });
    text(p1, money(profitNet), rx, heroY + heroH - 84, { f: F.d8, size: 40, color: "#8fe0b0", maxWidth: halfW });
    wrap(F.r, `after everything you've invested with us - ad spend and our fees - at your ${data.margin}% margin`, 10, halfW).slice(0, 2).forEach((ln, i) => text(p1, ln, rx, heroY + heroH - 104 - i * 13, { size: 10, color: "#d9d3c5" }));
  } else {
    label(p1, "Return on your investment", rx, heroY + heroH - 30, { color: "#e8c468" });
    text(p1, times(data.roiToDate), rx, heroY + heroH - 84, { f: F.d8, size: 40, color: "#f3cf6a", maxWidth: halfW });
    text(p1, "back in work for every $1 invested", rx, heroY + heroH - 104, { size: 10, color: "#d9d3c5", maxWidth: halfW });
  }
  // What they've invested with us: clear, just second to the wins.
  hr(p1, lx, M + CW - 24, heroY + 62, "#2e2b25", 0.6);
  label(p1, "Invested with us so far", lx, heroY + 42, { color: "#a8a293" });
  const invW = text(p1, money(data.investedToDate), lx, heroY + 20, { f: F.d7, size: 18, color: "#ece6d8" });
  text(p1, `${money(data.adSpendToDate)} ad spend  +  ${money(data.mgmtToDate)} our fees`, lx + invW + 12, heroY + 23, { size: 9.5, color: "#a8a293" });
  if (has(data.roiToDate) && data.roiToDate > 0){
    label(p1, "Return", rx, heroY + 42, { color: "#a8a293" });
    const rw = text(p1, times(data.roiToDate), rx, heroY + 20, { f: F.d7, size: 18, color: "#f3cf6a" });
    text(p1, "back in work for every $1 invested", rx + rw + 10, heroY + 23, { size: 9.5, color: "#a8a293", maxWidth: halfW - rw - 10 });
  }

  // This month at a glance: the wins, in three clean tiles.
  const tileH = 88, tileY = heroY - 14 - tileH, tileW = (CW - 24) / 3;
  const jobs = Number(data.jobsMonth) || 0;
  const jobValue = jobs && has(data.revenueMonth) ? Number(data.revenueMonth) / jobs : null;
  [[`Won in ${data.monthName}`, money(data.revenueMonth), jobs ? `${num(jobs)} new job${jobs === 1 ? "" : "s"} signed` : "quotes still coming back", C.gold],
   ["Jobs signed", String(jobs), data.lastMonthName && has(data.revenueLastMonth) ? `${money(data.revenueLastMonth)} won in ${data.lastMonthName}` : `in ${data.monthName} so far`, C.text],
   ["Average job value", jobValue != null ? money(jobValue) : "-", jobs ? "per job signed this month" : "once jobs are signed", C.text]].forEach(([l, v, sub, col], i) => {
    const x = M + i * (tileW + 12);
    box(p1, x, tileY, tileW, tileH, { fill: C.panel, stroke: C.line });
    label(p1, l, x + 16, tileY + tileH - 24, { size: 6.6, maxWidth: tileW - 30 });
    text(p1, v, x + 16, tileY + 32, { f: F.d8, size: 26, color: col, maxWidth: tileW - 30 });
    text(p1, sub, x + 16, tileY + 15, { size: 8, color: C.muted, maxWidth: tileW - 30 });
  });

  const gH = 108, gY = tileY - 14 - gH;
  if (data.showGuarantee === false){
    // After the first month: the quote pipeline, no guarantee.
    const got = Math.max(0, Number(data.quotesBooked) || 0), q = Math.max(0, Number(data.quoted) || 0), enq = Math.max(0, Number(data.enquiries) || 0);
    box(p1, M, gY, CW, gH, { fill: C.panel, stroke: C.gold3, bw: 1 });
    label(p1, `Your quote pipeline · ${data.monthName}`, M + 22, gY + gH - 26, { color: C.gold });
    const cols = [[num(enq), "enquiries from your ads"], [num(got), "quotes booked"], [num(q), "quotes sent"], [num(data.awaitingDecision || 0), "waiting on a decision"]];
    const colW = (CW - 44) / cols.length;
    cols.forEach(([v, l], i) => {
      const x = M + 22 + i * colW;
      text(p1, v, x, gY + 44, { f: F.d8, size: 30, color: i === 1 ? C.gold : C.text });
      text(p1, l, x, gY + 26, { size: 8.8, color: C.soft, maxWidth: colW - 10 });
    });
  } else {
  // The quote guarantee, front and centre (their first month).
  const target = Math.max(1, Number(data.quoteTarget) || 10), got = Math.max(0, Number(data.quotesBooked) || 0);
  box(p1, M, gY, CW, gH, { fill: C.panel, stroke: got >= target ? C.gold : C.gold3, bw: 1 });
  label(p1, `Your ${target}-quote guarantee · ${data.monthName}`, M + 22, gY + gH - 26, { color: C.gold });
  const big = `${num(Math.min(got, 999))}`;
  const bw = text(p1, big, M + 22, gY + gH - 56, { f: F.d8, size: 34 });
  text(p1, ` of ${target} quotes booked`, M + 24 + bw, gY + gH - 56, { f: F.sb, size: 12, color: C.soft });
  const pill = got >= target ? (got > target ? `Guarantee met · +${got - target} extra` : "Guarantee met") : `${target - got} to go`;
  const pw = width(F.b, pill, 9) + 24;
  box(p1, W - M - 22 - pw, gY + gH - 64, pw, 22, { fill: got >= target ? C.gold : C.panel2, stroke: got >= target ? undefined : C.gold3, r: 11 });
  text(p1, pill, W - M - 22 - pw / 2, gY + gH - 56.5, { f: F.b, size: 9, color: got >= target ? C.onGold : C.gold, align: "center" });
  // One circle per quote.
  const slots = Math.min(target, 20), gap = 8, rowW = CW - 44;
  const d = Math.min(36, (rowW - gap * (slots - 1)) / slots);
  const startX = M + 22, cy = gY + 26;
  for (let i = 0; i < slots; i++){
    const cx = startX + d / 2 + i * (d + gap);
    const done = i < got;
    p1.drawCircle({ x: cx, y: cy, size: d / 2, color: done ? hex(C.gold) : hex(C.panel2), borderColor: done ? undefined : hex(C.gold3), borderWidth: done ? 0 : 0.9 });
    if (done) tick(p1, cx, cy, d * 0.42, C.onGold);
    else text(p1, String(i + 1), cx, cy - 3.6, { f: F.b, size: 9.5, color: C.dim, align: "center" });
  }
  }

  // From enquiry to signed job.
  let y = gY - 30;
  text(p1, "From enquiry to signed job", M, y, { f: F.d7, size: 16 });
  text(p1, `${data.monthName} so far · conversion from previous stage`, W - M, y + 2, { size: 8, color: C.muted, align: "right" });
  y -= 14;
  const steps = [["Enquiries", data.enquiries], ["Quotes booked", data.quoteReady], ["Quoted", data.quoted], ["Won", data.jobsMonth]];
  const top = Math.max(1, ...steps.map(s => Number(s[1]) || 0));
  const barX = M + 100, barW = CW - 100 - 80, shades = C.bars || [C.gold3, C.gold2, "#d9b55a", C.gold];
  steps.forEach(([name, v], i) => {
    y -= 28;
    const isWon = i === 3;
    text(p1, name, M, y + 4, { f: isWon ? F.b : F.r, size: 10, color: isWon ? C.gold : C.soft });
    box(p1, barX, y, barW, 16, { fill: C.panel2, r: 4 });
    const val = Number(v) || 0;
    if (val > 0) box(p1, barX, y, Math.max(8, val / top * barW), 16, { fill: shades[i], r: 4 });
    text(p1, has(v) ? num(v) : "-", barX + barW + 32, y + 3.5, { f: F.d7, size: 12, align: "right", color: isWon ? C.gold : C.text });
    const prev = i ? Number(steps[i-1][1]) : 0;
    text(p1, i && prev && has(v) ? pct(val, prev) : "–", W - M, y + 4, { size: 8.5, color: C.muted, align: "right" });
  });
  y -= 22;
  const waiting = Number(data.awaitingDecision) || 0;
  const note = `Quotes booked are quote visits in the calendar, so some haven't been quoted yet.${waiting ? ` ${num(waiting)} quote${waiting === 1 ? "" : "s"} sent ${waiting === 1 ? "is" : "are"} still waiting on a decision.` : ""}`;
  wrap(F.r, note, 8.8, CW).forEach((ln, i) => text(p1, ln, M, y - i * 12, { size: 8.8, color: C.muted }));

  /* ───────── Page 2: the story ───────── */
  let pg = newPage(2);
  y = H - 108;
  text(pg, `${data.monthName} so far, in plain English`, M, y, { f: F.d7, size: 21 });
  y -= 22;
  if (data.summary){
    const lines = wrap(F.r, data.summary, 10.5, CW);
    lines.forEach((ln, i) => text(pg, ln, M, y - i * 15.5, { size: 10.5, color: C.soft }));
    y -= lines.length * 15.5 + 12;
  }
  const did = (data.didList || []).filter(Boolean), next = (data.nextList || []).filter(Boolean);
  ({ page: pg, y } = drawStoryLists({ text, label, hr, wrap, F, C, more: () => newPage(pages.length + 1) }, pg, y, did, next));
  if (data.topAd){
    const aH = 170;
    if (y - aH < 56){ pg = newPage(pages.length + 1); y = H - 108; }
    const aY = y - aH;
    box(pg, M, aY, CW, aH, { fill: C.panel, stroke: C.line });
    const imgS = aH - 32, ix = M + 16, iy = aY + 16;
    let drew = false;
    if (data.topAd.imageBytes){
      try {
        const L = window.PDFLib;
        const img = data.topAd.imageType === "png" ? await pdf.embedPng(data.topAd.imageBytes) : await pdf.embedJpg(data.topAd.imageBytes);
        const scale = Math.max(imgS / img.width, imgS / img.height), dw = img.width * scale, dh = img.height * scale;
        pg.pushOperators(L.pushGraphicsState(), L.rectangle(ix, iy, imgS, imgS), L.clip(), L.endPath());
        pg.drawImage(img, { x: ix + (imgS - dw) / 2, y: iy + (imgS - dh) / 2, width: dw, height: dh });
        pg.pushOperators(L.popGraphicsState());
        drew = true;
      } catch(e){}
    }
    if (!drew){ box(pg, ix, iy, imgS, imgS, { fill: C.panel2, r: 6 }); text(pg, "Ad creative", ix + imgS / 2, iy + imgS / 2 - 3, { size: 8.5, color: C.dim, align: "center" }); }
    const tx = ix + imgS + 22, tw = W - M - 22 - tx;
    label(pg, "Top performing ad", tx, aY + aH - 30, { color: C.gold });
    wrap(F.d7, data.topAd.name || "", 17, tw).slice(0, 2).forEach((ln, i) => text(pg, ln, tx, aY + aH - 54 - i * 20, { f: F.d7, size: 17 }));
    const stats = [[num(data.topAd.leads), "leads"], [money2(data.topAd.cpl), "per lead"], [has(data.topAd.share) ? data.topAd.share + "%" : "-", "of all leads"]];
    const sw = tw / 3;
    stats.forEach(([v, l], i) => {
      text(pg, v, tx + i * sw, aY + 40, { f: F.d7, size: 19, color: C.gold });
      text(pg, l, tx + i * sw, aY + 26, { size: 8.5, color: C.muted });
    });
    y = aY - 22;
  }

  const hood = (data.hood || []).filter(r => r[1] != null && r[1] !== "-" && r[1] !== "");
  let hp = pg;
  // Not enough room left above the footer? The numbers table gets its own page.
  if (hood.length && y - (38 + hood.length * 26) < 56){ hp = newPage(pages.length + 1); y = H - 108; }
  if (hood.length){
    text(hp, "Under the hood", M, y - 8, { f: F.d7, size: 16 });
    text(hp, "The numbers, explained", W - M, y - 6, { size: 8.5, color: C.muted, align: "right" });
    y -= 30;
    label(hp, "Metric", M, y); label(hp, "Result", M + 200, y, { align: "right" }); label(hp, "What it means", M + 224, y);
    y -= 8;
    hood.forEach(([name, val, means]) => {
      hr(hp, M, W - M, y, C.line, 0.5);
      y -= 18;
      text(hp, name, M, y, { f: F.sb, size: 9.5 });
      text(hp, val, M + 200, y, { f: F.b, size: 9.5, align: "right" });
      text(hp, means, M + 224, y, { size: 9, color: C.muted, maxWidth: W - M - (M + 224) });
      y -= 8;
    });
  }

  pages.forEach(([page, n]) => text(page, `Confidential · Page ${n} of ${pages.length}`, W - M, 28, { size: 7.5, color: C.dim, align: "right" }));
  pdf.setTitle(`Mr Priceless Report - ${data.clientName || ""} - ${data.periodLabel}`);
  pdf.setAuthor("Mr Priceless");
  return pdf.save();
}

/* ───────── Early days report ─────────
   For clients who haven't won a job yet. Instead of leading with revenue and
   return, it shows what's actually happening early on: Meta's learning
   phase and how far through it they are, how many people have seen their
   brand, and the enquiries and quotes building in the pipeline. */
async function buildEarly(data){
  const C = LIGHT;
  const { pdf, F, width, text, label, wrap, box, hr, drawLogo } = await makeKit({ palette: LIGHT });
  const pages = [];
  const newPage = (n) => {
    const page = pdf.addPage([W, H]);
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(C.bg) });
    drawLogo(page, M, H - 64, 34);
    label(page, "Early results report", W - M, H - 44, { align: "right", color: C.gold, size: 7, ls: 1.6 });
    text(page, `Report ${data.reportNumber} · ${data.periodLabel}`, W - M, H - 57, { align: "right", size: 8.5, color: C.muted });
    hr(page, M, W - M, H - 70, C.gold2, 0.9);
    hr(page, M, W - M, 42, C.line);
    text(page, `Questions? ${[data.contactName, data.contactPhone].filter(Boolean).join(" · ") || "Your account manager"} · mrpriceless.com`, M, 28, { size: 7.5, color: C.dim, maxWidth: 400 });
    pages.push([page, n]);
    return page;
  };
  const CW = W - 2 * M;
  const p1 = newPage(1);
  label(p1, "Prepared for", M, H - 96);
  text(p1, data.clientName || "Client", M, H - 128, { f: F.d7, size: 28, maxWidth: CW });

  // Hero: Meta's learning phase, and how far through it they are.
  const LEARN = 50, results = Math.max(0, Number(data.leadsToDate) || 0), pctL = Math.min(1, results / LEARN);
  const heroH = 178, heroY = H - 150 - heroH;
  box(p1, M, heroY, CW, heroH, { fill: C.tint, stroke: C.gold3, bw: 1 });
  label(p1, "Where we're at", M + 22, heroY + heroH - 28, { color: C.gold });
  const stage = pctL >= 1 ? "Out of the learning phase" : pctL >= 0.5 ? "Learning phase - past halfway" : "Learning phase - early days";
  text(p1, stage, M + 22, heroY + heroH - 56, { f: F.d7, size: 22 });
  const blurb = pctL >= 1
    ? "Meta has enough data now to find the right people for you. From here the focus is turning that attention into booked jobs, and costs should keep coming down."
    : `Meta needs around ${LEARN} results to learn who your best customers are. Until then it's testing who to show your ads to, so costs swing around and come down as it learns. We're at ${results} of ${LEARN}.`;
  wrap(F.r, blurb, 10, CW - 44).slice(0, 3).forEach((ln, i) => text(p1, ln, M + 22, heroY + heroH - 78 - i * 14, { size: 10, color: C.soft }));
  // Learning bar with the three phases under it.
  const bx = M + 22, bw = CW - 44, by = heroY + 44;
  box(p1, bx, by, bw, 12, { fill: C.panel2, r: 6 });
  if (pctL > 0) box(p1, bx, by, Math.max(12, bw * pctL), 12, { fill: C.gold, r: 6 });
  [["Learning", 0], ["Optimising", 0.5], ["Scaling", 1]].forEach(([n, at], i) => {
    const x = bx + bw * at;
    text(p1, n, i === 0 ? x : i === 2 ? x : x, by - 16, { size: 8.5, f: F.sb, color: C.muted, align: i === 0 ? "left" : i === 2 ? "right" : "center" });
  });
  text(p1, `${results} / ${LEARN} results`, bx + bw, by + 20, { size: 8.5, f: F.b, color: C.gold, align: "right" });

  // Brand awareness: people seeing and clicking.
  let y = heroY - 30;
  text(p1, "Your brand is getting seen", M, y, { f: F.d7, size: 16 });
  text(p1, "All-time, from Meta", W - M, y + 2, { size: 8, color: C.muted, align: "right" });
  y -= 16;
  const imps = Number(data.impressions) || 0, clicks = Number(data.clicks) || 0, spend = Number(data.adSpendToDate) || 0;
  const tiles = [
    [num(imps), "times seen", "Every one of those is a local seeing your name and your work."],
    [num(clicks), "clicks through", "People interested enough to look closer."],
    [imps ? (clicks / imps * 100).toFixed(1) + "%" : "-", "click-through rate", "Above 1% means the ads are catching attention."],
    [imps && spend ? money2(spend / imps * 1000) : "-", "per 1,000 views", "What it costs to put your brand in front of 1,000 people."],
  ];
  const tW = (CW - 36) / 4, tH = 104;
  tiles.forEach(([v, l, s], i) => {
    const x = M + i * (tW + 12);
    box(p1, x, y - tH, tW, tH, { fill: C.panel, stroke: C.line });
    text(p1, v, x + 14, y - 34, { f: F.d7, size: 20, color: i === 0 ? C.gold : C.text, maxWidth: tW - 24 });
    text(p1, l, x + 14, y - 50, { f: F.sb, size: 8.8, color: C.text, maxWidth: tW - 24 });
    wrap(F.r, s, 7.8, tW - 26).slice(0, 3).forEach((ln, j) => text(p1, ln, x + 14, y - 66 - j * 10.5, { size: 7.8, color: C.muted }));
  });
  y -= tH + 30;

  // The pipeline building up.
  text(p1, "The pipeline is building", M, y, { f: F.d7, size: 16 });
  text(p1, `${data.monthName} so far`, W - M, y + 2, { size: 8, color: C.muted, align: "right" });
  y -= 16;
  const enq = Number(data.enquiries) || 0, qb = Number(data.quoteReady) || 0, qs = Number(data.quoted) || 0;
  const pipe = [
    [num(enq), "enquiries", data.adSpendMonth && enq ? `${money(Number(data.adSpendMonth) / enq)} each` : ""],
    [num(qb), "quotes booked", "site visits and quotes in the calendar"],
    [num(qs), "quotes sent", qs ? "waiting on a decision" : "on their way"],
  ];
  const pW = (CW - 24) / 3, pH = 76;
  pipe.forEach(([v, l, s], i) => {
    const x = M + i * (pW + 12);
    box(p1, x, y - pH, pW, pH, { fill: i === 1 ? C.tint : C.panel, stroke: i === 1 ? C.gold3 : C.line });
    text(p1, v, x + 16, y - 34, { f: F.d8, size: 24, color: i === 1 ? C.gold : C.text });
    text(p1, l, x + 16, y - 50, { f: F.sb, size: 9.5 });
    if (s) text(p1, s, x + 16, y - 63, { size: 8, color: C.muted, maxWidth: pW - 28 });
  });
  y -= pH + 18;
  wrap(F.r, "Quotes turn into jobs over the following weeks. Most of the work won from these first months shows up a little later, once quotes come back and the ads are fully trained.", 8.8, CW).forEach((ln, i) => text(p1, ln, M, y - i * 12, { size: 8.8, color: C.muted }));

  /* Page 2: the story, what's next, and why early results look like this */
  let pg = newPage(2);
  y = H - 108;
  text(pg, `${data.monthName} so far, in plain English`, M, y, { f: F.d7, size: 21 });
  y -= 22;
  if (data.summary){
    const lines = wrap(F.r, data.summary, 10.5, CW);
    lines.forEach((ln, i) => text(pg, ln, M, y - i * 15.5, { size: 10.5, color: C.soft }));
    y -= lines.length * 15.5 + 12;
  }
  const did = (data.didList || []).filter(Boolean), next = (data.nextList || []).filter(Boolean);
  ({ page: pg, y } = drawStoryLists({ text, label, hr, wrap, F, C, more: () => newPage(pages.length + 1) }, pg, y, did, next));
  if (data.topAd){
    const aH = 170;
    if (y - aH < 56){ pg = newPage(pages.length + 1); y = H - 108; }
    const aY = y - aH;
    box(pg, M, aY, CW, aH, { fill: C.panel, stroke: C.line });
    const imgS = aH - 32, ix = M + 16, iy = aY + 16;
    let drew = false;
    if (data.topAd.imageBytes){
      try {
        const L = window.PDFLib;
        const img = data.topAd.imageType === "png" ? await pdf.embedPng(data.topAd.imageBytes) : await pdf.embedJpg(data.topAd.imageBytes);
        const scale = Math.max(imgS / img.width, imgS / img.height), dw = img.width * scale, dh = img.height * scale;
        pg.pushOperators(L.pushGraphicsState(), L.rectangle(ix, iy, imgS, imgS), L.clip(), L.endPath());
        pg.drawImage(img, { x: ix + (imgS - dw) / 2, y: iy + (imgS - dh) / 2, width: dw, height: dh });
        pg.pushOperators(L.popGraphicsState());
        drew = true;
      } catch(e){}
    }
    if (!drew){ box(pg, ix, iy, imgS, imgS, { fill: C.panel2, r: 6 }); text(pg, "Ad creative", ix + imgS / 2, iy + imgS / 2 - 3, { size: 8.5, color: C.dim, align: "center" }); }
    const tx = ix + imgS + 22, tw = W - M - 22 - tx;
    label(pg, "Your best ad so far", tx, aY + aH - 30, { color: C.gold });
    wrap(F.d7, data.topAd.name || "", 17, tw).slice(0, 2).forEach((ln, i) => text(pg, ln, tx, aY + aH - 54 - i * 20, { f: F.d7, size: 17 }));
    const stats = [[num(data.topAd.leads), "leads"], [money2(data.topAd.cpl), "per lead"], [has(data.topAd.share) ? data.topAd.share + "%" : "-", "of all leads"]];
    const sw = tw / 3;
    stats.forEach(([v, l], i) => {
      text(pg, v, tx + i * sw, aY + 40, { f: F.d7, size: 19, color: C.gold });
      text(pg, l, tx + i * sw, aY + 26, { size: 8.5, color: C.muted });
    });
    y = aY - 22;
  }
  // The honest bit, for the early months.
  const honest = [
    ["The first weeks are Meta learning.", "It tests your ads on different people to find who actually enquires. Costs are higher and results bounce around until it has enough data."],
    ["People buy when they're ready.", "Most people aren't ready the day they first see an ad. Seeing your name again and again means that when they are, you're the one they already know and call."],
    ["Sales cycles take time.", "Most people get a few quotes and take weeks to decide, and bigger jobs can take months. The pipeline building now is the work that lands over the coming weeks."],
    ["One job leads to more.", "Every job won gets talked about. Neighbours see the work, friends ask who did it, reviews build. Even one signed job starts word of mouth on top of the ads."],
    ["Follow-up wins it.", "We call every enquiry within minutes and book the quotes in. Following each quote up after a few days is what turns this pipeline into work."],
  ];
  const rows = honest.map(([, b]) => Math.max(1, wrap(F.r, b, 9, CW - 196).length) * 13 + 10);
  const hH = 60 + rows.reduce((a, b) => a + b, 0);
  let hp = pg;
  if (y - hH < 56){ hp = newPage(pages.length + 1); y = H - 100; }
  const hY = y - hH;
  box(hp, M, hY, CW, hH, { fill: "#0b0b0c", r: 12 });
  label(hp, "What to expect", M + 20, hY + hH - 22, { color: "#e8c468" });
  text(hp, "Why early results look like this", M + 20, hY + hH - 42, { f: F.d7, size: 15, color: "#ffffff" });
  let rt = hY + hH - 64;
  honest.forEach(([h, b], i) => {
    text(hp, h, M + 20, rt, { f: F.b, size: 9.4, color: "#e8c468", maxWidth: 150 });
    wrap(F.r, b, 9, CW - 196).forEach((ln, j) => text(hp, ln, M + 176, rt - j * 13, { size: 9, color: "#d9d3c5" }));
    rt -= rows[i];
  });

  pages.forEach(([page, n]) => text(page, `Confidential · Page ${n} of ${pages.length}`, W - M, 28, { size: 7.5, color: C.dim, align: "right" }));
  pdf.setTitle(`Mr Priceless Early Results Report - ${data.clientName || ""} - ${data.periodLabel}`);
  pdf.setAuthor("Mr Priceless");
  return pdf.save();
}

window.MPReportPDF = { build, buildEarly, makeKit, C, LIGHT, W, H, M, hex, has, money, num };
})();
