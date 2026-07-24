/* Meetings Booked - ported as-is from the standalone tracker tool.
   Not wrapped in an IIFE: the markup's inline onclick handlers (incCounter,
   resetDay, addMeeting, closeModal, closeMegaC9, closeInsane) call these as
   globals, exactly like the original standalone file. */

/* ══════════════════════════════════════════
   AUDIO ENGINE - Web Audio API
══════════════════════════════════════════ */
let audioCtx = null;
function getAudio(){
  if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  return audioCtx;
}

function playTick(meetingIndex){
  const ac = getAudio();
  if(ac.state==='suspended') ac.resume();
  const t = ac.currentTime;
  // Ascending notes per meeting: C4 E4 G4 B4 D5
  const notes = [261.63, 329.63, 392.00, 493.88, 587.33];
  const freq = notes[Math.min(meetingIndex, notes.length-1)];

  // Main tone
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq * 2;
  filter.Q.value = 1.2;
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ac.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 1.008, t + 0.12);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.28, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
  osc.start(t);
  osc.stop(t + 0.4);

  // Harmonic overtone
  const osc2 = ac.createOscillator();
  const gain2 = ac.createGain();
  osc2.connect(gain2);
  gain2.connect(ac.destination);
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(freq * 2, t);
  gain2.gain.setValueAtTime(0, t);
  gain2.gain.linearRampToValueAtTime(0.12, t + 0.01);
  gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  osc2.start(t);
  osc2.stop(t + 0.25);

  // Click transient
  const buf = ac.createBuffer(1, ac.sampleRate * 0.04, ac.sampleRate);
  const data = buf.getChannelData(0);
  for(let i=0;i<data.length;i++) data[i] = (Math.random()*2-1) * Math.pow(1 - i/data.length, 3);
  const src = ac.createBufferSource();
  const clickGain = ac.createGain();
  const clickFilter = ac.createBiquadFilter();
  clickFilter.type = 'highpass';
  clickFilter.frequency.value = 800;
  src.buffer = buf;
  src.connect(clickFilter);
  clickFilter.connect(clickGain);
  clickGain.connect(ac.destination);
  clickGain.gain.setValueAtTime(0.18, t);
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  src.start(t);

  // Rising shimmer sweep
  const shimmer = ac.createOscillator();
  const shimGain = ac.createGain();
  shimmer.connect(shimGain);
  shimGain.connect(ac.destination);
  shimmer.type = 'sine';
  shimmer.frequency.setValueAtTime(freq * 3, t);
  shimmer.frequency.exponentialRampToValueAtTime(freq * 5, t + 0.18);
  shimGain.gain.setValueAtTime(0.07, t);
  shimGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  shimmer.start(t);
  shimmer.stop(t + 0.2);
}

function playGoalFanfare(){
  const ac = getAudio();
  if(ac.state==='suspended') ac.resume();
  const t = ac.currentTime;
  const chord = [261.63, 329.63, 392.00, 523.25, 659.25];
  chord.forEach((freq, i) => {
    const delay = i * 0.07;
    [1, 2, 4].forEach((mult, j) => {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.connect(g); g.connect(ac.destination);
      osc.type = j===0 ? 'sine' : 'sine';
      osc.frequency.setValueAtTime(freq * mult, t + delay);
      osc.frequency.exponentialRampToValueAtTime(freq * mult * 1.004, t + delay + 0.3);
      const vol = [0.22, 0.08, 0.04][j];
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(vol, t + delay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.9);
      osc.start(t + delay);
      osc.stop(t + delay + 1.0);
    });
  });
  // triumphant high ping
  setTimeout(() => {
    const ac2 = getAudio();
    const t2 = ac2.currentTime;
    [1046.5, 1318.5, 1567.98].forEach((f, i) => {
      const o = ac2.createOscillator(), g = ac2.createGain();
      o.connect(g); g.connect(ac2.destination);
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t2 + i*0.09);
      g.gain.setValueAtTime(0, t2 + i*0.09);
      g.gain.linearRampToValueAtTime(0.18, t2 + i*0.09 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t2 + i*0.09 + 0.45);
      o.start(t2 + i*0.09); o.stop(t2 + i*0.09 + 0.5);
    });
  }, 450);
}

function playGodmodeFanfare(){
  const ac = getAudio();
  if(ac.state==='suspended') ac.resume();
  const t = ac.currentTime;
  // Full orchestral blast - rising arpeggio + chord cluster + sub bass
  const scale = [261.63, 293.66, 329.63, 369.99, 415.30, 466.16, 523.25, 587.33, 659.25, 783.99, 880, 987.77, 1046.5];
  scale.forEach((freq, i) => {
    const delay = i * 0.055;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.connect(g); g.connect(ac.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t + delay);
    g.gain.setValueAtTime(0, t + delay);
    g.gain.linearRampToValueAtTime(0.15, t + delay + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + delay + 1.2);
    osc.start(t + delay); osc.stop(t + delay + 1.3);
  });
  // sub bass boom
  const bass = ac.createOscillator();
  const bassGain = ac.createGain();
  const bassFilter = ac.createBiquadFilter();
  bassFilter.type = 'lowpass'; bassFilter.frequency.value = 120;
  bass.connect(bassFilter); bassFilter.connect(bassGain); bassGain.connect(ac.destination);
  bass.type = 'sine'; bass.frequency.setValueAtTime(65, t);
  bassGain.gain.setValueAtTime(0.5, t);
  bassGain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
  bass.start(t); bass.stop(t + 0.9);
  // sparkle at end
  setTimeout(() => {
    const ac3 = getAudio(); const t3 = ac3.currentTime;
    for(let i=0;i<8;i++){
      const f = 1200 + i*180;
      const o = ac3.createOscillator(), g = ac3.createGain();
      o.connect(g); g.connect(ac3.destination);
      o.type = 'sine'; o.frequency.setValueAtTime(f, t3 + i*0.06);
      g.gain.setValueAtTime(0.12, t3 + i*0.06);
      g.gain.exponentialRampToValueAtTime(0.001, t3 + i*0.06 + 0.35);
      o.start(t3 + i*0.06); o.stop(t3 + i*0.06 + 0.4);
    }
  }, 750);
}

