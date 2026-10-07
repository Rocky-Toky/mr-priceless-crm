/* Mr Priceless CRM - fortnightly finance report PDF.
   Draws the client report (black and gold, two A4 pages) with pdf-lib, from
   a plain data object put together by app.js. Nothing here reads CRM state.
   window.MPReportPDF.build(data) -> Promise<Uint8Array>. Needs window.PDFLib
   and window.fontkit loaded first (app.js loads both from assets/vendor). */
(function(){
"use strict";

const W = 595.28, H = 841.89, M = 42;
const C = {
  bg: "#0b0b0c", panel: "#141416", panel2: "#1b1b1e", line: "#2c2a25",
  gold: "#e8c468", goldDeep: "#c9a13e", text: "#f4f0e6", muted: "#9d9a93", dim: "#6f6b63",
  good: "#7fc79a",
};
const FONT_FILES = {
  body400: "assets/fonts/figtree-400.ttf", body600: "assets/fonts/figtree-600.ttf", body700: "assets/fonts/figtree-700.ttf",
  ext400: "assets/fonts/figtree-ext-400.ttf", ext600: "assets/fonts/figtree-ext-600.ttf", ext700: "assets/fonts/figtree-ext-700.ttf",
  serif: "assets/fonts/cormorant-600.ttf", serifExt: "assets/fonts/cormorant-ext-600.ttf",
};

function hex(h){ const { rgb } = window.PDFLib; return rgb(parseInt(h.slice(1,3),16)/255, parseInt(h.slice(3,5),16)/255, parseInt(h.slice(5,7),16)/255); }
const money = (v) => v == null || v === "" || isNaN(v) ? "-" : "$" + Math.round(Number(v)).toLocaleString("en-NZ");
const money2 = (v) => v == null || v === "" || isNaN(v) ? "-" : "$" + Number(v).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => v == null || v === "" || isNaN(v) ? "-" : Number(v).toLocaleString("en-NZ");
const times = (v) => v == null || !isFinite(v) ? "-" : (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + "×";
const pct = (a, b) => b ? Math.round(a / b * 100) + "%" : "-";

async function build(data){
  const { PDFDocument } = window.PDFLib;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(window.fontkit);
  const bytes = await Promise.all(Object.entries(FONT_FILES).map(async ([k, url]) => {
    const r = await fetch(url + "?v=1"); if (!r.ok) throw new Error("Couldn't load the report fonts.");
    return [k, await r.arrayBuffer()];
  }));
  const raw = Object.fromEntries(bytes);
  const pair = async (main, ext) => {
    // Alternate glyphs (e.g. a bracketed "$", a long "q") throw the spacing out in PDF viewers, so plain shapes only.
    const opt = { subset: true, features: { calt: false, liga: false, rvrn: false, rlig: false } };
    const m = await pdf.embedFont(raw[main], opt), x = await pdf.embedFont(raw[ext], opt);
    return { m, x, mSet: new Set(m.getCharacterSet()), xSet: new Set(x.getCharacterSet()) };
  };
  const F = { r: await pair("body400", "ext400"), sb: await pair("body600", "ext600"), b: await pair("body700", "ext700"), serif: await pair("serif", "serifExt") };

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
  const width = (f, text, size, ls = 0) => runs(f, text).reduce((w, r) => w + r.font.widthOfTextAtSize(r.s, size), 0) + ls * Math.max(0, [...String(text)].length - 1);
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
  const label = (page, str, x, y, o = {}) => text(page, str, x, y, { f: F.sb, size: 6.8, ls: 1.25, caps: true, color: C.muted, ...o });
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
  const para = (page, str, x, y, maxW, o = {}) => {
    const f = o.f || F.r, size = o.size || 10, lh = o.lh || size * 1.5;
    const lines = wrap(f, str, size, maxW);
    lines.forEach((ln, i) => text(page, ln, x, y - i * lh, { f, size, color: o.color || C.text }));
    return lines.length * lh;
  };
  const box = (page, x, y, w, h, o = {}) => {
    const r = o.r ?? 8;
    const path = `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
    page.drawSvgPath(path, { x, y: y + h, color: o.fill ? hex(o.fill) : undefined, borderColor: o.stroke ? hex(o.stroke) : undefined, borderWidth: o.stroke ? (o.bw || 0.8) : 0 });
  };
  const hr = (page, x1, x2, y, color = C.line, t = 0.7) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: t, color: hex(color) });

  const newPage = (n) => {
    const page = pdf.addPage([W, H]);
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(C.bg) });
    text(page, "MR. PRICELESS", M, H - 52, { f: F.sb, size: 12.5, ls: 2.6 });
    label(page, "Fortnightly report", W - M, H - 46, { align: "right", color: C.gold, size: 7, ls: 1.4 });
    text(page, `Report ${data.reportNumber} · ${data.periodLabel}`, W - M, H - 59, { align: "right", size: 8.5, color: C.muted });
    hr(page, M, W - M, H - 72, C.goldDeep, 0.8);
    hr(page, M, W - M, 40, C.line);
    text(page, n === 1 ? "mrpriceless.com" : `Questions? ${[data.contactName, data.contactPhone].filter(Boolean).join(" · ") || "Your account manager"} · mrpriceless.com`, M, 26, { size: 7.5, color: C.dim, maxWidth: 380 });
    text(page, `Confidential · Page ${n} of 2`, W - M, 26, { size: 7.5, color: C.dim, align: "right" });
    return page;
  };

  /* ───────── Page 1: the money ───────── */
  const p1 = newPage(1);
  let y = H - 104;
  label(p1, "Prepared for", M, y);
  text(p1, data.clientName || "Client", M, y - 34, { f: F.serif, size: 32, maxWidth: W - 2 * M });
  y -= 62;

  // Hero: revenue this fortnight + return.
  const heroH = 150, heroY = y - heroH;
  box(p1, M, heroY, W - 2 * M, heroH, { fill: C.panel, stroke: C.line });
  const splitX = M + (W - 2 * M) * 0.6;
  label(p1, "Revenue won this fortnight", M + 22, heroY + heroH - 30);
  text(p1, money(data.revenueFortnight), M + 22, heroY + heroH - 84, { f: F.serif, size: 52, color: C.gold });
  const jobs = Number(data.jobsFortnight) || 0;
  text(p1, jobs ? `${jobs} job${jobs === 1 ? "" : "s"} signed from enquiries our ads brought in` : "No jobs signed this fortnight yet", M + 22, heroY + heroH - 104, { size: 9.5, color: C.muted, maxWidth: splitX - M - 40 });
  hr(p1, M + 22, splitX - 20, heroY + 42, C.line);
  label(p1, "Revenue won to date", M + 22, heroY + 26, { size: 6.4 });
  text(p1, money(data.revenueToDate), M + 22, heroY + 11, { f: F.b, size: 11.5 });
  label(p1, "Quotes still open", M + 150, heroY + 26, { size: 6.4 });
  text(p1, `${money(data.openQuotesValue)}${data.openQuotesCount ? `  ·  ${num(data.openQuotesCount)}` : ""}`, M + 150, heroY + 11, { f: F.b, size: 11.5 });
  p1.drawLine({ start: { x: splitX, y: heroY + 18 }, end: { x: splitX, y: heroY + heroH - 18 }, thickness: 0.7, color: hex(C.line) });
  label(p1, "Return to date", splitX + 22, heroY + heroH - 30);
  text(p1, times(data.roiToDate), splitX + 22, heroY + heroH - 78, { f: F.serif, size: 40 });
  text(p1, "back for every $1 invested", splitX + 22, heroY + heroH - 96, { size: 9, color: C.muted });
  if (data.since) text(p1, `since ${data.since}`, splitX + 22, heroY + heroH - 109, { size: 8, color: C.dim });
  y = heroY - 18;

  // The money table.
  const rows = [
    ["Revenue won", money(data.revenueFortnight), money(data.revenueToDate), C.gold],
    ["Ad spend", money(data.adSpendFortnight), data.adSpendToDate ? money(data.adSpendToDate) : "-"],
    ["Management", money(data.mgmtFortnight), data.mgmtToDate ? money(data.mgmtToDate) : "-"],
    ["Total invested", money(data.investedFortnight), money(data.investedToDate), null, true],
    ["Return on investment", times(data.roiFortnight), times(data.roiToDate), C.gold, true],
  ];
  const tH = 34 + rows.length * 26, tY = y - tH;
  box(p1, M, tY, W - 2 * M, tH, { fill: C.panel, stroke: C.line });
  text(p1, "The money", M + 22, tY + tH - 26, { f: F.serif, size: 17 });
  const c1 = W - M - 170, c2 = W - M - 22;
  label(p1, "This fortnight", c1, tY + tH - 24, { align: "right" });
  label(p1, "To date", c2, tY + tH - 24, { align: "right" });
  rows.forEach(([name, a, b, color, strong], i) => {
    const ry = tY + tH - 52 - i * 26;
    hr(p1, M + 22, W - M - 22, ry + 17, C.line, 0.5);
    text(p1, name, M + 22, ry, { f: strong ? F.sb : F.r, size: 10, color: strong ? C.text : "#d9d4c8" });
    text(p1, a, c1, ry, { f: F.b, size: 10.5, color: color || C.text, align: "right" });
    text(p1, b, c2, ry, { f: F.b, size: 10.5, color: color || C.text, align: "right" });
  });
  y = tY - 18;

  // Enquiry to signed job, as four steps.
  const steps = [["Enquiries", data.enquiries], ["Quote-ready", data.quoteReady], ["Quoted", data.quoted], ["Won", data.won]];
  const haveFunnel = steps.some(s => s[1] != null && s[1] !== "");
  if (haveFunnel){
    const fH = 104, fY = y - fH;
    box(p1, M, fY, W - 2 * M, fH, { fill: C.panel, stroke: C.line });
    text(p1, "From enquiry to signed job", M + 22, fY + fH - 26, { f: F.serif, size: 17 });
    label(p1, "This fortnight", W - M - 22, fY + fH - 24, { align: "right" });
    const cw = (W - 2 * M - 44) / 4;
    steps.forEach(([name, v], i) => {
      const cx = M + 22 + i * cw;
      const isWon = i === 3;
      const nw = text(p1, num(v), cx, fY + 30, { f: F.serif, size: 30, color: isWon ? C.gold : C.text });
      label(p1, name, cx, fY + 16, { size: 6.6, color: isWon ? C.gold : C.muted });
      if (i > 0){
        const prev = Number(steps[i-1][1]), cur = Number(v);
        const rate = prev && v !== "" && v != null && !isNaN(cur) ? pct(cur, prev) : "";
        if (rate) text(p1, rate, cx + nw + 6, fY + 31, { f: F.sb, size: 8.5, color: C.muted });
      }
    });
    y = fY - 18;
  }

  // Lead guarantee, when they're on one.
  if (data.guaranteeTarget){
    const gH = 66, gY = y - gH;
    const got = Number(data.guaranteeDelivered) || 0, target = Number(data.guaranteeTarget);
    box(p1, M, gY, W - 2 * M, gH, { fill: C.panel, stroke: C.line });
    label(p1, `${data.guaranteeLabel || "Quote guarantee"}`, M + 22, gY + gH - 22);
    text(p1, `${num(got)} of ${num(target)} delivered${got >= target ? " · guarantee met" : ""}`, M + 22, gY + gH - 38, { f: F.sb, size: 10.5 });
    text(p1, pct(got, target), W - M - 22, gY + gH - 38, { f: F.serif, size: 22, color: C.gold, align: "right" });
    const bx = M + 22, bw = W - 2 * M - 44, by = gY + 14;
    box(p1, bx, by, bw, 6, { fill: C.panel2, r: 3 });
    box(p1, bx, by, Math.max(6, Math.min(1, got / target) * bw), 6, { fill: C.gold, r: 3 });
  }

  /* ───────── Page 2: what happened and what's next ───────── */
  const p2 = newPage(2);
  y = H - 108;
  text(p2, "This fortnight in plain English", M, y, { f: F.serif, size: 22 });
  y -= 22;
  if (data.summary){ y -= para(p2, data.summary, M, y, W - 2 * M, { size: 10.5, lh: 15.5, color: "#e4dfd3" }); y -= 10; }
  const did = (data.didList || []).filter(Boolean), next = (data.nextList || []).filter(Boolean);
  if (did.length || next.length){
    const colW = (W - 2 * M - 24) / 2;
    const col = (title, items, x) => {
      label(p2, title, x, y, { color: C.gold });
      hr(p2, x, x + colW, y - 8, C.line);
      let cy = y - 26;
      items.forEach((it, i) => {
        text(p2, String(i + 1).padStart(2, "0"), x, cy, { f: F.serif, size: 13, color: C.gold });
        const lines = wrap(F.r, it, 9.5, colW - 30);
        lines.forEach((ln, j) => text(p2, ln, x + 30, cy - j * 13.5, { size: 9.5, color: "#e4dfd3" }));
        cy -= Math.max(1, lines.length) * 13.5 + 9;
      });
      return cy;
    };
    const endA = col("What we did", did, M), endB = col("What's next", next, M + colW + 24);
    y = Math.min(endA, endB) - 6;
  }

  // Top performing ad.
  if (data.topAd){
    const aH = 168, aY = y - aH;
    box(p2, M, aY, W - 2 * M, aH, { fill: C.panel, stroke: C.line });
    const imgS = aH - 32, ix = M + 16, iy = aY + 16;
    let drew = false;
    if (data.topAd.imageBytes){
      try {
        const isPng = data.topAd.imageType === "png";
        const img = isPng ? await pdf.embedPng(data.topAd.imageBytes) : await pdf.embedJpg(data.topAd.imageBytes);
        const scale = Math.max(imgS / img.width, imgS / img.height);
        const dw = img.width * scale, dh = img.height * scale;
        // Draw centred and clipped to a square.
        p2.pushOperators(window.PDFLib.pushGraphicsState(), window.PDFLib.rectangle(ix, iy, imgS, imgS), window.PDFLib.clip(), window.PDFLib.endPath());
        p2.drawImage(img, { x: ix + (imgS - dw) / 2, y: iy + (imgS - dh) / 2, width: dw, height: dh });
        p2.pushOperators(window.PDFLib.popGraphicsState());
        drew = true;
      } catch(e){}
    }
    if (!drew){ box(p2, ix, iy, imgS, imgS, { fill: C.panel2, r: 6 }); text(p2, "Ad creative", ix + imgS / 2, iy + imgS / 2 - 3, { size: 8.5, color: C.dim, align: "center" }); }
    const tx = ix + imgS + 22, tw = W - M - 22 - tx;
    label(p2, "Top performing ad", tx, aY + aH - 30, { color: C.gold });
    const nameLines = wrap(F.serif, data.topAd.name || "", 18, tw).slice(0, 2);
    nameLines.forEach((ln, i) => text(p2, ln, tx, aY + aH - 54 - i * 20, { f: F.serif, size: 18 }));
    const stats = [[num(data.topAd.leads), "leads"], [money2(data.topAd.cpl), "per lead"], [data.topAd.share != null ? data.topAd.share + "%" : "-", "of all leads"]];
    const sw = tw / 3;
    stats.forEach(([v, l], i) => {
      text(p2, v, tx + i * sw, aY + 40, { f: F.serif, size: 20, color: C.gold });
      text(p2, l, tx + i * sw, aY + 26, { size: 8.5, color: C.muted });
    });
    y = aY - 18;
  }

  // Under the hood.
  const hood = (data.hood || []).filter(r => r[1] != null && r[1] !== "-" && r[1] !== "");
  if (hood.length){
    text(p2, "Under the hood", M, y - 8, { f: F.serif, size: 17 });
    text(p2, "The numbers behind it", W - M, y - 6, { size: 8.5, color: C.muted, align: "right" });
    y -= 30;
    label(p2, "Metric", M, y); label(p2, "Result", M + 190, y, { align: "right" }); label(p2, "What it means", M + 214, y);
    y -= 8;
    hood.forEach(([name, val, means]) => {
      hr(p2, M, W - M, y, C.line, 0.5);
      y -= 18;
      text(p2, name, M, y, { f: F.sb, size: 9.5 });
      text(p2, val, M + 190, y, { f: F.b, size: 9.5, align: "right" });
      text(p2, means, M + 214, y, { size: 9, color: C.muted, maxWidth: W - M - (M + 214) });
      y -= 8;
    });
  }

  pdf.setTitle(`Mr Priceless Fortnightly Report - ${data.clientName || ""}`.trim());
  pdf.setAuthor("Mr Priceless");
  return pdf.save();
}

window.MPReportPDF = { build };
})();
