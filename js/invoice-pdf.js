/* Mr Priceless CRM - tax invoice and receipt PDFs.
   One A4 page in the light report style: who it's from and to, the line
   items, GST, the total and a pay-by-card button (a real link in the PDF).
   A receipt is the same page marked paid, with the payment details.
   window.MPInvoicePDF.build(data) -> Promise<Uint8Array>, where data is
   put together by app.js:
     { kind: "invoice" | "receipt", number, receiptNumber, dateLabel, dueLabel,
       periodLabel, paidLabel, paidMethod, business: { name, gst, address,
       email, phone, website }, client: { name, contact, email, address },
       items: [{ desc, sub, qty, unit }], gstRate, payLink, notes }
   Amounts on the items are excl. GST. */
(function(){
"use strict";

const money2 = (v) => "$" + (Number(v) || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function totals(items, gstRate){
  const subtotal = (items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit) || 0), 0);
  const round = (n) => Math.round(n * 100) / 100;
  const gst = round(subtotal * (gstRate || 0));
  return { subtotal: round(subtotal), gst, total: round(subtotal + gst) };
}

// A clickable area on the page that opens a web link.
function addLink(pdf, page, x, y, w, h, url){
  const { PDFName, PDFString } = window.PDFLib;
  const annot = pdf.context.register(pdf.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [x, y, x + w, y + h], Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
  }));
  const annots = page.node.lookup(PDFName.of("Annots"));
  if (annots) annots.push(annot); else page.node.set(PDFName.of("Annots"), pdf.context.obj([annot]));
}

