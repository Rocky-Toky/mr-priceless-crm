/* Mr Priceless CRM - workshop summary PDF, for the client.
   Made when a workshop is logged: what the session covered, where their
   numbers stand, what we found, the plan from here, who's doing what, and
   when we'll catch up next. Same black and gold as the performance report
   and 90-day plan, built with the report's drawing kit.
   window.MPWorkshopPDF.build(data) -> Promise<Uint8Array>. */
(function(){
"use strict";

async function build(data){
  const R = window.MPReportPDF;
  const { C, W, H, M, hex } = R;
  const { pdf, F, width, text, label, wrap, box, hr, drawLogo } = await R.makeKit();
  const CW = W - 2 * M, BOTTOM = 62;
  const pages = [];

  const newPage = () => {
    const page = pdf.addPage([W, H]);
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(C.bg) });
    drawLogo(page, M, H - 64, 34);
    label(page, "Workshop summary", W - M, H - 44, { align: "right", color: C.gold, size: 7, ls: 1.6 });
    text(page, `${data.workshopLabel} · ${data.dateLabel}`, W - M, H - 57, { align: "right", size: 8.5, color: C.muted });
    hr(page, M, W - M, H - 70, C.gold2, 0.9);
    hr(page, M, W - M, 42, C.line);
    text(page, `Questions? ${[data.contactName, data.contactPhone].filter(Boolean).join(" · ") || "Your account manager"} · mrpriceless.com`, M, 28, { size: 7.5, color: C.dim, maxWidth: 400 });
    pages.push(page);
    return page;
  };
  let page = newPage(), y = H - 96;
  // Start a new page when the next block won't fit.
  const room = (h) => { if (y - h < BOTTOM){ page = newPage(); y = H - 100; } };
  const heading = (t, sub) => {
    room(60);
    text(page, t, M, y, { f: F.d7, size: 17 });
    if (sub) text(page, sub, W - M, y + 2, { size: 8.5, color: C.muted, align: "right", maxWidth: 260 });
    y -= 22;
  };

  /* Who it's for, and the session */
  label(page, "Prepared for", M, y);
  text(page, data.clientName || "Client", M, y - 32, { f: F.d7, size: 28, maxWidth: CW });
  y -= 56;
  const goal = wrap(F.r, data.outcome || "", 10, CW - 44).slice(0, 4);
  const heroH = goal.length ? 162 + (goal.length - 1) * 14 : 100;
  const heroY = y - heroH;
  box(page, M, heroY, CW, heroH, { fill: C.panel, stroke: C.gold3, bw: 1 });
  label(page, "Your workshop", M + 22, heroY + heroH - 28, { color: C.gold });
  text(page, data.workshopTitle, M + 22, heroY + heroH - 58, { f: F.d7, size: 24, maxWidth: CW - 44 });
  const facts = [["Date", data.dateLabel], ["Run by", data.runBy || "Mr Priceless"], ["Next catch-up", data.nextLabel || "Next month"]];
  const fy = heroY + heroH - 84;
  facts.forEach(([l, v], i) => {
    const x = M + 22 + i * ((CW - 44) / 3);
    label(page, l, x, fy, { size: 6.2 });
    text(page, v || "-", x, fy - 15, { f: F.b, size: 10.5, maxWidth: (CW - 44) / 3 - 10 });
  });
  if (goal.length){
    hr(page, M + 22, W - M - 22, fy - 28);
    label(page, "What this session was for", M + 22, fy - 44, { size: 6.2 });
    goal.forEach((ln, i) => text(page, ln, M + 22, fy - 60 - i * 14, { size: 10, color: C.soft }));
  }
  y = heroY - 30;

  /* Where things stand */
  const stats = (data.stats || []).filter(s => s.value);
  if (stats.length){
    heading("Where things stand", data.statsAsOf ? `From your ${data.statsAsOf} report` : "");
    const gap = 10, n = stats.length, cw = (CW - gap * (n - 1)) / n, ch = 70;
    room(ch);
    stats.forEach((s, i) => {
      const x = M + i * (cw + gap);
      box(page, x, y - ch, cw, ch, { fill: C.panel, stroke: C.line });
      label(page, s.label, x + 14, y - 20, { size: 6.2, maxWidth: cw - 24 });
      text(page, s.value, x + 14, y - 46, { f: F.d7, size: 20, color: s.gold ? C.gold : C.text, maxWidth: cw - 24 });
      if (s.sub) text(page, s.sub, x + 14, y - 60, { size: 7.5, color: C.muted, maxWidth: cw - 24 });
    });
    y -= ch + 30;
  }

  /* Numbered lists: what we found, the plan */
  const numbered = (items, size, gapAfter) => {
    items.forEach((it, i) => {
      const lines = wrap(F.r, it, size, CW - 40);
      room(lines.length * (size + 4.5) + gapAfter);
      text(page, String(i + 1).padStart(2, "0"), M, y, { f: F.d8, size: size + 1.5, color: C.gold });
      lines.forEach((ln, j) => text(page, ln, M + 32, y - j * (size + 4.5), { size, color: C.soft }));
      y -= lines.length * (size + 4.5) + gapAfter;
    });
  };
  const found = (data.learnings || []).filter(Boolean);
  if (found.length){
    heading("What we found");
    numbered(found, 10.5, 10);
    y -= 14;
  }
  const plan = (data.plan || []).filter(Boolean);
  if (plan.length){
    heading("The plan from here");
    // The plan sits in a gold-edged panel so it reads as the takeaway.
    const items = plan.map(p => wrap(F.sb, p, 11, CW - 70));
    const h = items.reduce((s, l) => s + l.length * 15.5 + 12, 0) + 22;
    room(Math.min(h, H - 200));
    if (h < y - BOTTOM){
      box(page, M, y - h, CW, h, { fill: C.panel, stroke: C.gold3, bw: 1 });
      let py = y - 26;
      items.forEach((lines, i) => {
        page.drawCircle({ x: M + 30, y: py + 4, size: 9, color: hex(C.gold) });
        text(page, String(i + 1), M + 30, py + 0.5, { f: F.b, size: 9, color: C.bg, align: "center" });
        lines.forEach((ln, j) => text(page, ln, M + 50, py - j * 15.5, { f: F.sb, size: 11 }));
        py -= lines.length * 15.5 + 12;
      });
      y -= h + 30;
    } else { numbered(plan, 11, 10); y -= 14; }
  }

  /* Who's doing what */
  const us = (data.usActions || []).filter(Boolean), them = (data.themActions || []).filter(Boolean);
  if (us.length || them.length){
    heading("Who's doing what", "We'll check in on these at the next workshop");
    const colW = (CW - 24) / 2;
    const colH = (items) => items.reduce((s, it) => s + wrap(F.r, it, 9.8, colW - 46).length * 13.5 + 10, 0) + 52;
    const h = Math.max(colH(us), colH(them));
    room(h);
    const col = (title, items, x) => {
      box(page, x, y - h, colW, h, { fill: C.panel, stroke: C.line });
      label(page, title, x + 16, y - 22, { color: C.gold });
      let cy = y - 44;
      if (!items.length) text(page, "Nothing for now", x + 16, cy, { size: 9.5, color: C.dim });
      items.forEach(it => {
        box(page, x + 16, cy - 2.5, 11, 11, { stroke: C.gold3, r: 2.5, bw: 1 });
        const lines = wrap(F.r, it, 9.8, colW - 46);
        lines.forEach((ln, j) => text(page, ln, x + 34, cy - j * 13.5, { size: 9.8, color: C.soft }));
        cy -= lines.length * 13.5 + 10;
      });
    };
    col("What we'll do", us, M);
    col("What you'll do", them, M + colW + 24);
    y -= h + 30;
  }

  /* Next catch-up */
  room(74);
  const nh = 64, ny = y - nh;
  box(page, M, ny, CW, nh, { fill: C.panel, stroke: C.gold3, bw: 1 });
  label(page, "Next workshop", M + 22, ny + nh - 24, { color: C.gold });
  text(page, data.nextWorkshop ? `${data.nextWorkshop}${data.nextLabel ? ` · ${data.nextLabel}` : ""}` : (data.nextLabel || "Next month"), M + 22, ny + nh - 46, { f: F.d7, size: 15, maxWidth: CW - 200 });
  label(page, "Your account manager", W - M - 22, ny + nh - 24, { align: "right" });
  text(page, data.contactName || "Mr Priceless", W - M - 22, ny + nh - 42, { f: F.b, size: 11, align: "right" });
  text(page, [data.contactPhone, "mrpriceless.com"].filter(Boolean).join(" · "), W - M - 22, ny + nh - 55, { size: 8.5, color: C.muted, align: "right" });

  pages.forEach((p, i) => text(p, `Confidential · Page ${i + 1} of ${pages.length}`, W - M, 28, { size: 7.5, color: C.dim, align: "right" }));
  pdf.setTitle(`Mr Priceless Workshop Summary - ${data.clientName || ""} - ${data.dateLabel}`);
  pdf.setAuthor("Mr Priceless");
  return pdf.save();
}

window.MPWorkshopPDF = { build };
})();
