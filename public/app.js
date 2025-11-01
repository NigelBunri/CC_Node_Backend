// ===== helpers =====
const $ = (id) => document.getElementById(id);
const nowTime = () => new Date().toLocaleTimeString();
const base64Decode = (b64) => { try { return decodeURIComponent(escape(atob(String(b64).replace(/^BASE64:/,'')))); } catch { return b64; } };
const ensureString = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
const sizeStr = (n) => n>=1024*1024 ? (n/1024/1024).toFixed(1)+' MB' : n>=1024 ? (n/1024).toFixed(1)+' KB' : n+' B';
const SIDES = ['A','B','C','D'];

function mkClientId(){ return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2); }
function hashStr(str){ let h=0; for (let i=0;i<str.length;i++) h=((h*31)+str.charCodeAt(i))|0; return String(h); }
function sideLogBox(side){ return side==='A'?'logsA':side==='B'?'logsB':side==='C'?'logsC':'logsD'; }

function appendBubble({ threadId, who, text, mine }) {
  if (!text) return;
  const thread = document.getElementById(threadId); if (!thread) return;
  const wrap = document.createElement('div');
  wrap.className = `msg ${mine ? 'me' : 'other'}`;
  wrap.innerText = text;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span class="who">${who}</span><span class="time">${nowTime()}</span>`;
  wrap.appendChild(meta);
  thread.appendChild(wrap);
  thread.scrollTop = thread.scrollHeight;
}

function appendAttachmentBubble({ threadId, who, att, mine }) {
  const thread = document.getElementById(threadId); if (!thread) return;
  const wrap = document.createElement('div'); wrap.className = `msg ${mine?'me':'other'}`;
  const tile = document.createElement('div'); tile.className = 'att-tile';
  if ((att.mime||'').startsWith('image/')) {
    const img = document.createElement('img'); img.src = att.url; img.alt = att.name; img.style.maxWidth='240px'; img.style.borderRadius='10px';
    tile.appendChild(img); const name = document.createElement('div'); name.className='att-file'; name.textContent=`${att.name} • ${sizeStr(att.size||0)}`; tile.appendChild(name);
  } else if ((att.mime||'').startsWith('video/')) {
    const v=document.createElement('video'); v.src=att.url; v.controls=true; v.style.maxWidth='260px'; tile.appendChild(v);
    const name=document.createElement('div'); name.className='att-file'; name.textContent=`${att.name} • ${sizeStr(att.size||0)}`; tile.appendChild(name);
  } else if ((att.mime||'').startsWith('audio/')) {
    const a=document.createElement('audio'); a.src=att.url; a.controls=true; tile.appendChild(a);
    const name=document.createElement('div'); name.className='att-file'; name.textContent=`${att.name} • ${sizeStr(att.size||0)}`; tile.appendChild(name);
  } else if ((att.mime||'')==='application/pdf') {
    const link=document.createElement('a'); link.href=att.url; link.target='_blank'; link.textContent=`📄 ${att.name}`; link.className='att-link'; tile.appendChild(link);
    const name=document.createElement('div'); name.className='att-file'; name.textContent=`${sizeStr(att.size||0)}`; tile.appendChild(name);
  } else {
    const link=document.createElement('a'); link.href=att.url; link.target='_blank'; link.download=att.name; link.textContent=`⬇️ ${att.name}`; link.className='att-link'; tile.appendChild(link);
    const name=document.createElement('div'); name.className='att-file'; name.textContent=`${att.mime||'file'} • ${sizeStr(att.size||0)}`; tile.appendChild(name);
  }
  const meta=document.createElement('div'); meta.className='meta'; meta.innerHTML=`<span class="who">${who}</span><span class="time">${nowTime()}</span>`;
  wrap.appendChild(tile); wrap.appendChild(meta); thread.appendChild(wrap); thread.scrollTop = thread.scrollHeight;
}

function log(box, ...args) {
  const el = $(box); const line=document.createElement('div');
  line.textContent = `[${nowTime()}] ` + args.map(ensureString).join(' ');
  el.appendChild(line); el.scrollTop=el.scrollHeight;
}

function flashButton(id){
  const el=$(id); if (!el) return; const old=el.style.boxShadow;
  el.style.boxShadow='0 0 0 2px rgba(239,68,68,.8)'; setTimeout(()=>{ el.style.boxShadow=old; },600);
}

// ===== state =====
const state = {
  serverUrl: '',
  wsPath: '/ws',
  rooms: [], // {id,name,createdAt}
  // per-side socket + membership + activeRoom + files
  A: { socket:null, joined:new Set(), activeRoom:null, files:[], label:'A' },
  B: { socket:null, joined:new Set(), activeRoom:null, files:[], label:'B' },
  C: { socket:null, joined:new Set(), activeRoom:null, files:[], label:'C' },
  D: { socket:null, joined:new Set(), activeRoom:null, files:[], label:'D' },
  typingNamesByRoom: new Map(), // conversationId -> Set(names)
};
// dedupe trackers
const sentLocal = new Map(); // clientId -> { side, conversationId }
const lastLocalEcho = { A:null, B:null, C:null, D:null };

function currentServer(){ return state.serverUrl || window.location.origin; }
function updatePresence(){
  const fmt = (s)=> (s.socket && s.joined.size>0) ? `✅ ${s.joined.size} room(s)` : (s.socket ? 'connected' : '—');
  $('presence').textContent = `A: ${fmt(state.A)} | B: ${fmt(state.B)} | C: ${fmt(state.C)} | D: ${fmt(state.D)}`;
}
function nameForSide(side){ return side; }

// ===== Room list UI =====
function updateRoomListUI(){
  const box = $('roomList');
  box.innerHTML = '';
  state.rooms.forEach(r=>{
    const row = document.createElement('div');
    row.className = 'row';
    row.style.justifyContent = 'space-between';
    row.style.margin = '4px 0';
    const label = document.createElement('div');
    label.innerHTML = `<span class="small">${r.name ? `<b>${r.name}</b> ` : ''}<code>${r.id}</code></span>`;
    const actions = document.createElement('div');
    SIDES.forEach(side=>{
      const joined = state[side].joined.has(r.id);
      const btn = document.createElement('button');
      btn.className = 'ghost small';
      btn.textContent = joined ? `Leave ${side}` : `Join ${side}`;
      btn.onclick = () => toggleJoin(side, r.id); // immediate toggle
      actions.appendChild(btn);
    });
    row.appendChild(label); row.appendChild(actions);
    box.appendChild(row);
  });
  updateActiveRoomSelects();
}

function updateActiveRoomSelects(){
  SIDES.forEach(side=>{
    const sel = $('activeRoom'+side);
    if (!sel) return;
    sel.innerHTML = '';
    const joinedList = [...state[side].joined];
    if (joinedList.length === 0) {
      const opt=document.createElement('option'); opt.value=''; opt.textContent='(join a room)'; sel.appendChild(opt);
      state[side].activeRoom = null;
    } else {
      joinedList.forEach(id=>{
        const opt=document.createElement('option'); opt.value=id;
        const meta = state.rooms.find(r=>r.id===id);
        opt.textContent = meta?.name ? `${meta.name} (${id})` : id;
        sel.appendChild(opt);
      });
      if (!state[side].activeRoom || !state[side].joined.has(state[side].activeRoom)) {
        state[side].activeRoom = joinedList[0];
      }
      sel.value = state[side].activeRoom || '';
    }
  });
  refreshActiveLabels();
  updateRoomControls();
}

function updateRoomControls() {
  SIDES.forEach(side => {
    const btn = $('send' + side);
    if (!btn) return;
    const ok = !!(state[side].socket && state[side].activeRoom && state[side].joined.has(state[side].activeRoom));
    btn.disabled = !ok;
  });
}

function refreshActiveLabels(){
  SIDES.forEach(side=>{
    const lab = $('activeLabel'+side);
    const id = state[side].activeRoom;
    const meta = state.rooms.find(r=>r.id===id);
    if (lab) lab.textContent = id ? (meta?.name ? `${meta.name} (${id})` : id) : '(no room selected)';
  });
}

// ===== per-user chat boxes =====
function renderUserBoxes() {
  const grid = $('roomsGrid'); grid.innerHTML = '';
  SIDES.forEach(side=>{
    const wrap = document.createElement('div'); wrap.className='room';
    wrap.innerHTML = `
      <div class="room-head">
        <div class="row" style="gap:6px">
          <span class="badge">User ${side}</span>
          <span class="muted small" id="activeLabel${side}"></span>
        </div>
      </div>
      <div id="thread${side}" class="thread"></div>
      <div id="typing${side}" class="typing"></div>
      <div class="composer">
        <input id="composer${side}" placeholder="Type as ${side}…" style="flex:1" />
        <input id="file${side}" type="file" multiple style="max-width:240px" />
        <button id="send${side}" class="primary" disabled>Send</button>
      </div>
    `;
    grid.appendChild(wrap);

    $('file'+side).addEventListener('change', (e)=> { state[side].files = [...e.target.files]; });
    $('send'+side).onclick = async () => {
      const text = $('composer'+side).value.trim();
      await sendWithFilesPerSide(side, text);
    };

    // typing
    let tmr;
    $('composer'+side).addEventListener('input', ()=>{
      const s = state[side].socket, conversationId = state[side].activeRoom;
      if (!s || !conversationId || !state[side].joined.has(conversationId)) return;
      const who = nameForSide(side);
      if (!state.typingNamesByRoom.has(conversationId)) state.typingNamesByRoom.set(conversationId, new Set());
      state.typingNamesByRoom.get(conversationId).add(who);
      renderTypingForRoom(conversationId);
      s.emit('typing', { conversationId, isTyping:true, senderName: who });
      clearTimeout(tmr);
      tmr = setTimeout(()=>{
        s.emit('typing', { conversationId, isTyping:false, senderName: who });
        state.typingNamesByRoom.get(conversationId)?.delete(who);
        renderTypingForRoom(conversationId);
      }, 1000);
    });
  });
  updateRoomControls();
  refreshActiveLabels();
}

function renderTypingForRoom(conversationId){
  const set = state.typingNamesByRoom.get(conversationId) || new Set();
  const names = [...set];
  SIDES.forEach(side=>{
    const el = $('typing'+side);
    if (!el) return;
    const show = state[side].joined.has(conversationId) && state[side].activeRoom === conversationId;
    el.textContent = show && names.length ? `${names.join(', ')} typing…` : '';
  });
}

// ===== server controls =====
$('serverUrl').value = '';
$('wsPath').value = '/ws';

$('applyServer').onclick = () => {
  state.serverUrl = $('serverUrl').value.trim();
  state.wsPath = $('wsPath').value.trim() || '/ws';
  log('logs', 'Applied →', currentServer(), 'path:', state.wsPath);
};

// ===== uploads =====
async function uploadLocalFile(file) {
  const fd = new FormData(); fd.append('file', file);
  const res = await fetch('/uploads/file', { method:'POST', body: fd });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'upload failed');
  return json.attachment;
}

// ===== send per side & room (with dedupe) =====
async function sendWithFilesPerSide(side, text) {
  const s = state[side].socket; const conversationId = state[side].activeRoom;
  if (!s) { log(sideLogBox(side), '❗ Not connected.'); flashButton('connect'+side); return; }
  if (!conversationId) { log(sideLogBox(side), '❗ No active room. Join and select one.'); return; }
  if (!state[side].joined.has(conversationId)) { log(sideLogBox(side), `❗ Not joined to room ${conversationId}.`); return; }

  const files = state[side].files || [];
  const attachments = [];
  for (const f of files) {
    try { attachments.push(await uploadLocalFile(f)); } catch (e) { log(sideLogBox(side), 'upload error:', String(e)); }
  }

  const clientId = mkClientId();
  const payload = {
    clientId,
    conversationId,
    senderName: side,
    ciphertext: text ? btoa(unescape(encodeURIComponent(text))) : undefined,
    attachments,
  };
  if (!payload.ciphertext && (!attachments || attachments.length === 0)) return;

  // local echo (sender’s box)
  if (text) appendBubble({ threadId:`thread${side}`, who: side, text, mine: true });
  attachments.forEach(att=> appendAttachmentBubble({ threadId:`thread${side}`, who: side, att, mine:true }));

  // track dedupe
  sentLocal.set(clientId, { side, conversationId });
  const chash = payload.ciphertext ? hashStr(payload.ciphertext) : 'att:' + attachments.map(a=>a.id||a.url).join(',');
  lastLocalEcho[side] = { t: Date.now(), conversationId, chash };
  setTimeout(()=>{ sentLocal.delete(clientId); }, 60_000);

  s.emit('chat.send', payload, (ack)=> {
    if (!ack || ack.ok === false) {
      log(sideLogBox(side), '❗ chat.send rejected:', ack?.error || 'unknown');
    } else {
      log(sideLogBox(side), 'chat.send → ok id=', ack.id);
    }
  });

  // clear
  $('composer'+side).value = ''; const fi=$('file'+side); if (fi) fi.value='';
  state[side].files = [];
  s.emit('typing', { conversationId, isTyping:false, senderName: side });
  state.typingNamesByRoom.get(conversationId)?.delete(side);
  renderTypingForRoom(conversationId);
}

// ===== sockets per side =====
function wireSocket(side, token, statusId, logBox, disconnectBtnId) {
  const s = io(currentServer(), { path: state.wsPath, auth:{ token }, transports:['websocket','polling'] });

  s.on('connect', ()=>{
    $(statusId).innerHTML = `<span class="ok small">connected</span> <span class="muted small">(${s.id})</span>`;
    $(disconnectBtnId).disabled = false;
    log(logBox, 'connected', s.id);
    s.emit('room.list');
  });

  s.on('connect_error', (err)=>{ $(statusId).innerHTML=`<span class="err small">connect_error</span>`; log(logBox, 'connect_error', err?.message||err); });
  s.on('disconnect', (reason)=>{ $(statusId).innerHTML=`<span class="muted small">disconnected (${reason})</span>`; state[side].joined.clear(); state[side].activeRoom=null; updatePresence(); updateActiveRoomSelects(); updateRoomControls(); log(logBox,'disconnected',reason); });

  // rooms list updates
  s.on('rooms.update', (list)=> {
    state.rooms = list || [];
    updateRoomListUI();
  });

  // creator ack
  s.on('room.created', (r)=> {
    log(logBox, 'room.created ←', r);
    // mark joined (creator auto-joined on server)
    state[side].joined.add(r.id);
    if (!state[side].activeRoom) state[side].activeRoom = r.id;
    updatePresence(); updateActiveRoomSelects(); updateRoomControls(); refreshActiveLabels();
  });

  // joined/left ack (optional UI)
  s.on('chat.joined', ({ conversationId })=>{
    log(logBox, 'chat.joined ←', conversationId);
  });
  s.on('chat.left', ({ conversationId })=>{
    log(logBox, 'chat.left ←', conversationId);
  });

  // incoming messages
  s.on('chat.message', (m)=>{
    const conversationId = m?.conversationId;
    const text =
      (m && typeof m.text === 'string' && m.text) ||
      (m && typeof m.message === 'string' && m.message) ||
      (m && typeof m.ciphertext === 'string' && base64Decode(m.ciphertext)) ||
      null;
    const sender = (m && (m.senderName||m.sender||m.user||m.from||m.who||m.senderId)) || 'Someone';
    const cid = m?.clientId;

    const incomingHash = m?.ciphertext
      ? hashStr(m.ciphertext)
      : (Array.isArray(m?.attachments) && m.attachments.length
          ? 'att:' + m.attachments.map(a=>a.id||a.url).join(',')
          : '');

    SIDES.forEach((sideX)=>{
      // only render if user joined this conversation
      if (!state[sideX].joined.has(conversationId)) return;

      const mine = (sender === sideX);
      // de-dupe
      let skip=false;
      if (cid) {
        const rec = sentLocal.get(cid);
        if (rec && rec.side===sideX && rec.conversationId===conversationId) skip=true;
      } else if (mine && lastLocalEcho[sideX] && lastLocalEcho[sideX].conversationId===conversationId) {
        const age = Date.now()-lastLocalEcho[sideX].t;
        if (age<2000 && lastLocalEcho[sideX].chash && incomingHash && lastLocalEcho[sideX].chash===incomingHash) skip=true;
      }
      if (skip) return;

      if (text) appendBubble({ threadId:`thread${sideX}`, who: sender, text, mine });
      (m.attachments||[]).forEach(att=> appendAttachmentBubble({ threadId:`thread${sideX}`, who: sender, att, mine }));
    });

    log('logs', 'chat.message ←', { conversationId, sender, cid });
  });

  // typing
  s.on('typing', (t)=>{
    const conversationId = t?.conversationId; const who = t?.senderName||'Someone';
    const isTyping = !!t?.isTyping;
    if (!conversationId) return;

    if (!state.typingNamesByRoom.has(conversationId)) state.typingNamesByRoom.set(conversationId, new Set());
    const set = state.typingNamesByRoom.get(conversationId);
    if (isTyping) set.add(who); else set.delete(who);
    renderTypingForRoom(conversationId);
  });

  state[side].socket = s;
}

function toggleJoin(side, conversationId){
  const s = state[side].socket;
  if (!s) { log(sideLogBox(side), '❗ Not connected.'); flashButton('connect'+side); return; }
  const isJoined = state[side].joined.has(conversationId);

  if (isJoined) {
    // optimistic UI
    state[side].joined.delete(conversationId);
    if (state[side].activeRoom === conversationId) state[side].activeRoom = null;
    s.emit('chat.leave', { conversationId }, (ack)=>{ log(sideLogBox(side), 'chat.leave ack:', ack); });
  } else {
    // optimistic UI
    state[side].joined.add(conversationId);
    if (!state[side].activeRoom) state[side].activeRoom = conversationId;
    s.emit('chat.join', { conversationId }, (ack)=>{ log(sideLogBox(side), 'chat.join ack:', ack); });
  }

  updatePresence(); updateActiveRoomSelects(); updateRoomControls(); refreshActiveLabels(); updateRoomListUI();
}

// ===== UI wiring =====
$('serverUrl').value = '';
$('wsPath').value = '/ws';

$('createRoom').onclick = ()=>{
  const side = SIDES.find(s=>!!state[s].socket) || 'A';
  const s = state[side].socket; if (!s) { log('logs', '❗ No connected users to create a room.'); return; }
  const roomId = $('newRoomId').value.trim() || undefined;
  const name = $('newRoomName').value.trim() || undefined;
  s.emit('room.create', { roomId, name });
  $('newRoomId').value=''; $('newRoomName').value='';
};

$('refreshRooms').onclick = ()=>{
  const side = SIDES.find(s=>!!state[s].socket);
  if (!side) { log('logs', '❗ No connected users to refresh.'); return; }
  state[side].socket.emit('room.list');
};

// connect & disconnect
$('connectA').onclick = ()=> wireSocket('A', $('tokenA').value.trim(), 'statusA', 'logsA', 'disconnectA');
$('connectB').onclick = ()=> wireSocket('B', $('tokenB').value.trim(), 'statusB', 'logsB', 'disconnectB');
$('connectC').onclick = ()=> wireSocket('C', $('tokenC').value.trim(), 'statusC', 'logsC', 'disconnectC');
$('connectD').onclick = ()=> wireSocket('D', $('tokenD').value.trim(), 'statusD', 'logsD', 'disconnectD');

$('disconnectA').onclick = ()=> { try{ state.A.socket?.disconnect(); }catch{} state.A.socket=null; state.A.joined.clear(); state.A.activeRoom=null; updatePresence(); updateActiveRoomSelects(); updateRoomControls(); };
$('disconnectB').onclick = ()=> { try{ state.B.socket?.disconnect(); }catch{} state.B.socket=null; state.B.joined.clear(); state.B.activeRoom=null; updatePresence(); updateActiveRoomSelects(); updateRoomControls(); };
$('disconnectC').onclick = ()=> { try{ state.C.socket?.disconnect(); }catch{} state.C.socket=null; state.C.joined.clear(); state.C.activeRoom=null; updatePresence(); updateActiveRoomSelects(); updateRoomControls(); };
$('disconnectD').onclick = ()=> { try{ state.D.socket?.disconnect(); }catch{} state.D.socket=null; state.D.joined.clear(); state.D.activeRoom=null; updatePresence(); updateActiveRoomSelects(); updateRoomControls(); };

// Active room selectors (per side)
SIDES.forEach(side=>{
  document.addEventListener('change', (e)=>{
    const sel = $('activeRoom'+side);
    if (e.target === sel) {
      state[side].activeRoom = sel.value || null;
      updateRoomControls(); refreshActiveLabels();
    }
  });
});

// initial render
renderUserBoxes();
updatePresence();
