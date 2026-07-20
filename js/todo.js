/* To Do - gamified daily priority list.
   Not wrapped in an IIFE (matches meetings-tracker.js), and reuses that
   script's shared celebration engine directly: getAudio, playTick,
   playGoalFanfare, playUncheck, spawnRipple, spawnParticles, flash,
   shakeEl, popVal, startConfetti, openModal/closeModal, getToday,
   formatDate. Every name declared here is prefixed "todo"/"td" so
   nothing collides with meetings-tracker.js's own globals. */

const TODO_STORAGE_KEY = 'td_v1';
const TODO_MAX = 5;
const TODO_MIN_FOR_WIN = 3;

function todoGetToday(){ return new Date().toISOString().slice(0,10); }

function todoDefaultState(){
  return { today: todoGetToday(), tasks: [], history: {}, log: [] };
}

let todoState;
try {
  const raw = localStorage.getItem(TODO_STORAGE_KEY);
  todoState = raw ? JSON.parse(raw) : todoDefaultState();
  if (!todoState.tasks) todoState.tasks = [];
  if (!todoState.history) todoState.history = {};
  if (!todoState.log) todoState.log = [];
  if (todoState.today !== todoGetToday()){
    const prevDone = todoState.tasks.filter(t=>t.done).length;
    const prevTotal = todoState.tasks.length;
    if (todoState.today) todoState.history[todoState.today] = { done: prevDone, total: prevTotal };
    todoState.today = todoGetToday();
    todoState.tasks = [];
    todoState.log = [];
  }
} catch(e){ todoState = todoDefaultState(); }

function todoSave(){ try { localStorage.setItem(TODO_STORAGE_KEY, JSON.stringify(todoState)); } catch(e){} }

let todoCelebrated = false;

function todoAddLog(text){
  const time = new Date().toLocaleTimeString('en-NZ',{hour:'2-digit',minute:'2-digit',hour12:true});
  todoState.log.unshift({ text, time });
  if (todoState.log.length > 12) todoState.log.pop();
  todoRenderLog();
}
function todoRenderLog(){
  const el = document.getElementById('td-activity-log');
  if (!el) return;
  if (!todoState.log.length){ el.innerHTML = '<div class="empty-state" style="padding:20px 0;"><p>No activity yet today.</p></div>'; return; }
  el.innerHTML = todoState.log.slice(0,6).map(l => `
    <div class="activity-row">
      <div class="activity-dot"></div>
      <div>
        <div class="activity-text">${l.text}</div>
        <div class="activity-time">${l.time}</div>
      </div>
    </div>`).join('');
}

