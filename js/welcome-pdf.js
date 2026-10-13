/* Mr Priceless CRM - the client Welcome Pack PDF (2 pages, A4).
   Drawn in code in the brand style, so Rocky's personal note can be any
   length (everything below it moves down to make room) and the wording fits
   the kind of client: trades (quotes and jobs) or professional services
   (enquiries, appointments and new clients). The example client photo card
   is lifted straight from the original design (assets/welcome-pack-template.pdf).
   window.MPWelcomePDF.build(values) -> Promise<Uint8Array>, where values are
   the welcome pack form: client_first_name, business_name, call_when,
   ads_live, why_excited, account_manager, phone, email, kind ("trades"|"pro"). */
(function(){
"use strict";

// What changes between trades and professional services.
const COPY = {
  trades: {
    letter: [
      "We're pretty picky about who we work with, so if we've said yes, it's because we genuinely reckon we can get you great results. We're really looking forward to this one.",
      "Our job is simple: get quotes booked in with the right kind of work. Yours is to keep doing what you do best, and let us know how those quotes are landing so we can keep fine-tuning things.",
      "Have a read through, and flick us a message if anything doesn't make sense.",
    ],
    jobs: [
      ["Before and after job photos", "Have a handful ready for our onboarding call. Real work beats stock photos every time."],
      ["A photo of you, and one of the team", "People hire people, and faces in ads get more enquiries. No need for perfect photos. A quick phone snap is exactly right."],
    ],
    photo: true,
    promise: { big: "10", title: "10-quote guarantee", body: "We're backing ourselves to get you 10 quotes booked. You'll see the count in every report." },
    how: "Enquiries first, then quotes, then jobs",
    steps: [
      ["Week 1", "Setting up", "Build your ads, landing page and CRM.", "Your login and a first look at the ads."],
      ["Month 1", "First quotes", "Run ads already proven with our other clients, to get quotes in fast.", "Enquiries and quotes coming in, and a pipeline building for month two."],
      ["Months 2 to 3", "Sharpening", "Double down on what works and cut what doesn't.", "Steadier enquiries and better quality leads."],
    ],
    honest: [
      ["Paid leads aren't word of mouth.", "Referrals will always be your best source, but they're hard to scale. Paid leads fill that gap. They convert a bit lower, and that's normal."],
      ["Month one is the warm-up.", "You might not win a job in the first month, and that's normal. You'll head into month two with a pipeline of leads and quotes built, and that's where it pays off."],
      ["Your feedback steers the ads.", "Moving leads through the CRM stages tells us which ones were good, so we can sharpen who sees your ads."],
      ["Speed wins jobs.", "The quicker you get back to a lead, the more turn into quotes. A call within the hour makes a real difference."],
    ],
  },
  pro: {
    letter: [
      "We're pretty picky about who we work with, so if we've said yes, it's because we genuinely reckon we can help grow your business. We're really looking forward to this one.",
      "Our job is simple: put the right people in front of you and get them enquiring. Yours is to keep doing what you do best, and let us know how those enquiries are landing so we can keep fine-tuning things.",
      "Have a read through, and flick us a message if anything doesn't make sense.",
    ],
    jobs: [
      ["A few photos of you and the team", "Natural shots of you at work or with clients beat studio headshots. A quick phone photo is exactly right."],
      ["Your best results and reviews", "A couple of client wins, testimonials or Google reviews we can turn into ads. Proof sells better than promises."],
    ],
    photo: false,
    promise: { big: "2", title: "A report every fortnight", body: "Exactly what we spent, the enquiries it brought in and what each one cost. No fluff, no guessing." },
    how: "Enquiries first, then appointments, then clients",
    steps: [
      ["Week 1", "Setting up", "Build your ads, landing page and CRM.", "Your login and a first look at the ads."],
      ["Month 1", "First enquiries", "Run ads already proven with our other clients, to get enquiries in fast.", "Enquiries and booked appointments coming in, and a pipeline building for month two."],
      ["Months 2 to 3", "Sharpening", "Double down on what works and cut what doesn't.", "Steadier enquiries and better quality leads."],
    ],
    honest: [
      ["Paid leads aren't word of mouth.", "Referrals will always be your best source, but they're hard to scale. Paid leads fill that gap. They convert a bit lower, and that's normal."],
      ["Month one is the warm-up.", "You might not sign a new client in the first month, and that's normal. You'll head into month two with a pipeline of enquiries and appointments built, and that's where it pays off."],
      ["Your feedback steers the ads.", "Telling us which enquiries were a good fit lets us sharpen who sees your ads, so the quality keeps climbing."],
      ["Speed wins clients.", "The quicker you get back to an enquiry, the more turn into appointments. A call within the hour makes a real difference."],
    ],
  },
};

async function build(values){
  const R = window.MPReportPDF;
  const { W, H, hex } = R;
  // The dark palette loads the light logo, for the black header.
  const kit = await R.makeKit({ palette: R.C });
  const { pdf, F, text, label, wrap, box, hr, tick, drawLogo, width } = kit;
  const P = { bg: "#fbf8f1", panel: "#ffffff", tint: "#fff8e2", black: "#0b0b0c", gold: "#b8912c", goldLt: "#e8c468",
    text: "#1a1813", soft: "#4a453b", muted: "#7a7466", line: "#e7dfcd", leaf: "#37301e", letter: "#d9d3c5", white: "#ffffff" };
  const copy = COPY[values.kind] || COPY.trades;
  const v = (k) => String(values[k] || "").trim();
  const M = 51, CW = W - 2 * M;
  const top = (t) => H - t;   // design positions are measured from the top of the page

  // A simple fern, like the one in the original design: a curved stem with V-shaped fronds.
  const fern = (page, x0, t0, len, scale = 1) => {
    const segs = 14;
    let d = "";
    for (let i = 0; i < segs; i++){
      const t = t0 + (i / segs) * len, x = x0 - Math.sin(i / segs * 1.2) * 26 * scale, f = (34 + i * 1.6) * scale;
      d += `M ${x - f} ${t - f * 0.85} L ${x} ${t} L ${x + f * 0.9} ${t - f * 0.8} `;
    }
    d += `M ${x0} ${t0 - 20 * scale} Q ${x0 - 10 * scale} ${t0 + len * 0.5} ${x0 - Math.sin(1.2) * 26 * scale} ${t0 + len}`;
    page.drawSvgPath(d, { x: 0, y: H, borderColor: hex(P.leaf), borderWidth: 3 * scale, borderLineCap: 1 });
  };
  const footer = (page, n) => {
    hr(page, M, W - M, 50, "#cfc6b2", 0.7);
    label(page, "Mr Priceless  ·  Welcome Pack", M, 34, { color: P.muted, size: 6.8 });
    text(page, String(n), W - M, 34, { f: F.b, size: 7.5, color: P.gold, align: "right" });
  };
  // Phone and paper-plane style icons on gold/black squares, from 24-unit paths.
  const icon = (page, path, x, t, size, color) => page.drawSvgPath(path, { x, y: top(t), scale: size / 24, borderColor: hex(color), borderWidth: 2, borderLineCap: 1, borderLineJoin: 1 });
  const PHONE = "M22 16.92 v3 a2 2 0 0 1 -2.18 2 a19.79 19.79 0 0 1 -8.63 -3.07 a19.5 19.5 0 0 1 -6 -6 a19.79 19.79 0 0 1 -3.07 -8.67 A2 2 0 0 1 4.11 2 h3 a2 2 0 0 1 2 1.72 c0.127 0.96 0.362 1.903 0.7 2.81 a2 2 0 0 1 -0.45 2.11 L8.09 9.91 a16 16 0 0 0 6 6 l1.27 -1.27 a2 2 0 0 1 2.11 -0.45 c0.907 0.338 1.85 0.573 2.81 0.7 A2 2 0 0 1 22 16.92 z";
  const FEATHER = "M20.24 12.24 a6 6 0 0 0 -8.49 -8.49 L5 10.5 V19 h8.5 z M16 8 L2 22 M17.5 15 H9";

  /* ── Page 1 ── */
  const p1 = pdf.addPage([W, H]);
  p1.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(P.bg) });

  // Lay the letter out first, so the black header is as tall as it needs to be.
  const LX = 66, LW = 405;
  let noteSize = 10.4;
  let note = wrap(F.r, v("why_excited"), noteSize, LW);
  if (note.length > 8){ noteSize = 9.4; note = wrap(F.r, v("why_excited"), noteSize, LW); }
  note = note.slice(0, 12);
  const noteLh = noteSize * 1.55, bodySize = 10, bodyLh = 14.3, paraGap = 5;
  const paras = copy.letter.map(p => wrap(F.r, p, bodySize, LW));
  const letterTop = 140;
  let t = letterTop + 30;                                // "Kia ora" baseline
  const greetT = t;
  t += 22;
  const noteT = t;
  if (note.length) t += note.length * noteLh + 6;
  const parasT = t;
  t += paras.reduce((n, p) => n + p.length * bodyLh + paraGap, 0);
  const cheersT = t + 8;
  const hdrH = Math.max(337, cheersT + 22);
  p1.drawRectangle({ x: 0, y: top(hdrH), width: W, height: hdrH, color: hex(P.black) });
  fern(p1, 560, -10, hdrH + 10, hdrH / 337);
  drawLogo(p1, M, top(70), 37);
  p1.drawLine({ start: { x: 158, y: top(28) }, end: { x: 158, y: top(74) }, thickness: 0.8, color: hex("#8a6a1a") });
  label(p1, "Welcome pack", 172, top(53), { color: P.goldLt, size: 7.5, ls: 1.8 });
  const w1 = text(p1, "Welcome to ", M, top(122), { f: F.d8, size: 35, color: P.white });
  text(p1, "Mr Priceless!", M + w1, top(122), { f: F.d8, size: 35, color: P.goldLt });
  p1.drawLine({ start: { x: 52, y: top(letterTop) }, end: { x: 52, y: top(cheersT + 6) }, thickness: 1, color: hex(P.gold) });
  label(p1, "A personal letter from Rocky", LX, top(letterTop + 8), { color: P.goldLt, size: 7, ls: 1.7 });
  text(p1, `Kia ora${v("client_first_name") ? " " + v("client_first_name") : ""}`, LX, top(greetT), { f: F.sb, size: 13.5, color: P.white });
  note.forEach((ln, i) => text(p1, ln, LX, top(noteT + i * noteLh), { size: noteSize, color: P.white }));
  let pt = parasT;
  paras.forEach(lines => { lines.forEach((ln, i) => text(p1, ln, LX, top(pt + i * bodyLh), { size: bodySize, color: P.letter })); pt += lines.length * bodyLh + paraGap; });
  const cw = text(p1, "Cheers, ", LX, top(cheersT), { size: 10, color: P.letter });
  text(p1, "Rocky", LX + cw + 2, top(cheersT), { f: F.d7, size: 13, color: P.goldLt });

  // Everything under the header moves down with it.
  const dy = hdrH - 337;
  const T = (n) => n + dy;
  // Onboarding call / ads go live
  const cardT = T(353), cardH = 48, halfW = (CW - 13) / 2;
  const infoCard = (x, kicker, value, gold, path) => {
    box(p1, x, top(cardT + cardH), halfW, cardH, { fill: gold ? P.tint : P.panel, stroke: gold ? P.gold : P.line, r: 10, bw: gold ? 1 : 0.8 });
    box(p1, x + 14, top(cardT + 38), 28, 28, { fill: gold ? P.gold : P.black, r: 7 });
    icon(p1, path, x + 20, cardT + 16, 16, gold ? P.white : P.goldLt);
    label(p1, kicker, x + 54, top(cardT + 17), { color: "#8a6a1a", size: 6.6, ls: 1.5 });
    if (value) text(p1, value, x + 54, top(cardT + 35), { f: F.b, size: 13, color: P.text, maxWidth: halfW - 66 });
  };
  infoCard(M, "Your onboarding call", v("call_when"), false, PHONE);
  infoCard(M + halfW + 13, "Your ads go live", v("ads_live") ? `Around ${v("ads_live")}` : "", true, FEATHER);

  // Your two jobs
  text(p1, "Your two jobs", M, top(T(434)), { f: F.d7, size: 17, color: P.text });
  text(p1, "Get these ready for our onboarding call, and tick them off as you go.", M, top(T(452)), { size: 9.6, color: P.soft });
  const jobsW = copy.photo ? 283 : CW, jobH = [60, 72];
  const checks = [];
  let jt = T(465);
  copy.jobs.forEach(([title, body], i) => {
    const lines = wrap(F.r, body, 9, jobsW - 66);
    const h = Math.max(jobH[i], 34 + lines.length * 13);
    box(p1, M, top(jt + h), jobsW, h, { fill: P.panel, stroke: P.line, r: 10 });
    checks.push({ x: M + 12, t: jt + 15 });
    text(p1, title, M + 46, top(jt + 23), { f: F.b, size: 11, color: P.text });
    lines.forEach((ln, j) => text(p1, ln, M + 46, top(jt + 38 + j * 13), { size: 9, color: P.soft }));
    jt += h + 8;
  });
  if (copy.photo){
    // The example client photo card from the original design.
    const tplBytes = await fetch("assets/welcome-pack-template.pdf?v=8").then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
    if (tplBytes){
      const tpl = await window.PDFLib.PDFDocument.load(tplBytes);
      const tp = tpl.getPages()[0], TH = tp.getHeight();
      const emb = await pdf.embedPage(tp, { left: 344.5, right: 545.5, bottom: TH - 606, top: TH - 464 });
      p1.drawPage(emb, { x: 344.5, y: top(T(606)), width: emb.width, height: emb.height });
    }
  }

  // Go-to person and our promise
  const botT = Math.max(T(616), jt + 4), botH = 86;
  box(p1, M, top(botT + botH), halfW, botH, { fill: P.panel, stroke: P.line, r: 10 });
  label(p1, "Your go-to person", M + 14, top(botT + 20), { color: "#8a6a1a", size: 6.6, ls: 1.5 });
  if (v("account_manager")) text(p1, v("account_manager"), M + 14, top(botT + 42), { f: F.b, size: 13, color: P.text, maxWidth: halfW - 28 });
  if (v("phone")) text(p1, v("phone"), M + 14, top(botT + 58), { f: F.sb, size: 9.6, color: P.text, maxWidth: halfW - 28 });
  if (v("email")) text(p1, v("email"), M + 14, top(botT + 73), { f: F.sb, size: 9.6, color: P.text, maxWidth: halfW - 28 });
  const px = M + halfW + 13;
  box(p1, px, top(botT + botH), halfW, botH, { fill: P.panel, stroke: P.gold, r: 10, bw: 1 });
  p1.drawRectangle({ x: px + 0.5, y: top(botT + botH) + 0.5, width: 62, height: botH - 1, color: hex(P.gold) });
  text(p1, copy.promise.big, px + 31, top(botT + 56), { f: F.d8, size: 30, color: P.text, align: "center" });
  label(p1, "Our promise", px + 76, top(botT + 22), { color: "#8a6a1a", size: 6.6, ls: 1.5 });
  text(p1, copy.promise.title, px + 76, top(botT + 39), { f: F.b, size: 12, color: P.text, maxWidth: halfW - 86 });
  wrap(F.r, copy.promise.body, 8.8, halfW - 88).slice(0, 3).forEach((ln, i) => text(p1, ln, px + 76, top(botT + 54 + i * 12.5), { size: 8.8, color: P.soft }));
  footer(p1, 1);

  /* ── Page 2 ── */
  const p2 = pdf.addPage([W, H]);
  p2.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hex(P.bg) });
  label(p2, "How it'll go", M, top(58), { color: P.gold, size: 7, ls: 1.7 });
  let howSize = 23; while (howSize > 15 && width(F.d8, copy.how, howSize) > CW) howSize -= 0.5;
  text(p2, copy.how, M, top(90), { f: F.d8, size: howSize, color: P.text });
  text(p2, "How the first few months usually play out.", M, top(114), { size: 10, color: P.soft });
  const sW = (CW - 24) / 3, sT = 140;
  const stepBodies = copy.steps.map(s => ({ we: wrap(F.r, s[2], 9, sW - 28), see: wrap(F.r, s[3], 9, sW - 28) }));
  const sH = Math.max(...stepBodies.map(b => 148 + (b.we.length + b.see.length) * 13));
  copy.steps.forEach((s, i) => {
    const x = M + i * (sW + 12), mid = i === 1, b = stepBodies[i];
    box(p2, x, top(sT + sH), sW, sH, { fill: mid ? P.tint : P.panel, stroke: mid ? P.gold : P.line, r: 12, bw: mid ? 1 : 0.8 });
    p2.drawCircle({ x: x + 24, y: top(sT + 24), size: 10, color: hex(mid ? P.gold : P.black) });
    text(p2, String(i + 1), x + 24, top(sT + 27.5), { f: F.b, size: 10, color: mid ? P.white : P.goldLt, align: "center" });
    label(p2, s[0], x + 14, top(sT + 52), { color: "#8a6a1a", size: 6.4, ls: 1.4 });
    text(p2, s[1], x + 14, top(sT + 68), { f: F.b, size: 12, color: P.text });
    hr(p2, x + 14, x + sW - 14, top(sT + 80), P.line);
    label(p2, "We", x + 14, top(sT + 94), { size: 6, color: P.muted });
    b.we.forEach((ln, j) => text(p2, ln, x + 14, top(sT + 107 + j * 13), { size: 9, color: P.text }));
    const seeT = sT + 107 + b.we.length * 13 + 6;
    hr(p2, x + 14, x + sW - 14, top(seeT), P.line);
    label(p2, "You see", x + 14, top(seeT + 14), { size: 6, color: P.muted });
    b.see.forEach((ln, j) => text(p2, ln, x + 14, top(seeT + 27 + j * 13), { size: 9, color: P.text }));
  });
  const repT = sT + sH + 20;
  text(p2, "Every fortnight you'll get a report: what we spent, how many leads came in, and what each one cost.", M, top(repT), { size: 8.8, color: P.muted, maxWidth: CW });

  // The honest bit
  const hT = repT + 18, rowsH = copy.honest.map(([, body]) => Math.max(1, wrap(F.r, body, 9, CW - 196).length) * 13 + 9);
  const hH = 62 + rowsH.reduce((a, b) => a + b, 0);
  box(p2, M, top(hT + hH), CW, hH, { fill: P.black, r: 12 });
  label(p2, "The honest bit", M + 20, top(hT + 22), { color: P.goldLt, size: 6.6, ls: 1.6 });
  text(p2, "What to expect, straight up", M + 20, top(hT + 42), { f: F.d7, size: 15.5, color: P.white });
  let rt = hT + 64;
  copy.honest.forEach(([head, body], i) => {
    text(p2, head, M + 20, top(rt), { f: F.b, size: 9.6, color: P.goldLt, maxWidth: 160 });
    wrap(F.r, body, 9, CW - 196).forEach((ln, j) => text(p2, ln, M + 176, top(rt + j * 13), { size: 9, color: P.letter }));
    rt += rowsH[i];
  });

  // Sign-off
  const gT = hT + hH + 14, gH = 128;
  box(p2, M, top(gT + gH), CW, gH, { fill: P.black, r: 12 });
  fern(p2, M + CW - 40, gT + 24, gH - 34, 0.5);
  text(p2, "Welcome aboard.", M + 22, top(gT + 34), { f: F.d8, size: 18, color: P.white });
  text(p2, values.kind === "pro" ? "Let's grow your business." : "Let's get you busy.", M + 22, top(gT + 56), { f: F.d8, size: 18, color: P.goldLt });
  text(p2, "Cheers,", M + 22, top(gT + 80), { size: 9, color: P.letter });
  text(p2, "Rocky and Max", M + 22, top(gT + 99), { f: F.b, size: 12, color: P.white });
  text(p2, "Mr Priceless", M + 22, top(gT + 114), { f: F.sb, size: 8.5, color: P.goldLt });
  footer(p2, 2);

  // Real tick boxes on the two jobs, so they can tick them off in any PDF viewer.
  const form = pdf.getForm();
  checks.forEach((c, i) => {
    const box2 = form.createCheckBox(`job_${i + 1}`);
    box2.addToPage(p1, { x: c.x, y: top(c.t + 14), width: 14, height: 14, textColor: hex("#7e611a"), backgroundColor: hex(P.white), borderColor: hex(P.gold), borderWidth: 1.05 });
  });
  pdf.setTitle(`Mr Priceless Welcome Pack - ${v("business_name")}`.trim());
  pdf.setAuthor("Mr Priceless");
  return pdf.save();
}

window.MPWelcomePDF = { build, COPY };
})();
