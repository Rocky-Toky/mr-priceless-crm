/* Mr Priceless CRM - 90-day growth plan PDF, for the client.
   Three A4 pages in the same black and gold as the performance report:
   1. the goal, where they are now vs day 90, the 90 days at a glance;
   2. the roadmap, month by month;
   3. every check-in already in the calendar, what we do and what we need.
   Draws from a plain data object put together by app.js and reuses the
   report's fonts and drawing kit. window.MPPlanPDF.build(data) -> Uint8Array. */
(function(){
"use strict";

async function build(data){
  const R = window.MPReportPDF;
  const { C, W, H, M, hex, has, money, num } = R;
  const { pdf, F, width, text, label, wrap, box, hr, vr } = await R.makeKit();
  const CW = W - 2 * M, PAGES = 3;
  // Big numbers in the cards are kept short: $18.4k rather than $18,400.
  const short = (v) => { const n = Number(v); return n >= 1e6 ? "$" + +(n / 1e6).toFixed(1) + "m" : n >= 1e4 ? "$" + +(n / 1e3).toFixed(1) + "k" : money(n); };
  const fmt = (v, kind) => !has(v) ? "-" : kind === "money" ? short(v) : num(v);

  const newPage = (n) => {
    const page = pdf.addPage([W, H]);
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(C.bg) });
    text(page, "MR. PRICELESS", M, H - 50, { f: F.d8, size: 14, ls: 3 });
    label(page, "90-day growth plan", W - M, H - 44, { align: "right", color: C.gold, size: 7, ls: 1.6 });
    text(page, `Plan ${data.planNumber} · ${data.rangeLabel}`, W - M, H - 57, { align: "right", size: 8.5, color: C.muted });
    hr(page, M, W - M, H - 70, C.gold2, 0.9);
    hr(page, M, W - M, 42, C.line);
    text(page, `Questions? ${[data.contactName, data.contactPhone].filter(Boolean).join(" · ") || "Your account manager"} · mrpriceless.com`, M, 28, { size: 7.5, color: C.dim, maxWidth: 400 });
    text(page, `Confidential · Page ${n} of ${PAGES}`, W - M, 28, { size: 7.5, color: C.dim, align: "right" });
    return page;
  };
  const arrow = (page, x, y, len, color) => {
    page.drawLine({ start: { x, y }, end: { x: x + len, y }, thickness: 1.2, color: hex(color) });
    page.drawSvgPath(`M ${len - 5} -4 L ${len} 0 L ${len - 5} 4`, { x, y, borderColor: hex(color), borderWidth: 1.2 });
  };
  const flag = (page, x, y, s, color) => {
    page.drawLine({ start: { x, y }, end: { x, y: y + s }, thickness: 1.1, color: hex(color) });
    page.drawSvgPath(`M 0 0 L ${s * 0.75} ${s * 0.2} L 0 ${s * 0.4} Z`, { x, y: y + s, color: hex(color) });
  };
  const shades = [C.gold3, C.gold2, C.gold];
  const months = data.months || [];

  /* ───────── Page 1: the goal and the 90 days at a glance ───────── */
  const p1 = newPage(1);
  label(p1, "Prepared for", M, H - 96);
  text(p1, data.clientName || "Client", M, H - 128, { f: F.d7, size: 28, maxWidth: CW });

  const goalLines = wrap(F.d7, data.goal || "", 22, CW - 44).slice(0, 3);
  const heroH = 104 + goalLines.length * 27, heroY = H - 150 - heroH;
  box(p1, M, heroY, CW, heroH, { fill: C.panel, stroke: C.gold3, bw: 1 });
  label(p1, "Our goal for the next 90 days", M + 22, heroY + heroH - 28, { color: C.gold });
  goalLines.forEach((ln, i) => text(p1, ln, M + 22, heroY + heroH - 60 - i * 27, { f: F.d7, size: 22 }));
  hr(p1, M + 22, W - M - 22, heroY + 52);
  const facts = [["Starts", data.startLabel], ["Day 90", data.endLabel], ["Check-ins", data.checkinsLabel]];
  facts.forEach(([l, v], i) => {
    const x = M + 22 + i * ((CW - 44) / 3);
    label(p1, l, x, heroY + 34, { size: 6.4 });
    text(p1, v || "-", x, heroY + 16, { f: F.d7, size: 12, maxWidth: (CW - 44) / 3 - 12 });
  });

  let y = heroY - 34;
  text(p1, "Where you are, and where we're heading", M, y, { f: F.d7, size: 16 });
  const metrics = (data.metrics || []).filter(m => has(m.now) || has(m.target)).slice(0, 3);
  if (metrics.length){
    const cardH = 92, cardY = y - 16 - cardH, gap = 12, cardW = (CW - gap * (metrics.length - 1)) / metrics.length;
    metrics.forEach((m, i) => {
      const x = M + i * (cardW + gap);
      box(p1, x, cardY, cardW, cardH, { fill: C.panel, stroke: C.line });
      label(p1, m.label, x + 16, cardY + cardH - 24, { size: 6.4, maxWidth: cardW - 30 });
      const half = cardW / 2;
      label(p1, "Now", x + 16, cardY + 46, { size: 6 });
      text(p1, has(m.now) ? fmt(m.now, m.kind) : "New", x + 16, cardY + 24, { f: F.d7, size: 15, color: C.soft, maxWidth: half - 24 });
      arrow(p1, x + half - 14, cardY + 30, 18, C.gold3);
      label(p1, "Day 90", x + half + 12, cardY + 46, { size: 6, color: C.gold });
      text(p1, fmt(m.target, m.kind), x + half + 12, cardY + 22, { f: F.d8, size: 22, color: C.gold, maxWidth: half - 24 });
      if (m.note) text(p1, m.note, x + 16, cardY + 9, { size: 7, color: C.muted, maxWidth: cardW - 30 });
    });
    y = cardY - 34;
  } else y -= 24;

  // The 90 days as one bar, split into the three months, with every check-in marked.
  text(p1, "Your 90 days at a glance", M, y, { f: F.d7, size: 16 });
  y -= 16;
  const barH = 30, barY = y - barH, segGap = 4, segW = (CW - segGap * 2) / 3;
  months.slice(0, 3).forEach((mo, i) => {
    const x = M + i * (segW + segGap);
    box(p1, x, barY, segW, barH, { fill: shades[i], r: 6 });
    text(p1, `Month ${i + 1} · ${mo.theme || ""}`, x + 12, barY + 11, { f: F.b, size: 9.5, color: i ? C.bg : C.text, maxWidth: segW - 24 });
    text(p1, mo.rangeLabel || "", x + 2, barY - 13, { size: 7.8, color: C.muted, maxWidth: segW - 4 });
  });
  const lineY = barY - 36;
  hr(p1, M, W - M, lineY, C.line, 1);
  const dayX = (d) => M + Math.max(0, Math.min(89, d)) / 89 * CW;
  (data.markers || []).forEach(mk => {
    const x = dayX(mk.day);
    if (mk.type === "report") p1.drawCircle({ x, y: lineY, size: 3.4, color: hex(C.panel2), borderColor: hex(C.gold2), borderWidth: 1 });
    else if (mk.type === "workshop") p1.drawCircle({ x, y: lineY, size: 5.5, color: hex(C.gold) });
    else if (mk.type === "review") flag(p1, x, lineY, 12, C.gold);
    else p1.drawCircle({ x, y: lineY, size: 3.4, color: hex(C.text) });
  });
  let lx = M;
  const legend = [["report", "Fortnightly report"], ["workshop", "Monthly workshop"], ["review", "90-day review"]];
  legend.forEach(([t, l]) => {
    const ly = lineY - 22;
    if (t === "report") p1.drawCircle({ x: lx + 4, y: ly + 3, size: 3.4, color: hex(C.panel2), borderColor: hex(C.gold2), borderWidth: 1 });
    else if (t === "workshop") p1.drawCircle({ x: lx + 4, y: ly + 3, size: 4.5, color: hex(C.gold) });
    else flag(p1, lx + 2, ly - 2, 10, C.gold);
    lx += 14 + text(p1, l, lx + 14, ly, { size: 8, color: C.muted }) + 22;
  });

  // The three phases in a line each.
  y = lineY - 62;
  const colW = (CW - 24) / 3;
  months.slice(0, 3).forEach((mo, i) => {
    const x = M + i * (colW + 12);
    hr(p1, x, x + colW, y + 12, shades[i], 1.6);
    text(p1, String(i + 1).padStart(2, "0"), x, y - 10, { f: F.d8, size: 16, color: C.gold });
    text(p1, mo.theme || "", x + 30, y - 9, { f: F.d7, size: 12.5, maxWidth: colW - 30 });
    const room = Math.max(1, Math.floor((y - 32 - 60) / 13));
    wrap(F.r, mo.focus || "", 9, colW).slice(0, Math.min(5, room)).forEach((ln, j) => text(p1, ln, x, y - 30 - j * 13, { size: 9, color: C.soft }));
  });

  /* ───────── Page 2: the roadmap ───────── */
  const p2 = newPage(2);
  y = H - 108;
  text(p2, "The roadmap", M, y, { f: F.d7, size: 21 });
  text(p2, "Month by month: what we're doing and what it should deliver", W - M, y + 2, { size: 8.5, color: C.muted, align: "right" });
  y -= 18;
  const leftW = 150, rx = M + leftW + 26, rw = W - M - 20 - rx;
  const blocks = months.slice(0, 3).map(mo => {
    const focus = wrap(F.r, mo.focus || "", 9.8, rw).slice(0, 3);
    const acts = (mo.actions || []).filter(Boolean).slice(0, 4).map(a => wrap(F.r, a, 9.3, rw - 26).slice(0, 2));
    const mile = wrap(F.sb, mo.milestone || "", 9.3, rw - 92).slice(0, 2);
    const h = 26 + focus.length * 14 + 12 + (acts.length ? 20 + acts.reduce((s, l) => s + l.length * 12.5 + 7, 0) : 0) + (mile.length ? 18 + mile.length * 12.5 + 14 : 0) + 8;
    return { mo, focus, acts, mile, h: Math.max(150, h) };
  });
  const avail = y - 56, need = blocks.reduce((s, b) => s + b.h, 0) + 12 * (blocks.length - 1);
  const stretch = need < avail ? Math.min(24, (avail - need) / Math.max(1, blocks.length)) : 0;
  blocks.forEach((b, i) => {
    const bh = b.h + stretch, by = y - bh;
    box(p2, M, by, CW, bh, { fill: C.panel, stroke: C.line });
    p2.drawRectangle({ x: M, y: by + 12, width: 3, height: bh - 24, color: hex(shades[i]) });
    // Left: the month.
    label(p2, `Month ${i + 1}`, M + 20, by + bh - 28, { color: C.gold });
    const th = wrap(F.d7, b.mo.theme || "", 18, leftW - 10).slice(0, 2);
    th.forEach((ln, j) => text(p2, ln, M + 20, by + bh - 52 - j * 21, { f: F.d7, size: 18 }));
    text(p2, b.mo.rangeLabel || "", M + 20, by + bh - 66 - (th.length - 1) * 21, { size: 8.5, color: C.muted });
    if (b.mo.workshop){
      const wy = by + 18;
      label(p2, "Workshop", M + 20, wy + 30, { size: 6 });
      const pw = Math.min(leftW - 10, width(F.b, b.mo.workshop, 9) + 22);
      box(p2, M + 20, wy + 6, pw, 18, { fill: C.panel2, stroke: C.gold3, r: 9 });
      text(p2, b.mo.workshop, M + 20 + pw / 2, wy + 11.5, { f: F.b, size: 9, color: C.gold, align: "center", maxWidth: pw - 14 });
      text(p2, b.mo.workshopWhen || "", M + 20, wy - 6, { size: 7.8, color: C.muted, maxWidth: leftW - 10 });
    }
    vr(p2, M + leftW + 8, by + 16, by + bh - 16);
    // Right: focus, what we'll do, the milestone.
    let ry = by + bh - 28;
    label(p2, "The focus", rx, ry);
    ry -= 16;
    b.focus.forEach(ln => { text(p2, ln, rx, ry, { size: 9.8, color: C.text }); ry -= 14; });
    ry -= 6;
    if (b.acts.length){
      label(p2, "What we'll do", rx, ry);
      ry -= 17;
      b.acts.forEach((lines, k) => {
        text(p2, String(k + 1).padStart(2, "0"), rx, ry, { f: F.d8, size: 9.5, color: C.gold });
        lines.forEach((ln, j) => text(p2, ln, rx + 24, ry - j * 12.5, { size: 9.3, color: C.soft }));
        ry -= lines.length * 12.5 + 7;
      });
    }
    if (b.mile.length){
      const mh = 14 + b.mile.length * 12.5, my = by + 14;
      box(p2, rx - 8, my, rw + 8, mh, { fill: C.panel2, r: 7 });
      flag(p2, rx + 2, my + mh / 2 - 6, 11, C.gold);
      label(p2, "Milestone", rx + 16, my + mh - 16.5, { color: C.gold, size: 6.4 });
      b.mile.forEach((ln, j) => text(p2, ln, rx + 84, my + mh - 17 - j * 12.5, { f: F.sb, size: 9.3 }));
    }
    y = by - 12;
  });

  /* ───────── Page 3: staying on track ───────── */
  const p3 = newPage(3);
  y = H - 108;
  text(p3, "Staying on track", M, y, { f: F.d7, size: 21 });
  text(p3, "Every check-in, already in the calendar", W - M, y + 2, { size: 8.5, color: C.muted, align: "right" });
  y -= 26;
  label(p3, "Date", M, y); label(p3, "What", M + 96, y); label(p3, "Why it matters", M + 214, y);
  y -= 8;
  const TYPE = { start: ["Kick off", C.text], report: ["Report", C.gold2], workshop: ["Workshop", C.gold], review: ["90-day review", C.gold] };
  (data.calendar || []).forEach(ev => {
    hr(p3, M, W - M, y, C.line, 0.5);
    y -= 17;
    const [t, col] = TYPE[ev.type] || ["", C.soft];
    const strong = ev.type === "workshop" || ev.type === "review";
    text(p3, ev.dateLabel, M, y, { f: F.b, size: 9.5 });
    if (ev.type === "workshop" || ev.type === "review"){
      const pw = width(F.b, t, 8) + 16;
      box(p3, M + 96, y - 4.5, pw, 15, { fill: ev.type === "review" ? C.gold : C.panel2, stroke: ev.type === "review" ? undefined : C.gold3, r: 7.5 });
      text(p3, t, M + 96 + pw / 2, y, { f: F.b, size: 8, color: ev.type === "review" ? C.bg : C.gold, align: "center" });
    } else text(p3, t, M + 96, y, { f: F.sb, size: 9, color: col });
    text(p3, ev.title, M + 214, y, { size: 9, color: strong ? C.text : C.soft, maxWidth: W - M - (M + 214) });
    y -= 8;
  });
  hr(p3, M, W - M, y, C.line, 0.5);

  y -= 34;
  const cw2 = (CW - 24) / 2;
  const listCol = (title, items, x) => {
    label(p3, title, x, y, { color: C.gold });
    hr(p3, x, x + cw2, y - 8);
    let cy = y - 25;
    items.filter(Boolean).forEach(it => {
      p3.drawCircle({ x: x + 4, y: cy + 3.2, size: 2.4, color: hex(C.gold) });
      const lines = wrap(F.r, it, 9.3, cw2 - 18).slice(0, 2);
      lines.forEach((ln, j) => text(p3, ln, x + 16, cy - j * 12.5, { size: 9.3, color: C.soft }));
      cy -= lines.length * 12.5 + 8;
    });
    return cy;
  };
  y = Math.min(listCol("What you can count on from us", data.promises || [], M), listCol("What we need from you", data.needs || [], M + cw2 + 24)) - 14;

  const sH = 74, sY = Math.max(56, y - sH);
  box(p3, M, sY, CW, sH, { fill: C.panel, stroke: C.gold3, bw: 1 });
  text(p3, "Let's make the next 90 days count.", M + 22, sY + sH - 32, { f: F.d7, size: 16 });
  text(p3, "Any questions about the plan, just give us a call.", M + 22, sY + sH - 50, { size: 9.3, color: C.muted });
  label(p3, "Your account manager", W - M - 22, sY + sH - 28, { align: "right", color: C.gold });
  text(p3, data.contactName || "Mr Priceless", W - M - 22, sY + sH - 46, { f: F.b, size: 11, align: "right" });
  text(p3, [data.contactPhone, "mrpriceless.com"].filter(Boolean).join(" · "), W - M - 22, sY + sH - 60, { size: 8.5, color: C.muted, align: "right" });

  pdf.setTitle(`Mr Priceless 90-Day Plan - ${data.clientName || ""} - ${data.rangeLabel}`);
  pdf.setAuthor("Mr Priceless");
  return pdf.save();
}

window.MPPlanPDF = { build };
})();