function todoCalcStreak(){
  let streak = 0;
  const today = todoGetToday();
  const todayDone = todoState.tasks.filter(t=>t.done).length;
  const todayTotal = todoState.tasks.length;
  let d = new Date();
  while (true){
    const key = d.toISOString().slice(0,10);
    let win;
    if (key === today) win = todayTotal >= TODO_MIN_FOR_WIN && todayDone === todayTotal;
    else {
      const rec = todoState.history[key];
      win = rec ? (rec.total >= TODO_MIN_FOR_WIN && rec.done === rec.total) : false;
    }
    if (win) streak++;
    else break;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function todoRenderWeekGrid(){
  const grid = document.getElementById('td-week-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const today = new Date(); const dw = today.getDay();
  const monday = new Date(today); monday.setDate(today.getDate() - (dw===0?6:dw-1));
  const todayKey = todoGetToday();
  for (let i=0;i<7;i++){
    const d = new Date(monday); d.setDate(monday.getDate()+i);
    const key = d.toISOString().slice(0,10);
    const el = document.createElement('div'); el.className = 'mtr-week-day'; el.textContent = d.getDate();
    if (key === todayKey){
      el.classList.add('today');
      const done = todoState.tasks.filter(t=>t.done).length, total = todoState.tasks.length;
      if (total >= TODO_MIN_FOR_WIN && done === total) el.classList.add('goal');
    } else if (key < todayKey){
      const rec = todoState.history[key];
      if (rec && rec.total >= TODO_MIN_FOR_WIN && rec.done === rec.total) el.classList.add('goal');
    } else el.classList.add('future');
    grid.appendChild(el);
  }
}

function todoUpdateStats(){
  const done = todoState.tasks.filter(t=>t.done).length;
  const total = todoState.tasks.length;
  const pct = total ? Math.round((done/total)*100) : 0;

  const doneEl = document.getElementById('td-kpi-done');
  if (!doneEl) return;
  doneEl.textContent = done;
  document.getElementById('td-kpi-done-sub').textContent = `of ${total} task${total===1?'':'s'}`;
  document.getElementById('td-kpi-left').textContent = Math.max(0, total-done);
  document.getElementById('td-kpi-rate').textContent = pct + '%';
  document.getElementById('td-kpi-streak').textContent = todoCalcStreak();
  document.getElementById('td-count').textContent = `${done} / ${total}`;
  document.getElementById('td-prog-count').textContent = `${done} / ${total}`;

  const fill = document.getElementById('td-prog-fill');
  fill.style.width = pct + '%';
  fill.className = 'mtr-progress-fill' + (total>=TODO_MIN_FOR_WIN && done===total ? ' cloud9' : '');

  const banner = document.getElementById('td-banner');
  banner.className = 'mtr-banner';
  if (total >= TODO_MIN_FOR_WIN && done === total){
    banner.textContent = '🎯 Every priority done. That is a winning day.';
    banner.classList.add('show','cloud9');
  } else if (total > 0 && done > 0){
    banner.textContent = `Keep going - ${total-done} to go.`;
    banner.classList.add('show');
  }

  const streak = todoCalcStreak();
  const chip = document.getElementById('td-streak-chip');
  if (streak > 1){ chip.style.display = 'flex'; document.getElementById('td-streak-num').textContent = streak; }
  else chip.style.display = 'none';

  document.getElementById('td-add-btn').disabled = total >= TODO_MAX;

  todoRenderWeekGrid();
}

const TODO_CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';
const TODO_EDIT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
const TODO_TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg>';

function todoRenderList(){
  const list = document.getElementById('td-list');
  if (!list) return;
  if (!todoState.tasks.length){
    list.innerHTML = '<div class="empty-state"><p>Add your 3-5 most important things for today.</p></div>';
    return;
  }
  list.innerHTML = '';
  todoState.tasks.forEach((_,i) => todoRenderItem(i));
}

function todoRenderItem(idx){
  const list = document.getElementById('td-list');
  const t = todoState.tasks[idx];
  if (!t) return;
  const existing = list.children[idx];
  const el = existing || document.createElement('div');
  const timeStr = t.time ? new Date(t.time).toLocaleTimeString('en-NZ',{hour:'2-digit',minute:'2-digit',hour12:true}) : '';
  el.className = 'mtr-row' + (t.done ? ' done' : '');
  el.innerHTML = `
    <div class="mtr-check">${TODO_CHECK_SVG}</div>
    <div class="mtr-row-content">
      <div class="mtr-row-name-wrap">
        <div class="mtr-row-name-display">
          <span class="mtr-row-name">${t.name}</span>
        </div>
        <input class="mtr-row-name-edit" type="text" value="${t.name}" placeholder="What's the priority?">
      </div>
      <div class="mtr-row-meta">
        <span>Priority ${idx+1} of ${todoState.tasks.length}</span>
        ${timeStr?`<span>· ${timeStr}</span>`:''}
      </div>
    </div>
    <button class="mtr-edit-btn" title="Rename">${TODO_EDIT_SVG}</button>
    <button class="mtr-edit-btn" title="Delete">${TODO_TRASH_SVG}</button>
    <span class="badge ${t.done?'green':'gold'}">${t.done?'Done!':'Priority'}</span>`;
  if (!existing){
    el.addEventListener('click', e => {
      if (el.classList.contains('editing') || e.target.closest('.mtr-edit-btn')) return;
      todoToggle(idx, el, e);
    });
    const buttons = el.querySelectorAll('.mtr-edit-btn');
    buttons[0].addEventListener('click', e => { e.stopPropagation(); todoStartEdit(idx, el); });
    buttons[1].addEventListener('click', e => { e.stopPropagation(); todoDeleteTask(idx); });
    list.appendChild(el);
  }
}

function todoToggle(idx, el, e){
  const t = todoState.tasks[idx];
  const wasNot = !t.done;
  t.done = !t.done;
  t.time = t.done ? new Date().toISOString() : null;
  todoSave();

  const done = todoState.tasks.filter(x=>x.done).length;
  const total = todoState.tasks.length;

  if (t.done){
    if (total >= TODO_MIN_FOR_WIN && done === total) playGoalFanfare();
    else playTick(done-1);
    spawnRipple(el, e, false);
    spawnParticles(e.clientX, e.clientY, 'normal');
    flash('rgba(232,196,104,0.1)');
    popVal('td-kpi-done');
    el.classList.remove('just-checked'); void el.offsetWidth; el.classList.add('just-checked');
    todoAddLog(`<strong>${t.name}</strong> marked as done`);
    if (navigator.vibrate) navigator.vibrate([40,10,60]);
  } else {
    playUncheck();
    todoAddLog(`<strong>${t.name}</strong> unmarked`);
  }

  todoRenderItem(idx);

  if (wasNot && total >= TODO_MIN_FOR_WIN && done === total && !todoCelebrated){
    todoCelebrated = true;
    setTimeout(() => {
      startConfetti(['#e8c468','#b8912c','#8a6a1a','#ffffff','#f6ecd2'], false, false);
      flash('rgba(232,196,104,0.18)');
      setTimeout(()=>flash('rgba(255,255,255,0.1)'),180);
      shakeEl(document.querySelector('#modal-todo-done .modal'));
      if (navigator.vibrate) navigator.vibrate([150,40,150,40,400,60,800]);
      document.getElementById('td-ring-fill').classList.add('animate');
      const p = document.getElementById('td-pct'); let c = 0;
      const iv = setInterval(()=>{ c += Math.floor(Math.random()*6)+4; if(c>=100){c=100;clearInterval(iv);} p.textContent = c+'%'; }, 25);
      openModal('modal-todo-done');
    }, 350);
  }

  todoUpdateStats();
}

function todoStartEdit(idx, el){
  el.classList.add('editing');
  const input = el.querySelector('.mtr-row-name-edit');
  input.value = todoState.tasks[idx].name;
  setTimeout(()=>{ input.focus(); input.select(); }, 10);
  input.onkeydown = e => { if (e.key==='Enter'||e.key==='Escape') todoFinishEdit(idx, el); };
  input.onblur = () => todoFinishEdit(idx, el);
}
function todoFinishEdit(idx, el){
  if (!el.classList.contains('editing')) return;
  const val = el.querySelector('.mtr-row-name-edit').value.trim();
  if (val) todoState.tasks[idx].name = val;
  else if (!todoState.tasks[idx].name) todoState.tasks[idx].name = 'Untitled priority';
  el.classList.remove('editing'); todoSave(); todoRenderItem(idx);
}

function todoAddTask(){
  if (todoState.tasks.length >= TODO_MAX) return;
  todoState.tasks.push({ name: '', done: false, time: null });
  todoSave(); todoRenderList(); todoUpdateStats();
  const idx = todoState.tasks.length - 1;
  const list = document.getElementById('td-list');
  if (list.lastElementChild) todoStartEdit(idx, list.lastElementChild);
}

function todoDeleteTask(idx){
  const t = todoState.tasks[idx];
  if (!confirm(`Delete "${t.name || 'this priority'}"?`)) return;
  todoState.tasks.splice(idx, 1);
  todoSave(); todoRenderList(); todoUpdateStats();
  todoAddLog('Priority removed');
}

function todoResetDay(){
  const done = todoState.tasks.filter(t=>t.done).length;
  const total = todoState.tasks.length;
  if (total > 0) todoState.history[todoGetToday()] = { done, total };
  todoState.tasks = [];
  todoState.log = [];
  todoCelebrated = false;
  closeModal('modal-todo-done');
  document.getElementById('td-ring-fill').classList.remove('animate');
  document.getElementById('td-pct').textContent = '0%';
  todoSave();
  todoRenderList(); todoUpdateStats(); todoRenderLog();
  todoAddLog('Day reset - fresh slate');
}

function todoRenderAll(){
  todoRenderList();
  todoUpdateStats();
  todoRenderLog();
  const done = todoState.tasks.filter(t=>t.done).length, total = todoState.tasks.length;
  todoCelebrated = total >= TODO_MIN_FOR_WIN && done === total;
}

document.addEventListener('DOMContentLoaded', todoRenderAll);