function playSwoosh(){
  const ac = getAudio();
  if(ac.state==='suspended') ac.resume();
  const t = ac.currentTime;
  // White noise burst - the "whoosh" body
  const buf = ac.createBuffer(1, ac.sampleRate * 2.5, ac.sampleRate);
  const data = buf.getChannelData(0);
  for(let i=0;i<data.length;i++) data[i] = Math.random()*2-1;
  const noise = ac.createBufferSource();
  noise.buffer = buf;
  // Bandpass sweep: starts high, sweeps down - the "whoosh" character
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = 0.8;
  bp.frequency.setValueAtTime(4000, t);
  bp.frequency.exponentialRampToValueAtTime(280, t + 1.6);
  const noiseGain = ac.createGain();
  noiseGain.gain.setValueAtTime(0, t);
  noiseGain.gain.linearRampToValueAtTime(0.55, t + 0.06);
  noiseGain.gain.setValueAtTime(0.55, t + 0.5);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
  noise.connect(bp); bp.connect(noiseGain); noiseGain.connect(ac.destination);
  noise.start(t); noise.stop(t + 2.5);
  // Low rumble underneath
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 140;
  const rumble = ac.createBufferSource();
  rumble.buffer = buf;
  const rumbleGain = ac.createGain();
  rumbleGain.gain.setValueAtTime(0, t);
  rumbleGain.gain.linearRampToValueAtTime(0.3, t + 0.1);
  rumbleGain.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
  rumble.connect(lp); lp.connect(rumbleGain); rumbleGain.connect(ac.destination);
  rumble.start(t); rumble.stop(t + 2.0);
  // Rising shimmer tones for the "Cloud 9" magic
  [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
    const delay = 0.15 + i * 0.14;
    const o = ac.createOscillator(), g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.type = 'sine'; o.frequency.setValueAtTime(f, t+delay);
    o.frequency.exponentialRampToValueAtTime(f*1.006, t+delay+0.5);
    g.gain.setValueAtTime(0, t+delay);
    g.gain.linearRampToValueAtTime(0.18, t+delay+0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t+delay+0.7);
    o.start(t+delay); o.stop(t+delay+0.8);
  });
}

const MEGA_CLOUDS = ['☁️','⛅','🌤️','☁️','🌥️','☁️','⛅','☁️','🌤️','☁️','⛅','🌥️'];
function showMegaC9(){
  const el = document.getElementById('mega-c9');
  el.classList.add('active');
  // Spawn clouds flying in from all edges
  const vw = window.innerWidth, vh = window.innerHeight;
  const origins = [
    // from left
    {sx:`-200px`,sy:`${-100+Math.random()*200}px`,ex:`${vw*0.2}px`,ey:`${-80+Math.random()*160}px`},
    {sx:`-250px`,sy:`${-50+Math.random()*100}px`,ex:`${vw*0.15}px`,ey:`${-60+Math.random()*120}px`},
    // from right
    {sx:`${vw+200}px`,sy:`${-100+Math.random()*200}px`,ex:`${-vw*0.2}px`,ey:`${-80+Math.random()*160}px`},
    {sx:`${vw+250}px`,sy:`${-50+Math.random()*100}px`,ex:`${-vw*0.15}px`,ey:`${-60+Math.random()*120}px`},
    // from top
    {sx:`${-150+Math.random()*300}px`,sy:`-220px`,ex:`${-80+Math.random()*160}px`,ey:`${vh*0.25}px`},
    {sx:`${-100+Math.random()*200}px`,sy:`-180px`,ex:`${-60+Math.random()*120}px`,ey:`${vh*0.2}px`},
    // from bottom
    {sx:`${-150+Math.random()*300}px`,sy:`${vh+180}px`,ex:`${-80+Math.random()*160}px`,ey:`${-vh*0.25}px`},
    // diagonals
    {sx:`-280px`,sy:`-200px`,ex:`${vw*0.18}px`,ey:`${vh*0.18}px`},
    {sx:`${vw+280}px`,sy:`-200px`,ex:`${-vw*0.18}px`,ey:`${vh*0.18}px`},
    {sx:`-280px`,sy:`${vh+200}px`,ex:`${vw*0.18}px`,ey:`${-vh*0.18}px`},
    {sx:`${vw+280}px`,sy:`${vh+200}px`,ex:`${-vw*0.18}px`,ey:`${-vh*0.18}px`},
    {sx:`${vw/2-100}px`,sy:`-240px`,ex:`${-40+Math.random()*80}px`,ey:`${vh*0.3}px`},
  ];
  origins.forEach((o, i) => {
    const c = document.createElement('div');
    c.className = 'mega-cloud';
    const sz = 48 + Math.floor(Math.random()*72);
    const dur = 1.0 + Math.random()*0.8;
    c.textContent = MEGA_CLOUDS[i % MEGA_CLOUDS.length];
    c.style.cssText = `font-size:${sz}px;top:50%;left:50%;--sx:${o.sx};--sy:${o.sy};--ex:${o.ex};--ey:${o.ey};--dur:${dur}s;--es:${0.9+Math.random()*0.4};animation-delay:${i*0.07}s;`;
    el.appendChild(c);
  });
  // Second wave - smaller, faster
  setTimeout(() => {
    for(let i=0;i<8;i++){
      const c = document.createElement('div'); c.className = 'mega-cloud';
      const side = i % 4;
      const sx = side===0?`-180px`:side===1?`${vw+180}px`:`${-200+Math.random()*400}px`;
      const sy = side===2?`-180px`:side===3?`${vh+180}px`:`${-100+Math.random()*200}px`;
      const ex = side===0?`${vw*0.3}px`:side===1?`${-vw*0.3}px`:`${-100+Math.random()*200}px`;
      const ey = side===2?`${vh*0.3}px`:side===3?`${-vh*0.3}px`:`${-80+Math.random()*160}px`;
      c.textContent = MEGA_CLOUDS[i % MEGA_CLOUDS.length];
      c.style.cssText = `font-size:${36+Math.floor(Math.random()*48)}px;top:50%;left:50%;--sx:${sx};--sy:${sy};--ex:${ex};--ey:${ey};--dur:${0.9+Math.random()*0.7}s;--es:1;`;
      el.appendChild(c);
    }
  }, 300);
  // Auto-dismiss after 3.8s
  setTimeout(closeMegaC9, 3800);
}
function closeMegaC9(){
  const el = document.getElementById('mega-c9');
  el.classList.remove('active');
  setTimeout(()=>{ el.querySelectorAll('.mega-cloud').forEach(c=>c.remove()); }, 600);
}

