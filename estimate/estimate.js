/* Priceless estimate - the customer's page (estimate/?t=<token>).
   Shows one estimate (estimate_view, sql/123), lets them sign it with their
   finger (estimate_sign) or say no thanks (estimate_decline), and prints as a
   clean PDF. The token in the link is the only key. ?demo shows a sample. */
(() => {
"use strict";
const CFG = window.CRM_CONFIG || {};
const params = new URLSearchParams(location.search);
const TOKEN = params.get("t") || "";
const DEMO = params.has("demo") || !(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
const sb = !DEMO && window.supabase?.createClient ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: false } }) : null;
const root = document.getElementById("es-root");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "$" + Number(n || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => d ? new Date(String(d).length <= 10 ? d + "T12:00:00" : d).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" }) : "";
const lines = (s) => String(s || "").split("\n").map(x => x.trim()).filter(Boolean);
let E = null;

function demo(){
  return { number: 1042, status: "viewed", customer_name: "Sarah Mitchell", site_address: "12 Rata Street, Henderson, Auckland",
    title: "Lounge wall repairs and skim coat", intro: "Repair the cracked lounge walls and the hole behind the door, then skim coat the lounge so it's smooth and ready to paint.",
    items: [{ desc: "Plaster repairs - cracks and holes", detail: "Cut out, tape and fill cracks; patch the hole behind the door", qty: 1, unit: "job", price: 380 },
      { desc: "Skim coat walls", detail: "Two coats, sanded smooth, ready for paint", qty: 42, unit: "m²", price: 35 },
      { desc: "Site set-up, protection and clean-up", detail: "Drop sheets, floor protection, full clean-up", qty: 1, unit: "job", price: 150 }],
    exclusions: "Painting\nMoving heavy furniture", terms: "Price is for the work described. Any extra work is agreed with you first.\nPayment due within 7 days of completion.",
    gst_rate: 0.15, subtotal: 2000, gst: 300, total: 2300, date: new Date().toISOString(), valid_until: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), expired: false,
    business: { name: "Priceless Plastering", legal_name: "Priceless Plastering & Painting Ltd", gst_number: "123-456-789", phone: "021 000 0000", email: "hello@pricelessplastering.co.nz", website: "pricelessplastering.co.nz" } };
}
async function load(){
  if (DEMO){ E = demo(); return render(); }
  if (TOKEN.length < 32){ root.innerHTML = msg("This link isn't complete", "Please open the full link from your text or email."); return; }
  try {
    const { data, error } = await sb.rpc("estimate_view", { p_token: TOKEN });
    if (error) throw error;
    if (!data){ root.innerHTML = msg("We couldn't find this estimate", "The link may be old. Give us a call and we'll send you a fresh one."); return; }
    E = data; render();
  } catch(e){ root.innerHTML = msg("Something went wrong", "Check your connection and refresh the page."); }
}
const msg = (h, p) => `<div class="es-msg"><h1>${esc(h)}</h1><p>${esc(p)}</p></div>`;