async function build(data){
  const R = window.MPReportPDF;
  const C = R.LIGHT, { W, H, M, hex } = R;
  const { pdf, F, text, label, wrap, box, hr, tick, drawLogo, width } = await R.makeKit({ palette: C });
  const receipt = data.kind === "receipt";
  const biz = data.business || {}, client = data.client || {};
  const items = (data.items || []).filter(it => it.desc || Number(it.unit));
  const t = totals(items, data.gstRate);
  const CW = W - 2 * M;
  const page = pdf.addPage([W, H]);
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(C.bg) });

  /* Header: logo and our details on the left, the document title on the right */
  drawLogo(page, M, H - 74, 40);
  const fromLines = [biz.name || "Mr Priceless", ...(String(biz.address || "").split(/\n+/)), [biz.email, biz.phone].filter(Boolean).join(" · "), biz.website || "mrpriceless.com"].filter(s => s && s.trim());
  fromLines.forEach((ln, i) => text(page, ln, M, H - 94 - i * 12, { f: i ? F.r : F.sb, size: i ? 8.5 : 9.5, color: i ? C.muted : C.text, maxWidth: 260 }));
  label(page, receipt ? "Receipt" : "Tax invoice", W - M, H - 50, { align: "right", color: C.gold, size: 7.5, ls: 1.8 });
  text(page, receipt ? data.receiptNumber : data.number, W - M, H - 80, { f: F.d8, size: 26, align: "right" });
  if (biz.gst) text(page, `GST number ${biz.gst}`, W - M, H - 96, { size: 8.5, color: C.muted, align: "right" });
  if (receipt){
    // "Paid" pill under the number.
    const pw = 74, px = W - M - pw, py = H - 124;
    box(page, px, py, pw, 20, { fill: "#e6f2ea", stroke: "#a9d1b6", r: 10 });
    tick(page, px + 15, py + 10, 8, C.good);
    text(page, "PAID", px + 27, py + 6.6, { f: F.b, size: 8.5, ls: 1.4, color: C.good });
  }
  const headBottom = H - 94 - (fromLines.length - 1) * 12 - 18;
  hr(page, M, W - M, Math.min(headBottom, H - 140), C.gold2, 0.9);
  let y = Math.min(headBottom, H - 140) - 22;

  /* Bill to + key facts + the amount */
  const heroH = 118, heroY = y - heroH;
  box(page, M, heroY, CW, heroH, { fill: C.panel, stroke: C.line });
  const leftW = CW * 0.42;
  label(page, receipt ? "Received from" : "Bill to", M + 20, heroY + heroH - 24);
  text(page, client.name || "Client", M + 20, heroY + heroH - 44, { f: F.d7, size: 15, maxWidth: leftW - 30 });
  [client.contact, client.email, ...String(client.address || "").split(/\n+/)].filter(s => s && s.trim()).slice(0, 4)
    .forEach((ln, i) => text(page, ln, M + 20, heroY + heroH - 62 - i * 12, { size: 8.8, color: C.soft, maxWidth: leftW - 30 }));
  const facts = receipt
    ? [["Paid on", data.paidLabel], ["Paid by", data.paidMethod || "Card"], ["For invoice", data.number]]
    : [["Invoice date", data.dateLabel], ["Payment due", data.dueLabel || "On receipt"], ["Reference", data.number]];
  const fx = M + leftW, factW = CW * 0.24;
  facts.forEach(([l, v], i) => {
    label(page, l, fx, heroY + heroH - 24 - i * 30, { size: 6.2 });
    text(page, v || "-", fx, heroY + heroH - 37 - i * 30, { f: F.sb, size: 9.5, maxWidth: factW - 12 });
  });
  // The amount, in a gold panel on the right.
  const ax = fx + factW, aw = M + CW - ax - 12;
  box(page, ax, heroY + 12, aw, heroH - 24, { fill: C.tint, stroke: C.gold3, r: 8 });
  label(page, receipt ? "Amount paid" : "Amount due", ax + aw / 2, heroY + heroH - 40, { align: "center", color: C.gold });
  text(page, money2(t.total), ax + aw / 2, heroY + heroH - 70, { f: F.d8, size: 22, align: "center", maxWidth: aw - 16 });
  text(page, receipt ? "Balance $0.00" : "NZD incl. GST", ax + aw / 2, heroY + heroH - 86, { size: 8, color: C.muted, align: "center" });
  y = heroY - 30;

  /* Line items */
  const cQty = M + CW * 0.62, cUnit = M + CW * 0.8, cAmt = W - M - 14;
  box(page, M, y - 24, CW, 24, { fill: C.panel2, r: 6 });
  label(page, "Description", M + 14, y - 15);
  label(page, "Qty", cQty, y - 15, { align: "right" });
  label(page, "Unit price", cUnit, y - 15, { align: "right" });
  label(page, "Amount", cAmt, y - 15, { align: "right" });
  y -= 24;
  items.forEach(it => {
    const lines = wrap(F.sb, it.desc || "", 10, CW * 0.52);
    const sub = it.sub ? wrap(F.r, it.sub, 8.5, CW * 0.52) : [];
    const rowH = 18 + lines.length * 13 + sub.length * 11;
    let ty = y - 20;
    lines.forEach((ln, j) => text(page, ln, M + 14, ty - j * 13, { f: F.sb, size: 10 }));
    sub.forEach((ln, j) => text(page, ln, M + 14, ty - lines.length * 13 - j * 11 + 1, { size: 8.5, color: C.muted }));
    const amt = (Number(it.qty) || 0) * (Number(it.unit) || 0);
    text(page, String(Number(it.qty) || 0), cQty, ty, { size: 10, align: "right" });
    text(page, money2(it.unit), cUnit, ty, { size: 10, align: "right" });
    text(page, money2(amt), cAmt, ty, { f: F.sb, size: 10, align: "right" });
    y -= rowH;
    hr(page, M, W - M, y);
  });

  /* Totals */
  y -= 18;
  const tx = M + CW * 0.56, tw = W - M - tx;
  const tRow = (l, v, o = {}) => {
    text(page, l, tx + 14, y, { size: 9.5, color: C.soft, ...o });
    text(page, v, cAmt, y, { size: 9.5, align: "right", ...o });
    y -= 18;
  };
  tRow("Subtotal (excl. GST)", money2(t.subtotal));
  tRow(`GST ${Math.round((data.gstRate || 0) * 100)}%`, money2(t.gst));
  y -= 4;
  box(page, tx, y - 14, tw, 30, { fill: C.gold, r: 7 });
  text(page, receipt ? "Total paid NZD" : "Total NZD", tx + 14, y - 3, { f: F.b, size: 10.5, color: C.onGold });
  text(page, money2(t.total), cAmt, y - 3.5, { f: F.d8, size: 13, color: C.onGold, align: "right" });
  if (receipt){
    y -= 34;
    text(page, "Balance owing", tx + 14, y, { size: 9.5, color: C.soft });
    text(page, "$0.00", cAmt, y, { f: F.sb, size: 9.5, align: "right", color: C.good });
  }
  y -= 44;

  /* How to pay (invoice) or thank-you (receipt) */
  const panelH = 92, panelY = Math.max(110, y - panelH);
  box(page, M, panelY, CW, panelH, { fill: C.panel, stroke: C.gold3, bw: 1 });
  if (!receipt){
    label(page, "How to pay", M + 20, panelY + panelH - 24, { color: C.gold });
    text(page, data.payLink ? "Pay securely by card. Click the button, or open the link below." : "Please pay by card using the link we've emailed you.", M + 20, panelY + panelH - 42, { size: 9.5, color: C.soft, maxWidth: CW - 200 });
    text(page, `Payment is due on receipt. Please use ${data.number} as the reference.`, M + 20, panelY + panelH - 56, { size: 9.5, color: C.soft, maxWidth: CW - 200 });
    if (data.payLink){
      const shown = data.payLink.replace(/^https?:\/\//, "");
      text(page, shown, M + 20, panelY + 18, { size: 8, color: C.gold, maxWidth: CW - 200 });
      addLink(pdf, page, M + 20, panelY + 14, Math.min(width(F.r, shown, 8), CW - 200), 12, data.payLink);
      const bw = 140, bh = 34, bx = W - M - 20 - bw, by = panelY + (panelH - bh) / 2;
      box(page, bx, by, bw, bh, { fill: C.gold, r: 17 });
      text(page, `Pay ${money2(t.total)}`, bx + bw / 2, by + 12.5, { f: F.b, size: 10.5, color: C.onGold, align: "center", maxWidth: bw - 16 });
      addLink(pdf, page, bx, by, bw, bh, data.payLink);
    }
  } else {
    label(page, "Thank you", M + 20, panelY + panelH - 24, { color: C.gold });
    text(page, `We've received your payment of ${money2(t.total)} for invoice ${data.number}.`, M + 20, panelY + panelH - 44, { f: F.sb, size: 10.5, maxWidth: CW - 40 });
    text(page, "Keep this receipt for your records. It's also a tax invoice for GST purposes.", M + 20, panelY + panelH - 60, { size: 9.5, color: C.soft, maxWidth: CW - 40 });
  }
  if (data.notes){
    const nl = wrap(F.r, data.notes, 9, CW).slice(0, 4);
    label(page, "Notes", M, panelY - 22);
    nl.forEach((ln, i) => text(page, ln, M, panelY - 36 - i * 12, { size: 9, color: C.soft }));
  }

  /* Footer */
  hr(page, M, W - M, 42, C.line);
  text(page, [biz.name || "Mr Priceless", biz.gst ? `GST ${biz.gst}` : "", biz.website || "mrpriceless.com"].filter(Boolean).join(" · "), M, 28, { size: 7.5, color: C.dim, maxWidth: 380 });
  text(page, receipt ? "Receipt · Page 1 of 1" : "Tax invoice · Page 1 of 1", W - M, 28, { size: 7.5, color: C.dim, align: "right" });

  pdf.setTitle(`Mr Priceless ${receipt ? "Receipt " + data.receiptNumber : "Invoice " + data.number} - ${client.name || ""}`);
  pdf.setAuthor(biz.name || "Mr Priceless");
  return pdf.save();
}

window.MPInvoicePDF = { build, totals };
})();