function playInsaneSound(){
  const ac = getAudio();
  if(ac.state==='suspended') ac.resume();
  const t = ac.currentTime;

  // Sub-bass BOOM
  const sub = ac.createOscillator();
  const subG = ac.createGain();
  sub.connect(subG); subG.connect(ac.destination);
  sub.type = 'sine';
  sub.frequency.setValueAtTime(55, t);
  sub.frequency.exponentialRampToValueAtTime(28, t + 0.6);
  subG.gain.setValueAtTime(0, t);
  subG.gain.linearRampToValueAtTime(1.4, t + 0.04);
  subG.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
  sub.start(t); sub.stop(t + 1.0);

  // Noise explosion burst
  const bufLen = ac.sampleRate * 0.4;
  const buf = ac.createBuffer(1, bufLen, ac.sampleRate);
  const d = buf.getChannelData(0);
  for(let i=0;i<bufLen;i++) d[i] = (Math.random()*2-1);
  const noise = ac.createBufferSource();
  noise.buffer = buf;
  const noiseF = ac.createBiquadFilter();
  noiseF.type = 'bandpass';
  noiseF.frequency.setValueAtTime(800, t);
  noiseF.frequency.exponentialRampToValueAtTime(200, t + 0.35);
  noiseF.Q.value = 1.2;
  const noiseG = ac.createGain();
  noise.connect(noiseF); noiseF.connect(noiseG); noiseG.connect(ac.destination);
  noiseG.gain.setValueAtTime(1.8, t);
  noiseG.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  noise.start(t); noise.stop(t + 0.4);

  // Rising siren
  const siren = ac.createOscillator();
  const sirenG = ac.createGain();
  siren.connect(sirenG); sirenG.connect(ac.destination);
  siren.type = 'sawtooth';
  siren.frequency.setValueAtTime(200, t + 0.3);
  siren.frequency.exponentialRampToValueAtTime(1600, t + 1.4);
  sirenG.gain.setValueAtTime(0, t + 0.3);
  sirenG.gain.linearRampToValueAtTime(0.35, t + 0.5);
  sirenG.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
  siren.start(t + 0.3); siren.stop(t + 1.7);

  // Triumphant chord cluster
  [[523.25,0],[659.25,0.05],[783.99,0.1],[1046.5,0.15],[1318.5,0.2]].forEach(([freq,delay])=>{
    const osc = ac.createOscillator();
    const og = ac.createGain();
    osc.connect(og); og.connect(ac.destination);
    osc.type = 'triangle';
    osc.frequency.value = freq;
    og.gain.setValueAtTime(0, t + 1.0 + delay);
    og.gain.linearRampToValueAtTime(0.28, t + 1.1 + delay);
    og.gain.exponentialRampToValueAtTime(0.001, t + 2.8 + delay);
    osc.start(t + 1.0 + delay); osc.stop(t + 3.0 + delay);
  });

  // Sparkle rain
  for(let i=0;i<18;i++){
    const sp = ac.createOscillator();
    const spG = ac.createGain();
    sp.connect(spG); spG.connect(ac.destination);
    sp.type = 'sine';
    const freq = 2000 + Math.random() * 4000;
    const st = t + 1.2 + Math.random() * 1.8;
    sp.frequency.setValueAtTime(freq, st);
    sp.frequency.exponentialRampToValueAtTime(freq * 0.5, st + 0.15);
    spG.gain.setValueAtTime(0.12, st);
    spG.gain.exponentialRampToValueAtTime(0.001, st + 0.18);
    sp.start(st); sp.stop(st + 0.2);
  }
}

const INSANE_EMOJIS = ['⚡','🔥','👑','💥','🌟','💫','🎯','🏆','✨','🚀','💎','🎉'];
const INSANE_DEFAULTS = { num:'5/5', label:'⚡ ABSOLUTE LEGEND ⚡', sub:'5 meetings booked · unstoppable · untouchable · unreal' };

function showInsane(numText, labelText, subText){
  const el = document.getElementById('insane');
  el.classList.add('active');
  document.getElementById('insane-num').textContent = numText || INSANE_DEFAULTS.num;
  document.getElementById('insane-label').textContent = labelText || INSANE_DEFAULTS.label;
  document.getElementById('insane-sub2').textContent = subText || INSANE_DEFAULTS.sub;

  // Shake the whole page
  document.body.classList.remove('mtr-body-shake');
  void document.body.offsetWidth;
  document.body.style.setProperty('--sd','0.5s');
  document.body.classList.add('mtr-body-shake');
  setTimeout(()=>{ document.body.classList.remove('mtr-body-shake'); }, 500);

  // Second shake
  setTimeout(()=>{
    document.body.classList.remove('mtr-body-shake');
    void document.body.offsetWidth;
    document.body.style.setProperty('--sd','0.35s');
    document.body.classList.add('mtr-body-shake');
    setTimeout(()=>{ document.body.classList.remove('mtr-body-shake'); }, 350);
  }, 600);

  // Glitch the number
  const num = document.getElementById('insane-num');
  setTimeout(()=>{
    num.classList.add('glitch');
    setTimeout(()=>num.classList.remove('glitch'), 1200);
  }, 300);

  // Emoji particle explosion
  const vw = window.innerWidth, vh = window.innerHeight;
  for(let i=0;i<32;i++){
    const pt = document.createElement('div');
    pt.className = 'insane-pt';
    pt.textContent = INSANE_EMOJIS[Math.floor(Math.random()*INSANE_EMOJIS.length)];
    const angle = (i/32)*Math.PI*2;
    const dist = 200 + Math.random()*280;
    const dx = Math.cos(angle)*dist + (Math.random()-0.5)*120;
    const dy = Math.sin(angle)*dist + (Math.random()-0.5)*120;
    pt.style.cssText = `font-size:${22+Math.floor(Math.random()*28)}px;top:50%;left:50%;--dx:${dx}px;--dy:${dy}px;--dur:${0.7+Math.random()*0.7}s;animation-delay:${Math.random()*0.3}s;`;
    el.appendChild(pt);
  }

  setTimeout(closeInsane, 5000);
}

