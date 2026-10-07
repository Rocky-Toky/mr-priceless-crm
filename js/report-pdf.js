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

async function build(data){
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
    const f = o.f || F.r, size = o.size || 10, ls = o.ls || 0, color = hex(o.color || C.text);
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
  const label = (page, s, x, y, o = {}) => text(page, s, x, y, { f: F.b, size: 6.8, ls: 1.3, caps: true, color: C.muted, ...o });
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
  const hr = (page, x1, x2, y, color = C.line, t = 0.7) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: t, color: hex(color) });
  const vr = (page, x, y1, y2, color = C.line) => page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: 0.7, color: hex(color) });
  const tick = (page, cx, cy, s, color) => page.drawSvgPath(`M ${-s*0.45} ${s*0.02} L ${-s*0.12} ${s*0.32} L ${s*0.48} ${-s*0.3}`, { x: cx, y: cy, borderColor: hex(color), borderWidth: s * 0.22, borderLineCap: 1 });

  const newPage = (n) => {
    const page = pdf.addPage([W, H]);
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(C.bg) });
    text(page, "MR. PRICELESS", M, H - 50, { f: F.d8, size: 14, ls: 3 });
    label(page, "Performance report", W - M, H - 44, { align: "right", color: C.gold, size: 7, ls: 1.6 });
    text(page, `Report ${data.reportNumber} · ${data.periodLabel}`, W - M, H - 57, { align: "right", size: 8.5, color: C.muted });
    hr(page, M, W - M, H - 70, C.gold2, 0.9);
    hr(page, M, W - M, 42, C.line);
    text(page, n === 1 ? "mrpriceless.com" : `Questions? ${[data.contactName, data.contactPhone].filter(Boolean).join(" · ") || "Your account manager"} · mrpriceless.com`, M, 28, { size: 7.5, color: C.dim, maxWidth: 400 });
    text(page, `Confidential · Page ${n} of 2`, W - M, 28, { size: 7.5, color: C.dim, align: "right" });
    return page;
  };
  const CW = W - 2 * M;

  /* ───────── Page 1: the month so far ───────── */
  const p1 = newPage(1);
  label(p1, "Prepared for", M, H - 96);
  text(p1, data.clientName || "Client", M, H - 128, { f: F.d7, size: 28, maxWidth: CW });

  // Hero: revenue this month + return on everything invested.
  const heroH = 168, heroY = H - 150 - heroH;
  box(p1, M, heroY, CW, heroH, { fill: C.panel, stroke: C.line });
  const split = M + CW * 0.6;
  label(p1, `Revenue won in ${data.monthName}`, M + 22, heroY + heroH - 28);
  text(p1, money(data.revenueMonth), M + 20, heroY + heroH - 84, { f: F.d8, size: 50, color: C.gold });
  const jobs = Number(data.jobsMonth) || 0;
  text(p1, jobs ? `${jobs} job${jobs === 1 ? "" : "s"} signed from enquiries our ads brought in` : "No jobs signed yet this month", M + 22, heroY + heroH - 104, { size: 9.5, color: C.muted, maxWidth: split - M - 40 });
  hr(p1, M + 22, split - 22, heroY + 50);
  label(p1, `Won since ${data.since}`, M + 22, heroY + 32, { size: 6.4 });
  text(p1, money(data.revenueToDate), M + 22, heroY + 14, { f: F.d7, size: 14 });
  label(p1, `Last month${data.lastMonthName ? " · " + data.lastMonthName : ""}`, M + 150, heroY + 32, { size: 6.4 });
  text(p1, has(data.revenueLastMonth) ? money(data.revenueLastMonth) : "-", M + 150, heroY + 14, { f: F.d7, size: 14 });
  vr(p1, split, heroY + 18, heroY + heroH - 18);
  text(p1, times(data.roiToDate), split + 22, heroY + heroH - 68, { f: F.d8, size: 38 });
  text(p1, "return on your total", split + 22, heroY + heroH - 86, { size: 9.5, color: C.soft });
  text(p1, "investment to date", split + 22, heroY + heroH - 99, { size: 9.5, color: C.soft });
  hr(p1, split + 22, W - M - 22, heroY + 50);
  text(p1, `${money(data.investedToDate)} invested`, split + 22, heroY + 31, { f: F.b, size: 10.5 });
  text(p1, `${money(data.adSpendToDate)} ad spend + ${money(data.mgmtToDate)} management`, split + 22, heroY + 17, { size: 7.8, color: C.muted, maxWidth: W - M - 22 - split - 22 });

  // The 10-quote guarantee, front and centre.
  const target = Math.max(1, Number(data.quoteTarget) || 10), got = Math.max(0, Number(data.quotesBooked) || 0);
  const gH = 136, gY = heroY - 14 - gH;
  box(p1, M, gY, CW, gH, { fill: C.panel, stroke: got >= target ? C.gold : C.gold3, bw: 1 });
  label(p1, `Your ${target}-quote guarantee · ${data.monthName}`, M + 22, gY + gH - 26, { color: C.gold });
  const big = `${num(Math.min(got, 999))}`;
  const bw = text(p1, big, M + 22, gY + gH - 66, { f: F.d8, size: 34 });
  text(p1, ` of ${target} quotes booked`, M + 24 + bw, gY + gH - 66, { f: F.sb, size: 12, color: C.soft });
  const pill = got >= target ? (got > target ? `Guarantee met · +${got - target} extra` : "Guarantee met") : `${target - got} to go`;
  const pw = width(F.b, pill, 9) + 24;
  box(p1, W - M - 22 - pw, gY + gH - 72, pw, 22, { fill: got >= target ? C.gold : C.panel2, stroke: got >= target ? undefined : C.gold3, r: 11 });
  text(p1, pill, W - M - 22 - pw / 2, gY + gH - 64.5, { f: F.b, size: 9, color: got >= target ? C.bg : C.gold, align: "center" });
  // One circle per quote.
  const slots = Math.min(target, 20), gap = 8, rowW = CW - 44;
  const d = Math.min(36, (rowW - gap * (slots - 1)) / slots);
  const startX = M + 22, cy = gY + 32;
  for (let i = 0; i < slots; i++){
    const cx = startX + d / 2 + i * (d + gap);
    const done = i < got;
    p1.drawCircle({ x: cx, y: cy, size: d / 2, color: done ? hex(C.gold) : hex(C.panel2), borderColor: done ? undefined : hex(C.gold3), borderWidth: done ? 0 : 0.9 });
    if (done) tick(p1, cx, cy, d * 0.42, C.bg);
    else text(p1, String(i + 1), cx, cy - 3.6, { f: F.b, size: 9.5, color: C.dim, align: "center" });
  }

  // Three cards: pipeline, quote-ready leads, cost per quote-ready lead.
  const cardH = 84, cardY = gY - 14 - cardH, cardW = (CW - 24) / 3;
  const cpl = has(data.adSpendMonth) && Number(data.quoteReady) ? Number(data.adSpendMonth) / Number(data.quoteReady) : null;
  let cplNote = "", cplColor = C.muted;
  if (cpl != null && has(data.cplLastMonth) && Number(data.cplLastMonth) > 0){
    const ch = Math.round((cpl - data.cplLastMonth) / data.cplLastMonth * 100);
    cplNote = ch === 0 ? "same as last month" : `${Math.abs(ch)}% ${ch < 0 ? "lower" : "higher"} than last month`;
    cplColor = ch <= 0 ? C.good : C.bad;
  }
  const cards = [
    ["Pipeline quoted", money(data.openQuotesValue), has(data.openQuotesCount) ? `${num(data.openQuotesCount)} quote${Number(data.openQuotesCount) === 1 ? "" : "s"} still open${Number(data.openQuotesCount) ? ` · avg ${money(data.openQuotesValue / data.openQuotesCount)}` : ""}` : "quotes still open", C.muted],
    ["Quote-ready leads", num(data.quoteReady), has(data.enquiries) ? `qualified from ${num(data.enquiries)} enquiries` : "this month", C.muted],
    ["Cost per quote-ready lead", cpl != null ? money2(cpl) : "-", cplNote || "this month", cplColor],
  ];
  cards.forEach(([l, v, sub, sc], i) => {
    const x = M + i * (cardW + 12);
    box(p1, x, cardY, cardW, cardH, { fill: C.panel, stroke: C.line });
    label(p1, l, x + 16, cardY + cardH - 24, { size: 6.4, maxWidth: cardW - 30 });
    text(p1, v, x + 16, cardY + 30, { f: F.d7, size: 23 });
    text(p1, sub, x + 16, cardY + 14, { size: 7.8, color: sc, maxWidth: cardW - 30 });
  });

  // From enquiry to signed job.
  let y = cardY - 34;
  text(p1, "From enquiry to signed job", M, y, { f: F.d7, size: 16 });
  text(p1, `${data.monthName} so far · conversion from previous stage`, W - M, y + 2, { size: 8, color: C.muted, align: "right" });
  y -= 14;
  const steps = [["Enquiries", data.enquiries], ["Quote-ready", data.quoteReady], ["Quoted", data.quoted], ["Won", data.jobsMonth]];
  const top = Math.max(1, ...steps.map(s => Number(s[1]) || 0));
  const barX = M + 92, barW = CW - 92 - 80, shades = [C.gold3, C.gold2, "#d9b55a", C.gold];
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
  if (Number(data.openQuotesCount)){
    y -= 22;
    text(p1, `${num(data.openQuotesCount)} quote${Number(data.openQuotesCount) === 1 ? "" : "s"} worth ${money(data.openQuotesValue)} ${Number(data.openQuotesCount) === 1 ? "is" : "are"} still open and could convert in the coming weeks.`, M, y, { size: 8.8, color: C.muted, maxWidth: CW });
  }

  /* ───────── Page 2: the story ───────── */
  const p2 = newPage(2);
  y = H - 108;
  text(p2, `${data.monthName} so far, in plain English`, M, y, { f: F.d7, size: 21 });
  y -= 22;
  if (data.summary){
    const lines = wrap(F.r, data.summary, 10.5, CW);
    lines.forEach((ln, i) => text(p2, ln, M, y - i * 15.5, { size: 10.5, color: C.soft }));
    y -= lines.length * 15.5 + 12;
  }
  const did = (data.didList || []).filter(Boolean), next = (data.nextList || []).filter(Boolean);
  if (did.length || next.length){
    const colW = (CW - 24) / 2;
    const col = (title, items, x) => {
      label(p2, title, x, y, { color: C.gold });
      hr(p2, x, x + colW, y - 8);
      let cy = y - 26;
      items.forEach((it, i) => {
        text(p2, String(i + 1).padStart(2, "0"), x, cy, { f: F.d8, size: 11, color: C.gold });
        const lines = wrap(F.r, it, 9.5, colW - 30);
        lines.forEach((ln, j) => text(p2, ln, x + 28, cy - j * 13.5, { size: 9.5, color: C.soft }));
        cy -= Math.max(1, lines.length) * 13.5 + 9;
      });
      return cy;
    };
    y = Math.min(col("What we did", did, M), col("What's next", next, M + colW + 24)) - 6;
  }

  if (data.topAd){
    const aH = 170, aY = y - aH;
    box(p2, M, aY, CW, aH, { fill: C.panel, stroke: C.line });
    const imgS = aH - 32, ix = M + 16, iy = aY + 16;
    let drew = false;
    if (data.topAd.imageBytes){
      try {
        const L = window.PDFLib;
        const img = data.topAd.imageType === "png" ? await pdf.embedPng(data.topAd.imageBytes) : await pdf.embedJpg(data.topAd.imageBytes);
        const scale = Math.max(imgS / img.width, imgS / img.height), dw = img.width * scale, dh = img.height * scale;
        p2.pushOperators(L.pushGraphicsState(), L.rectangle(ix, iy, imgS, imgS), L.clip(), L.endPath());
        p2.drawImage(img, { x: ix + (imgS - dw) / 2, y: iy + (imgS - dh) / 2, width: dw, height: dh });
        p2.pushOperators(L.popGraphicsState());
        drew = true;
      } catch(e){}
    }
    if (!drew){ box(p2, ix, iy, imgS, imgS, { fill: C.panel2, r: 6 }); text(p2, "Ad creative", ix + imgS / 2, iy + imgS / 2 - 3, { size: 8.5, color: C.dim, align: "center" }); }
    const tx = ix + imgS + 22, tw = W - M - 22 - tx;
    label(p2, "Top performing ad", tx, aY + aH - 30, { color: C.gold });
    wrap(F.d7, data.topAd.name || "", 17, tw).slice(0, 2).forEach((ln, i) => text(p2, ln, tx, aY + aH - 54 - i * 20, { f: F.d7, size: 17 }));
    const stats = [[num(data.topAd.leads), "leads"], [money2(data.topAd.cpl), "per lead"], [has(data.topAd.share) ? data.topAd.share + "%" : "-", "of all leads"]];
    const sw = tw / 3;
    stats.forEach(([v, l], i) => {
      text(p2, v, tx + i * sw, aY + 40, { f: F.d7, size: 19, color: C.gold });
      text(p2, l, tx + i * sw, aY + 26, { size: 8.5, color: C.muted });
    });
    y = aY - 22;
  }

  const hood = (data.hood || []).filter(r => r[1] != null && r[1] !== "-" && r[1] !== "");
  if (hood.length){
    text(p2, "Under the hood", M, y - 8, { f: F.d7, size: 16 });
    text(p2, "The numbers, explained", W - M, y - 6, { size: 8.5, color: C.muted, align: "right" });
    y -= 30;
    label(p2, "Metric", M, y); label(p2, "Result", M + 200, y, { align: "right" }); label(p2, "What it means", M + 224, y);
    y -= 8;
    hood.forEach(([name, val, means]) => {
      hr(p2, M, W - M, y, C.line, 0.5);
      y -= 18;
      text(p2, name, M, y, { f: F.sb, size: 9.5 });
      text(p2, val, M + 200, y, { f: F.b, size: 9.5, align: "right" });
      text(p2, means, M + 224, y, { size: 9, color: C.muted, maxWidth: W - M - (M + 224) });
      y -= 8;
    });
  }

  pdf.setTitle(`Mr Priceless Report - ${data.clientName || ""} - ${data.periodLabel}`);
  pdf.setAuthor("Mr Priceless");
  return pdf.save();
}

window.MPReportPDF = { build };
})();