function render(){
  const b = E.business || {}, signed = E.status === "signed", declined = E.status === "declined";
  document.title = `${b.name || "Priceless"} - Estimate #${E.number}`;
  const items = Array.isArray(E.items) ? E.items : [];
  root.innerHTML = `
  <article class="es-paper">
    <header class="es-top">
      <div class="es-brand">
        <div class="es-mark">${esc((b.name || "P").replace(/^Priceless\s*/i, "").charAt(0) || "P")}</div>
        <div><h1>${esc(b.name || "Priceless")}</h1><p>${esc([b.phone, b.email, b.website].filter(Boolean).join("  ·  "))}</p></div>
      </div>
      <div class="es-doc"><span>Estimate</span><b>#${esc(E.number)}</b></div>
    </header>
    ${signed ? `<div class="es-banner ok">✓ Accepted by ${esc(E.signed_name)} on ${esc(day(E.signed_at))}. Thank you - we'll be in touch to lock in a start date.</div>`
      : declined ? `<div class="es-banner">You let us know this one isn't going ahead. No worries - give us a call any time.</div>`
      : E.expired ? `<div class="es-banner warn">This estimate expired on ${esc(day(E.valid_until))}. Give us a call and we'll update it for you.</div>` : ""}
    <section class="es-meta">
      <div><span>Prepared for</span><b>${esc(E.customer_name || "")}</b>${E.site_address ? `<p>${esc(E.site_address)}</p>` : ""}</div>
      <div><span>Date</span><b>${esc(day(E.date))}</b>${E.valid_until ? `<p>Valid until ${esc(day(E.valid_until))}</p>` : ""}</div>
    </section>
    <section class="es-hero">
      <h2>${esc(E.title || "Your estimate")}</h2>
      ${E.intro ? `<p>${esc(E.intro)}</p>` : ""}
      <div class="es-total-big"><span>Total</span><b>${money(E.total)}</b><small>incl. GST</small></div>
    </section>
    <section class="es-items">
      <h3>Scope of work</h3>
      <ol>${items.map(it => {
        const line = Number(it.qty || 0) * Number(it.price || 0);
        return `<li>
          <div class="es-item-main"><b>${esc(it.desc)}</b>${it.detail ? `<p>${esc(it.detail)}</p>` : ""}</div>
          <div class="es-item-qty">${Number(it.qty) !== 1 || (it.unit && it.unit !== "job") ? `${esc(it.qty)} ${esc(it.unit || "")} × ${money(it.price)}` : ""}</div>
          <div class="es-item-amt">${money(line)}</div>
        </li>`; }).join("")}</ol>
      <div class="es-sums">
        <div><span>Subtotal</span><b>${money(E.subtotal)}</b></div>
        <div><span>GST (${Math.round(Number(E.gst_rate || 0) * 100)}%)</span><b>${money(E.gst)}</b></div>
        <div class="grand"><span>Total</span><b>${money(E.total)}</b></div>
      </div>
    </section>
    ${lines(E.exclusions).length ? `<section class="es-notes"><h3>Not included</h3><ul>${lines(E.exclusions).map(x => `<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}
    ${lines(E.terms).length ? `<section class="es-notes"><h3>Good to know</h3><ul>${lines(E.terms).map(x => `<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}
    <section class="es-sign" id="es-sign">${signHtml()}</section>
    <footer class="es-foot">${esc([b.legal_name, b.gst_number ? `GST ${b.gst_number}` : "", b.address].filter(Boolean).join("  ·  "))}</footer>
  </article>
  <div class="es-actions"><button type="button" class="es-ghost" data-print>Save as PDF / print</button>${b.phone ? `<a class="es-ghost" href="tel:${esc(String(b.phone).replace(/[^\d+]/g, ""))}">Call us</a>` : ""}</div>`;
  bind();
}
function signHtml(){
  if (E.status === "signed") return `<h3>Accepted</h3><div class="es-signed"><img src="${esc(E.signature || "")}" alt="Signature"><div><b>${esc(E.signed_name)}</b><span>${esc(day(E.signed_at))}</span></div></div>`;
  if (E.status === "declined" || E.expired) return "";
  return `<h3>Happy to go ahead?</h3>
    <p class="es-sign-help">Type your name and sign in the box with your finger (or mouse). That's it - we'll be in touch to book you in.</p>
    <label class="es-name">Your full name<input type="text" id="es-name" autocomplete="name" value="${esc(E.customer_name || "")}"></label>
    <div class="es-pad-wrap"><canvas id="es-pad" aria-label="Sign here"></canvas><span class="es-pad-hint">Sign here</span><button type="button" class="es-clear" data-clear>Clear</button></div>
    <label class="es-agree"><input type="checkbox" id="es-agree"> I accept this estimate and the terms above.</label>
    <p class="es-err" id="es-err" role="alert"></p>
    <button type="button" class="es-go" data-sign>Accept &amp; sign</button>
    <button type="button" class="es-no" data-decline>Not going ahead</button>`;
}
let drawn = false;
function bind(){
  root.querySelector("[data-print]")?.addEventListener("click", () => print());
  const pad = document.getElementById("es-pad");
  if (pad){
    const ctx = pad.getContext("2d");
    const fit = () => { const r = pad.getBoundingClientRect(), d = devicePixelRatio || 1; pad.width = r.width * d; pad.height = r.height * d; ctx.setTransform(d, 0, 0, d, 0, 0); ctx.lineWidth = 2.6; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#141210"; drawn = false; pad.parentNode.classList.remove("has-ink"); };
    fit(); addEventListener("resize", () => { if (!drawn) fit(); });
    let down = false, last = null;
    const pt = (e) => { const r = pad.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    pad.addEventListener("pointerdown", (e) => { down = true; last = pt(e); pad.setPointerCapture(e.pointerId); e.preventDefault(); });
    pad.addEventListener("pointermove", (e) => { if (!down) return; const p = pt(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; drawn = true; pad.parentNode.classList.add("has-ink"); e.preventDefault(); });
    ["pointerup", "pointercancel", "pointerleave"].forEach(t => pad.addEventListener(t, () => { down = false; }));
    root.querySelector("[data-clear]").addEventListener("click", fit);
  }
  root.querySelector("[data-sign]")?.addEventListener("click", sign);
  root.querySelector("[data-decline]")?.addEventListener("click", decline);
}
async function sign(){
  const err = document.getElementById("es-err"), name = document.getElementById("es-name").value.trim();
  if (name.length < 2) return (err.textContent = "Please type your name.");
  if (!drawn) return (err.textContent = "Please sign in the box.");
  if (!document.getElementById("es-agree").checked) return (err.textContent = "Please tick the box to accept.");
  const btn = root.querySelector("[data-sign]"); btn.disabled = true; btn.textContent = "Signing…"; err.textContent = "";
  const sig = document.getElementById("es-pad").toDataURL("image/png");
  try {
    if (!DEMO){
      const { data, error } = await sb.rpc("estimate_sign", { p_token: TOKEN, p_name: name, p_signature: sig });
      if (error || !data?.ok) throw new Error(data?.error || "That didn't go through. Please try again.");
    }
    Object.assign(E, { status: "signed", signed_name: name, signed_at: new Date().toISOString(), signature: sig });
    render(); document.getElementById("es-sign").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch(e){ err.textContent = e.message; btn.disabled = false; btn.textContent = "Accept & sign"; }
}
async function decline(){
  const reason = prompt("No worries - mind telling us why? (optional)");
  if (reason === null) return;
  if (!DEMO){ try { await sb.rpc("estimate_decline", { p_token: TOKEN, p_reason: reason }); } catch(e){} }
  E.status = "declined"; render();
}
load();
})();