function closeInsane(){
  const el = document.getElementById('insane');
  el.classList.remove('active');
  setTimeout(()=>{ el.querySelectorAll('.insane-pt').forEach(p=>p.remove()); }, 600);
}

function playUncheck(){
  const ac = getAudio();
  if(ac.state==='suspended') ac.resume();
  const t = ac.currentTime;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.connect(g); g.connect(ac.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(300, t);
  osc.frequency.exponentialRampToValueAtTime(180, t + 0.18);
  g.gain.setValueAtTime(0.1, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  osc.start(t); osc.stop(t + 0.25);
}

/* ══════════════════════════════════════════
   CLOUDS
══════════════════════════════════════════ */
let cloudsActive = false;
const CLOUD_EMOJIS = ['☁️','⛅','🌤️','☁️','☁️','⛅'];
function spawnCloud(delay){
  const wrap = document.getElementById('clouds');
  const el = document.createElement('div');
  el.className = 'mtr-cloud';
  const top = 8 + Math.random() * 78;
  const dur = 18 + Math.random() * 22;
  const bobOffset = Math.random() * 4;
  el.style.cssText = `top:${top}%;animation-duration:${dur}s;animation-delay:${delay}s;`;
  el.innerHTML = `<div class="mtr-cloud-body" style="animation-delay:${bobOffset}s;font-size:${40+Math.random()*28}px">${CLOUD_EMOJIS[Math.floor(Math.random()*CLOUD_EMOJIS.length)]}</div><div class="mtr-cloud-label">Cloud 9</div>`;
  wrap.appendChild(el);
  el.addEventListener('animationend', ()=>{ el.remove(); if(cloudsActive) spawnCloud(0); });
}
function startClouds(){
  if(cloudsActive) return;
  cloudsActive = true;
  document.getElementById('clouds').classList.add('active');
  for(let i=0;i<5;i++) spawnCloud(i * 3.5);
}
function stopClouds(){
  cloudsActive = false;
  const wrap = document.getElementById('clouds');
  wrap.classList.remove('active');
  setTimeout(()=>{ wrap.innerHTML=''; }, 2000);
}

/* ══════════════════════════════════════════
   STATE
══════════════════════════════════════════ */
const GOAL=2, CLOUD9=3, TOTAL=5;
const STORAGE_KEY='mb_v7';
const { supabase: mtrSupabase, IS_CONFIGURED: mtrIsConfigured } = window.CRM_DB;
let mtrUserId = null;

function localDateKey(d){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function getToday(){ return localDateKey(new Date()); }
function defaultState(){
  return{today:getToday(),calls:0,convos:0,meetings:[
    {name:'Meeting booked 1',done:false,time:null},
    {name:'Meeting booked 2',done:false,time:null},
    {name:'Meeting booked 3',done:false,time:null,bonus:true},
    {name:'Meeting booked 4',done:false,time:null,bonus:true},
    {name:'Meeting booked 5',done:false,time:null,bonus:true}
  ],history:{},log:[]};
}
function normalizeState(s){
  if(!s.meetings) s.meetings = defaultState().meetings;
  if(!s.history) s.history = {};
  if(!s.log) s.log = [];
  if(s.calls==null) s.calls = 0;
  if(s.convos==null) s.convos = 0;
  if(s.today !== getToday()){
    const prev = s.today;
    const doneCt = s.meetings.filter(m=>m.done).length;
    if(prev) s.history[prev] = doneCt;
    s.today = getToday();
    s.meetings.forEach(m=>{m.done=false;m.time=null;});
    s.log = []; s.calls = 0; s.convos = 0;
  }
  return s;
}

// Per-login persistence: real accounts sync through Supabase; demo mode
// falls back to localStorage since there's no real login to scope it to.
async function loadState(){
  if (mtrIsConfigured){
    const { data: { user } } = await mtrSupabase.auth.getUser();
    mtrUserId = user ? user.id : null;
    if (mtrUserId){
      const { data } = await mtrSupabase.from("user_widget_state").select("data").eq("user_id", mtrUserId).eq("widget","meetings_tracker").maybeSingle();
      if (data && data.data) return normalizeState(data.data);
    }
    return defaultState();
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw)) : defaultState();
  } catch(e){ return defaultState(); }
}
let state = defaultState();

async function save(){
  if (mtrIsConfigured && mtrUserId){
    try { await mtrSupabase.from("user_widget_state").upsert({ user_id: mtrUserId, widget: "meetings_tracker", data: state, updated_at: new Date().toISOString() }); } catch(e){}
    return;
  }
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state));}catch(e){}
}

/* ══════════════════════════════════════════
   CONFETTI
══════════════════════════════════════════ */
const canvas = document.getElementById('cc');
const ctx = canvas.getContext('2d');
let pieces=[], cfRunning=false, cfFrames=0, cfMax=0;
function resizeCanvas(){ canvas.width=window.innerWidth; canvas.height=window.innerHeight; }
resizeCanvas(); window.addEventListener('resize', resizeCanvas);

