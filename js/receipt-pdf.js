/* Mr Priceless CRM - client receipt PDF.
   One A4 page in the light report style. It doubles as the tax invoice
   (taxable supply information): who it's from with our GST number, who
   paid, the date issued, what it was for and the service period, what's
   included, the GST and the total, and how and when it was paid.
   window.MPReceiptPDF.build(data) -> Promise<Uint8Array>, where data is
   put together by app.js:
     { number, issuedLabel, paidLabel, paidMethod, reference, periodLabel,
       business: { name, gst, nzbn, address, email, phone, website },
       client: { name, contact, email, address },
       items: [{ desc, sub, qty, unit }], included: [string], gstRate, notes }
   Amounts on the items are excl. GST. */
(function(){
"use strict";

const money2 = (v) => "$" + (Number(v) || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function totals(items, gstRate){
  const round = (n) => Math.round(n * 100) / 100;
  const subtotal = round((items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit) || 0), 0));
  const gst = round(subtotal * (gstRate || 0));
  return { subtotal, gst, total: round(subtotal + gst) };
}

async function build(data){
  const R = window.MPReportPDF;
  const C = R.LIGHT, { W, H, M, hex } = R;
  const { pdf, F, text, label, wrap, box, hr, tick, drawLogo } = await R.makeKit({ palette: C });
  const biz = data.business || {}, client = data.client || {};
  const items = (data.items || []).filter(it => it.desc || Number(it.unit));
  const included = (data.included || []).filter(Boolean);
  const t = totals(items, data.gstRate);
  const CW = W - 2 * M;
  const page = pdf.addPage([W, H]);
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(C.bg) });
  // A thin gold band across the very top.
  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: hex(C.gold) });

  /* Header: logo and our details left, the receipt number right */
  drawLogo(page, M, H - 78, 40);
  const fromLines = [
    biz.name || "Mr Priceless",
    ...String(biz.address || "").split(/\n+/),
    [biz.email, biz.phone].filter(Boolean).join("  ·  "),
    biz.website || "mrpriceless.com",
  ].filter(s => s && s.trim());
  fromLines.forEach((ln, i) => text(page, ln, M, H - 98 - i * 12, { f: i ? F.r : F.sb, size: i ? 8.5 : 9.5, color: i ? C.muted : C.text, maxWidth: 270 }));
  label(page, "Tax invoice  ·  Receipt", W - M, H - 52, { align: "right", color: C.gold, size: 7.2, ls: 1.6 });
  text(page, data.number, W - M, H - 82, { f: F.d8, size: 26, align: "right" });
  const ids = [biz.gst && `GST number ${biz.gst}`, biz.nzbn && `NZBN ${biz.nzbn}`, data.issuedLabel && `Issued ${data.issuedLabel}`].filter(Boolean);
  ids.forEach((s, i) => text(page, s, W - M, H - 98 - i * 12, { size: 8.5, color: C.muted, align: "right" }));
  const pw = 70, px = W - M - pw, py = H - 98 - ids.length * 12 - 12;
  box(page, px, py, pw, 20, { fill: "#e6f2ea", stroke: "#a9d1b6", r: 10 });
  tick(page, px + 15, py + 10, 8, C.good);
  text(page, "PAID", px + 27, py + 6.6, { f: F.b, size: 8.5, ls: 1.4, color: C.good });
  const lineY = Math.min(H - 98 - (fromLines.length - 1) * 12 - 18, py - 16);
  hr(page, M, W - M, lineY, C.gold2, 0.9);
  let y = lineY - 22;

  /* Who paid, the payment, and the amount */
  const toLines = [client.contact, client.email, ...String(client.address || "").split(/\n+/)].filter(s => s && s.trim()).slice(0, 4);
  const heroH = 128, heroY = y - heroH;
  box(page, M, heroY, CW, heroH, { fill: C.panel, stroke: C.line });
  const leftW = CW * 0.38;
  label(page, "Received from", M + 20, heroY + heroH - 24);
  text(page, client.name || "Client", M + 20, heroY + heroH - 45, { f: F.d7, size: 15, maxWidth: leftW - 26 });
  toLines.forEach((ln, i) => text(page, ln, M + 20, heroY + heroH - 63 - i * 12, { size: 8.8, color: C.soft, maxWidth: leftW - 26 }));
  const facts = [["Payment received", data.paidLabel], ["Paid by", [data.paidMethod || "Card", data.reference].filter(Boolean).join("  ·  ")], ["Service period", data.periodLabel]].filter(f => f[1]);
  const fx = M + leftW, factW = CW * 0.3;
  facts.forEach(([l, v], i) => {
    label(page, l, fx, heroY + heroH - 24 - i * 32, { size: 6.2 });
    text(page, v, fx, heroY + heroH - 38 - i * 32, { f: F.sb, size: 9.5, maxWidth: factW - 12 });
  });
  const ax = fx + factW, aw = M + CW - ax - 12;
  box(page, ax, heroY + 12, aw, heroH - 24, { fill: C.tint, stroke: C.gold3, r: 8 });
  label(page, "Amount paid", ax + aw / 2, heroY + heroH - 42, { align: "center", color: C.gold });
  text(page, money2(t.total), ax + aw / 2, heroY + heroH - 74, { f: F.d8, size: 22, align: "center", maxWidth: aw - 16 });
  text(page, "NZD incl. GST  ·  Balance $0.00", ax + aw / 2, heroY + heroH - 90, { size: 7.8, color: C.muted, align: "center", maxWidth: aw - 12 });
  y = heroY - 28;

  /* What they paid for */
  const cQty = M + CW * 0.64, cUnit = M + CW * 0.81, cAmt = W - M - 14;
  box(page, M, y - 24, CW, 24, { fill: C.panel2, r: 6 });
  label(page, "Description", M + 14, y - 15);
  label(page, "Qty", cQty, y - 15, { align: "right" });
  label(page, "Price excl. GST", cUnit, y - 15, { align: "right" });
  label(page, "Amount", cAmt, y - 15, { align: "right" });
  y -= 24;
  items.forEach(it => {
    const lines = wrap(F.sb, it.desc || "", 10, CW * 0.54);
    const sub = it.sub ? wrap(F.r, it.sub, 8.5, CW * 0.54) : [];
    const ty = y - 20;
    lines.forEach((ln, j) => text(page, ln, M + 14, ty - j * 13, { f: F.sb, size: 10 }));
    sub.forEach((ln, j) => text(page, ln, M + 14, ty - lines.length * 13 - j * 11 + 1, { size: 8.5, color: C.muted }));
    text(page, String(Number(it.qty) || 0), cQty, ty, { size: 10, align: "right" });
    text(page, money2(it.unit), cUnit, ty, { size: 10, align: "right" });
    text(page, money2((Number(it.qty) || 0) * (Number(it.unit) || 0)), cAmt, ty, { f: F.sb, size: 10, align: "right" });
    y -= 18 + lines.length * 13 + sub.length * 11;
    hr(page, M, W - M, y);
  });

  /* What's included (left) and the totals (right) */
  y -= 20;
  const tx = M + CW * 0.56, tw = W - M - tx, topY = y;
  if (included.length){
    const iw = tx - M - 24;
    const rows = included.map(s => wrap(F.r, s, 9.5, iw - 50));
    const ih = rows.reduce((s, l) => s + l.length * 13 + 9, 0) + 50;
    box(page, M, topY - ih + 2, iw, ih, { fill: C.panel, stroke: C.gold3, r: 10 });
    label(page, "What's included", M + 16, topY - 18, { color: C.gold });
    let iy = topY - 40;
    rows.forEach(lines => {
      page.drawCircle({ x: M + 24, y: iy + 3.2, size: 6.5, color: hex(C.tint), borderColor: hex(C.gold2), borderWidth: 0.8 });
      tick(page, M + 24, iy + 3.2, 5.4, C.gold);
      lines.forEach((ln, j) => text(page, ln, M + 38, iy - j * 13, { size: 9.5, color: C.soft }));
      iy -= lines.length * 13 + 9;
    });
    y = Math.min(y, topY - ih - 8);
  }
  let ry = topY;
  const tRow = (l, v, o = {}) => {
    text(page, l, tx + 14, ry, { size: 9.5, color: C.soft, ...o });
    text(page, v, cAmt, ry, { size: 9.5, align: "right", ...o });
    ry -= 18;
  };
  tRow("Subtotal excl. GST", money2(t.subtotal));
  tRow(`GST ${Math.round((data.gstRate || 0) * 100)}%`, money2(t.gst));
  ry -= 4;
  box(page, tx, ry - 14, tw, 30, { fill: C.gold, r: 7 });
  text(page, "Total incl. GST", tx + 14, ry - 3, { f: F.b, size: 10.5, color: C.onGold });
  text(page, money2(t.total), cAmt, ry - 3.5, { f: F.d8, size: 13, color: C.onGold, align: "right" });
  ry -= 36;
  tRow("Amount paid", money2(t.total), { f: F.sb });
  tRow("Balance owing", "$0.00", { color: C.good, f: F.sb });
  y = Math.min(y, ry) - 26;

  /* Thank you */
  const noteLines = data.notes ? wrap(F.r, data.notes, 9.5, CW - 40).slice(0, 3) : [];
  const panelH = 70 + noteLines.length * 13, panelY = Math.max(56, y - panelH);
  box(page, M, panelY, CW, panelH, { fill: C.panel, stroke: C.line });
  label(page, "Thank you", M + 20, panelY + panelH - 24, { color: C.gold });
  text(page, `Thanks for your payment of ${money2(t.total)}. We appreciate you backing us.`, M + 20, panelY + panelH - 43, { f: F.sb, size: 10.5, maxWidth: CW - 40 });
  text(page, "This receipt is your tax invoice for GST purposes. Keep it for your records.", M + 20, panelY + panelH - 58, { size: 9, color: C.muted, maxWidth: CW - 40 });
  noteLines.forEach((ln, i) => text(page, ln, M + 20, panelY + panelH - 76 - i * 13, { size: 9.5, color: C.soft }));

  /* Footer */
  hr(page, M, W - M, 42, C.line);
  text(page, [biz.name || "Mr Priceless", biz.gst ? `GST ${biz.gst}` : "", biz.website || "mrpriceless.com"].filter(Boolean).join("  ·  "), M, 28, { size: 7.5, color: C.dim, maxWidth: 380 });
  text(page, `Receipt ${data.number}  ·  Page 1 of 1`, W - M, 28, { size: 7.5, color: C.dim, align: "right" });

  pdf.setTitle(`Mr Priceless Receipt ${data.number} - ${client.name || ""}`);
  pdf.setAuthor(biz.name || "Mr Priceless");
  return pdf.save();
}

window.MPReceiptPDF = { build, totals };
})();