function addPieces(cols,n){
  for(let i=0;i<n;i++){
    pieces.push({
      x:Math.random()*canvas.width, y:-20-Math.random()*200,
      r:2+Math.random()*7, d:0.8+Math.random()*3.5,
      color:cols[Math.floor(Math.random()*cols.length)],
      ta:Math.random()*Math.PI*2, ts:0.05+Math.random()*0.25,
      vx:(Math.random()-0.5)*4, shape:Math.random()>0.38?'rect':'circle',
      glow:Math.random()>0.6
    });
  }
}
function drawPieces(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  pieces = pieces.filter(p=>{
    p.y+=p.d; p.x+=p.vx; p.ta+=p.ts; p.d+=0.02;
    ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.ta);
    if(p.glow){ ctx.shadowColor=p.color; ctx.shadowBlur=6; }
    ctx.fillStyle=p.color;
    if(p.shape==='rect'){ ctx.fillRect(-p.r,-p.r/2,p.r*2,p.r); }
    else{ ctx.beginPath(); ctx.arc(0,0,p.r,0,Math.PI*2); ctx.fill(); }
    ctx.restore();
    return p.y < canvas.height+30;
  });
  cfFrames++;
  if(cfRunning && cfFrames<cfMax){ requestAnimationFrame(drawPieces); }
  else if(cfFrames>=cfMax){ cfRunning=false; ctx.clearRect(0,0,canvas.width,canvas.height); }
}
function startConfetti(cols, big, massive){
  cfRunning=true; cfFrames=0; cfMax=massive?900:big?650:280;
  addPieces(cols, massive?500:big?320:140);
  requestAnimationFrame(drawPieces);
  const waves = massive?[300,600,900,1300,1800,2400,3100,4000]
                :big?[300,600,950,1400,2000,2700]
                :[300,600];
  const counts = massive?[420,380,350,320,290,260,240,220]
                 :big?[280,260,240,220,200,180]
                 :[110,90];
  waves.forEach((t,i)=>setTimeout(()=>addPieces(cols,counts[i]),t));
}

/* ══════════════════════════════════════════
   PARTICLES & EFFECTS
══════════════════════════════════════════ */
const emojis=['⭐','✨','🎯','💥','🔥','⚡','🎉','💫','🏆','💎','🚀','🎊','🌟'];
const goldEmojis=['🏆','👑','💎','🌟','🔥','⚡','💥','✨','🎊','🥇'];
const godEmojis=['👑','💎','🌈','🚀','⚡','🏆','✨','💫','🔮','🎆','🌟','💥'];

function spawnParticles(x,y,type){
  const arr = type==='god'?godEmojis:type==='gold'?goldEmojis:emojis;
  const n = type==='god'?40:type==='gold'?22:13;
  const big = type==='god';
  for(let i=0;i<n;i++){
    setTimeout(()=>{
      const el=document.createElement('div'); el.className='mtr-pt';
      el.textContent=arr[Math.floor(Math.random()*arr.length)];
      const angle=Math.random()*Math.PI*2;
      const dist=big?(130+Math.random()*230):type==='gold'?(90+Math.random()*150):(55+Math.random()*100);
      const rot = (Math.random()-0.5)*720;
      el.style.cssText=`left:${x}px;top:${y}px;font-size:${big?30:type==='gold'?24:19}px;--dx:${Math.cos(angle)*dist}px;--dy:${Math.sin(angle)*dist}px;--rot:${rot}deg;`;
      document.body.appendChild(el); setTimeout(()=>el.remove(),1100);
    }, i*(big?18:type==='gold'?25:38));
  }
}

function spawnRipple(el,e,gold){
  const r=document.createElement('div');
  r.className='mtr-ripple';
  const rect=el.getBoundingClientRect();
  const sz=Math.max(rect.width,rect.height)*2.5;
  r.style.cssText=`width:${sz}px;height:${sz}px;left:${e.clientX-rect.left-sz/2}px;top:${e.clientY-rect.top-sz/2}px`;
  el.appendChild(r); setTimeout(()=>r.remove(),750);
}

function spawnScorePop(x, y, isBonus){
  const el = document.createElement('div');
  el.className = 'mtr-score-pop';
  el.textContent = isBonus ? '☁️ CLOUD 9!' : '+BOOKED!';
  el.style.cssText = `left:${x-60}px;top:${y-20}px;`;
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 1100);
}

function flash(color){
  const f=document.createElement('div'); f.className='mtr-flash'; f.style.background=color;
  document.body.appendChild(f); setTimeout(()=>f.remove(),650);
}

function shakeEl(el){
  el.classList.remove('mtr-shake'); void el.offsetWidth; el.classList.add('mtr-shake');
  setTimeout(()=>el.classList.remove('mtr-shake'),500);
}

function popVal(id){
  const el=document.getElementById(id);
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}

/* ══════════════════════════════════════════
   AMBIENT BACKGROUND
══════════════════════════════════════════ */
function updateAmbient(done){
  const g = document.getElementById('amb-g');
  if(done>=CLOUD9){
    g.style.background='radial-gradient(ellipse 100% 65% at 50% 0%,rgba(184,145,44,0.1) 0%,rgba(232,196,104,0.04) 55%,transparent 75%)';
  } else if(done>=GOAL){
    g.style.background='radial-gradient(ellipse 85% 55% at 50% 0%,rgba(232,196,104,0.08) 0%,rgba(184,145,44,0.03) 50%,transparent 72%)';
  } else if(done>0){
    const intensity = done/GOAL;
    g.style.background=`radial-gradient(ellipse ${60+intensity*20}% ${40+intensity*15}% at 50% 0%,rgba(232,196,104,${0.03+intensity*0.05}) 0%,transparent 70%)`;
  } else {
    g.style.background='radial-gradient(ellipse 70% 50% at 50% 0%,rgba(232,196,104,0.03) 0%,transparent 70%)';
  }
}

/* ══════════════════════════════════════════
   MODALS
══════════════════════════════════════════ */
let goalShown=false, godShown=false, megaShown=false, insaneShown=false;
function openModal(id){
  document.getElementById(id).classList.add('visible');
  if(id==='modal-goal'){
    setTimeout(()=>{
      document.getElementById('mg-ring-fill').classList.add('animate');
      const p=document.getElementById('mg-pct'); let c=0;
      const iv=setInterval(()=>{c+=Math.floor(Math.random()*6)+4; if(c>=100){c=100;clearInterval(iv);} p.textContent=c+'%';},25);
    },700);
    startConfetti(['#e8c468','#b8912c','#8a6a1a','#ffffff','#f6ecd2'],false,false);
    flash('rgba(232,196,104,0.18)');
    setTimeout(()=>flash('rgba(255,255,255,0.1)'),180);
    setTimeout(()=>flash('rgba(232,196,104,0.12)'),380);
    shakeEl(document.querySelector('#modal-goal .modal'));
    setTimeout(()=>shakeEl(document.querySelector('#modal-goal .modal')),900);
    if(navigator.vibrate)navigator.vibrate([150,40,150,40,400,60,800]);
  }
  if(id==='modal-god'){
    setTimeout(()=>{
      document.getElementById('mnuc-ring-fill').classList.add('animate');
      const p=document.getElementById('mnuc-pct'); let c=0;
      const iv=setInterval(()=>{c+=Math.floor(Math.random()*5)+4; if(c>=100){c=100;clearInterval(iv);} p.textContent=c+'%';},22);
    },700);
    startConfetti(['#e8c468','#f3dca0','#b8912c','#ffffff','#8a6a1a','#fff6df'],true,true);
    ['rgba(232,196,104,0.28)','rgba(232,196,104,0.2)','rgba(184,145,44,0.18)','rgba(255,255,255,0.14)','rgba(232,196,104,0.22)'].forEach((c,i)=>setTimeout(()=>flash(c),i*200));
    [800,1700,2800].forEach(t=>setTimeout(()=>shakeEl(document.querySelector('#modal-god .modal')),t));
    if(navigator.vibrate)navigator.vibrate([200,50,200,50,500,80,1000,100,500,60,300]);
  }
}
function closeModal(id){
  document.getElementById(id).classList.remove('visible');
  if(id==='modal-god'){ cfRunning=false; ctx.clearRect(0,0,canvas.width,canvas.height); }
}

/* ══════════════════════════════════════════
   DATE / STREAK / WEEK
══════════════════════════════════════════ */
function formatDate(){
  return new Date().toLocaleDateString('en-NZ',{weekday:'short',day:'numeric',month:'short'});
}
function calcStreak(){
  let streak=0; const today=getToday(); let d=new Date();
  while(true){
    const key=localDateKey(d);
    const ct = key===today ? state.meetings.filter(m=>m.done).length : (state.history[key]??-1);
    if(ct>=GOAL) streak++;
    else if(key===today && ct<GOAL) break;
    else if(key!==today) break;
    d.setDate(d.getDate()-1);
  }
  return streak;
}
function renderWeekGrid(){
  const grid=document.getElementById('week-grid'); grid.innerHTML='';
  const today=new Date(); const dw=today.getDay();
  const monday=new Date(today); monday.setDate(today.getDate()-(dw===0?6:dw-1));
  for(let i=0;i<7;i++){
    const d=new Date(monday); d.setDate(monday.getDate()+i);
    const key=localDateKey(d); const todayKey=getToday();
    const el=document.createElement('div'); el.className='mtr-week-day'; el.textContent=d.getDate();
    if(key===todayKey){
      el.classList.add('today');
      const ct=state.meetings.filter(m=>m.done).length;
      if(ct>=CLOUD9) el.classList.add('cloud9'); else if(ct>=GOAL) el.classList.add('goal');
    } else if(key<todayKey){
      const ct=state.history[key]??0;
      if(ct>=CLOUD9) el.classList.add('cloud9'); else if(ct>=GOAL) el.classList.add('goal');
    } else el.classList.add('future');
    grid.appendChild(el);
  }
}

/* ══════════════════════════════════════════
   ACTIVITY LOG
══════════════════════════════════════════ */
function addLog(text,type){
  const time=new Date().toLocaleTimeString('en-NZ',{hour:'2-digit',minute:'2-digit',hour12:true});
  state.log.unshift({text,type,time});
  if(state.log.length>12) state.log.pop();
  renderLog();
}
function renderLog(){
  const el=document.getElementById('activity-log');
  if(!state.log.length){ el.innerHTML='<div class="empty-state" style="padding:20px 0;"><p>No activity yet today.</p></div>'; return; }
  el.innerHTML=state.log.slice(0,6).map(l=>`
    <div class="activity-row">
      <div class="activity-dot"></div>
      <div>
        <div class="activity-text">${l.text}</div>
        <div class="activity-time">${l.time}</div>
      </div>
    </div>`).join('');
}

/* ══════════════════════════════════════════
   STATS UPDATE
══════════════════════════════════════════ */
function updateStats(){
  const done=state.meetings.filter(m=>m.done).length;
  const goalDone=state.meetings.filter((m,i)=>m.done&&i<GOAL).length;
  const bonusDone=state.meetings.filter((m,i)=>m.done&&i>=GOAL).length;
  const pct=Math.round((goalDone/GOAL)*100);

  document.getElementById('kpi-done').textContent=done;
  document.getElementById('kpi-done-sub').textContent=`of ${GOAL} goal`;
  document.getElementById('kpi-left').textContent=Math.max(0,GOAL-goalDone);
  document.getElementById('kpi-left-sub').textContent=goalDone>=GOAL?'goal hit! 🎯':'to hit goal';
  document.getElementById('kpi-bonus').textContent=`+${bonusDone}`;
  document.getElementById('kpi-bonus-sub').textContent=done>=CLOUD9?'☁️ Cloud 9!':bonusDone>0?'unlocked!':'available';
  document.getElementById('kpi-rate').textContent=Math.round((done/TOTAL)*100)+'%';
  document.getElementById('kpi-rate-sub').textContent=done>=CLOUD9?'☁️ Cloud 9':done>=GOAL?'goal hit!':'of daily target';
  document.getElementById('goal-count').textContent=`${goalDone} / ${GOAL}`;
  document.getElementById('bonus-count').textContent=`${bonusDone} / 3`;
  document.getElementById('prog-count').textContent=`${done} / ${TOTAL}`;

  // progress bar
  const fill=document.getElementById('prog-fill');
  fill.style.width=(done/TOTAL*100)+'%';
  fill.className='mtr-progress-fill'+(done>=CLOUD9?' cloud9':'');

  // milestones - m3 at 40% (2/5), m5 at 60% (3/5)
  const m3=document.getElementById('m3'), m5=document.getElementById('m5');
  m3.classList.toggle('hit', goalDone>=GOAL);
  m5.classList.toggle('hit', done>=CLOUD9);

  // sidebar ring
  const circumference=2*Math.PI*43;
  const ring=document.getElementById('sidebar-ring');
  ring.style.strokeDashoffset=circumference*(1-pct/100);
  ring.style.stroke=done>=CLOUD9?'var(--gold-deep)':'var(--gold)';
  document.getElementById('ring-pct-text').textContent=pct+'%';
  document.getElementById('ring-sub-text').textContent=done>=CLOUD9?'CLOUD 9':done>=GOAL?'GOAL HIT':'OF GOAL';

  // banner
  const banner=document.getElementById('banner');
  banner.className='mtr-banner';
  if(done>=CLOUD9){ banner.textContent='☁️ Cloud 9 unlocked - you are floating right now.'; banner.classList.add('show','cloud9'); }
  else if(goalDone>=GOAL){ banner.textContent='🏆 Goal hit! 2/2 booked. One more for Cloud 9 ☁️'; banner.classList.add('show'); }

  // clouds
  if(done>=CLOUD9) startClouds(); else stopClouds();

  // streak chip
  const streak=calcStreak();
  if(streak>1){ document.getElementById('streak-chip').style.display='flex'; document.getElementById('streak-num').textContent=streak; }

  updateAmbient(done);
  renderWeekGrid();
}

/* ══════════════════════════════════════════
   TOGGLE
══════════════════════════════════════════ */
function toggle(idx, el, e){
  const m = state.meetings[idx];
  const wasNot = !m.done;
  m.done = !m.done;
  m.time = m.done ? new Date().toISOString() : null;
  save();

  const isBonus = idx>=GOAL;
  const done = state.meetings.filter(m=>m.done).length;
  const goalDone = state.meetings.filter((m,i)=>m.done&&i<GOAL).length;

  if(m.done){
    // Sound - escalate by how many are done
    const doneCount = done;
    if(goalDone===GOAL && done===GOAL){
      playGoalFanfare();
    } else {
      playTick(doneCount - 1);
    }
    spawnRipple(el, e, isBonus);
    spawnParticles(e.clientX, e.clientY, isBonus?'gold':'normal');
    spawnScorePop(e.clientX, e.clientY, isBonus);
    flash(isBonus?'rgba(255,171,0,0.08)':'rgba(0,230,118,0.08)');
    popVal('kpi-done'); popVal('kpi-rate');
    el.classList.remove('just-checked'); void el.offsetWidth; el.classList.add('just-checked');
    addLog(`<strong>${m.name}</strong> marked as booked`, isBonus?'amber':'green');
    if(navigator.vibrate) navigator.vibrate(isBonus?[60,20,80,20,150]:[40,10,60]);
  } else {
    playUncheck();
    addLog(`<strong>${m.name}</strong> unmarked`, 'reset');
  }

  renderItem(idx);

  if(wasNot){
    if(goalDone===GOAL && !goalShown){ goalShown=true; setTimeout(()=>openModal('modal-goal'),350); }
    if(done===CLOUD9 && !megaShown){
      megaShown=true;
      setTimeout(()=>{ playSwoosh(); showMegaC9(); }, 1200);
    }
    if(done===TOTAL && !insaneShown){
      insaneShown=true;
      setTimeout(()=>{ playInsaneSound(); showInsane(); }, 400);
    }
  }
  updateStats();
}

/* ══════════════════════════════════════════
   EDIT NAME
══════════════════════════════════════════ */
function startEdit(idx,el){
  el.classList.add('editing');
  const input=el.querySelector('.mtr-row-name-edit');
  input.value=state.meetings[idx].name;
  setTimeout(()=>{input.focus();input.select();},10);
  input.onkeydown=e=>{if(e.key==='Enter'||e.key==='Escape')finishEdit(idx,el);};
  input.onblur=()=>finishEdit(idx,el);
}
function finishEdit(idx,el){
  if(!el.classList.contains('editing'))return;
  const val=el.querySelector('.mtr-row-name-edit').value.trim();
  if(val) state.meetings[idx].name=val;
  el.classList.remove('editing'); save(); renderItem(idx);
  addLog(`Renamed to <strong>${state.meetings[idx].name}</strong>`,'reset');
}

/* ══════════════════════════════════════════
   RENDER ITEM
══════════════════════════════════════════ */
const MTR_CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';
const MTR_EDIT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';

function renderItem(idx){
  const list=idx<GOAL?document.getElementById('goal-list'):document.getElementById('bonus-list');
  const existing=list.children[idx<GOAL?idx:idx-GOAL];
  const m=state.meetings[idx]; const isBonus=idx>=GOAL;
  const el=existing||document.createElement('div');
  const badgeClass=m.done?'green':'gold';
  const badgeText=m.done?'Booked!':(isBonus?'Bonus':'Goal');
  const timeStr=m.time?new Date(m.time).toLocaleTimeString('en-NZ',{hour:'2-digit',minute:'2-digit',hour12:true}):'';
  el.className=`mtr-row${isBonus?' bonus':''}${m.done?' done':''}`;
  el.innerHTML=`
    <div class="mtr-check">${MTR_CHECK_SVG}</div>
    <div class="mtr-row-content">
      <div class="mtr-row-name-wrap">
        <div class="mtr-row-name-display">
          <span class="mtr-row-name">${m.name}</span>
        </div>
        <input class="mtr-row-name-edit" type="text" value="${m.name}" placeholder="Meeting name…">
      </div>
      <div class="mtr-row-meta">
        <span>${isBonus?'☁️ Cloud 9 - booking '+(idx+1):'Booking '+(idx+1)+' of '+GOAL}</span>
        ${timeStr?`<span>· ${timeStr}</span>`:''}
      </div>
    </div>
    <button class="mtr-edit-btn" title="Rename">${MTR_EDIT_SVG}</button>
    <span class="badge ${badgeClass}">${badgeText}</span>`;
  if(!existing){
    el.addEventListener('click',e=>{
      if(el.classList.contains('editing')||e.target.closest('.mtr-edit-btn'))return;
      toggle(idx,el,e);
    });
    list.appendChild(el);
  }
  // el.innerHTML is rebuilt on every call (even when existing), which destroys
  // and recreates this button - so its listener must be re-attached every time,
  // not just on first creation like the row's own click listener above.
  el.querySelector('.mtr-edit-btn').addEventListener('click',e=>{
    e.stopPropagation(); startEdit(idx,el);
  });
}

/* ══════════════════════════════════════════
   RENDER ALL / RESET / ADD
══════════════════════════════════════════ */
/* ══════════════════════════════════════════
   COUNTERS
══════════════════════════════════════════ */
function playCounterTick(isConvo){
  const ac = getAudio();
  if(ac.state==='suspended') ac.resume();
  const t = ac.currentTime;
  const freq = isConvo ? 440 : 330;
  const osc = ac.createOscillator(), g = ac.createGain();
  osc.connect(g); g.connect(ac.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 1.35, t + 0.08);
  g.gain.setValueAtTime(0.15, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  osc.start(t); osc.stop(t + 0.2);
  const osc2 = ac.createOscillator(), g2 = ac.createGain();
  osc2.connect(g2); g2.connect(ac.destination);
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(freq * 2, t + 0.04);
  g2.gain.setValueAtTime(0.07, t + 0.04);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  osc2.start(t + 0.04); osc2.stop(t + 0.18);
}

function renderCounters(){
  const calls = state.calls, convos = state.convos;
  document.getElementById('cnt-calls').textContent = calls;
  document.getElementById('cnt-convos').textContent = convos;
  document.getElementById('cc-calls').classList.toggle('has-count', calls > 0);
  document.getElementById('cc-convos').classList.toggle('has-count', convos > 0);
}

function incCounter(key){
  state[key]++;
  save();
  const numEl = document.getElementById('cnt-' + key);
  const cardEl = document.getElementById('cc-' + key);
  numEl.textContent = state[key];
  numEl.classList.remove('cn-pop'); void numEl.offsetWidth; numEl.classList.add('cn-pop');
  cardEl.classList.remove('cc-pop'); void cardEl.offsetWidth; cardEl.classList.add('cc-pop');
  cardEl.classList.toggle('has-count', state[key] > 0);
  playCounterTick(key === 'convos');
  // spawn a small +1 float
  const rect = cardEl.getBoundingClientRect();
  const el = document.createElement('div'); el.className = 'mtr-score-pop';
  el.textContent = '+1';
  el.style.cssText = `left:${rect.left + rect.width/2 - 20}px;top:${rect.top + 30}px;font-size:20px;`;
  document.body.appendChild(el); setTimeout(()=>el.remove(), 1000);
  if(navigator.vibrate) navigator.vibrate(18);
}

function decCounter(key){
  if(state[key] <= 0) return;
  state[key]--;
  save();
  renderCounters();
}

function renderAll(){
  const gl=document.getElementById('goal-list'), bl=document.getElementById('bonus-list');
  gl.innerHTML=''; bl.innerHTML='';
  goalShown=state.meetings.slice(0,GOAL).every(m=>m.done);
  godShown=state.meetings.filter((m,i)=>m.done&&i<CLOUD9).length>=CLOUD9;
  megaShown=state.meetings.filter(m=>m.done).length>=CLOUD9;
  insaneShown=state.meetings.filter(m=>m.done).length>=TOTAL;
  state.meetings.forEach((_,i)=>renderItem(i));
  updateStats(); renderLog(); renderCounters();
}

function addMeeting(){
  if(state.meetings.length>=8)return;
  const isBonus=state.meetings.length>=GOAL;
  state.meetings.push({name:`Meeting ${state.meetings.length+1}`,done:false,time:null,bonus:isBonus});
  save(); renderAll();
  const idx=state.meetings.length-1;
  const list=idx<GOAL?document.getElementById('goal-list'):document.getElementById('bonus-list');
  if(list.lastElementChild) startEdit(idx,list.lastElementChild);
}

function resetDay(){
  const done=state.meetings.filter(m=>m.done).length;
  if(done>0) state.history[getToday()]=done;
  state.meetings.forEach(m=>{m.done=false;m.time=null;}); state.log=[]; state.calls=0; state.convos=0; goalShown=false; godShown=false; megaShown=false; insaneShown=false;
  document.getElementById('mg-ring-fill').classList.remove('animate'); document.getElementById('mg-pct').textContent='0%';
  document.getElementById('mnuc-ring-fill').classList.remove('animate'); document.getElementById('mnuc-pct').textContent='0%';
  closeModal('modal-goal'); closeModal('modal-god');
  closeMegaC9(); closeInsane(); stopClouds();
  cfRunning=false; ctx.clearRect(0,0,canvas.width,canvas.height);
  save(); renderAll(); addLog('Day reset - fresh slate','reset');
}

/* ══════════════════════════════════════════
   INIT
══════════════════════════════════════════ */
document.getElementById('date-chip').textContent=formatDate();
(async () => {
  state = await loadState();
  renderAll();
})();
