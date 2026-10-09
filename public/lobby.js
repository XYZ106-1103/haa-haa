/* 최후의 섬 — 첫 화면(로비)과 서버 연결
   - 혼자 하기: 서버 없이 바로 게임 시작 (파일로 직접 열어도 동작)
   - 방 만들기 / 코드로 참가: /ws 웹소켓으로 서버에 연결
   - 게임이 시작되면 window.runIslandGame(cfg)에 link(전송 통로)를 넘깁니다. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const IS_TOUCH = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || (('ontouchstart' in window) && navigator.maxTouchPoints > 0);
  const LS = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } } };
  const SS = { get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { } }, del: k => { try { sessionStorage.removeItem(k); } catch (e) { } } };
  const SLOT_COL = ['#ffb43c', '#ff7a6a', '#6ab8ff', '#d8e060'];
  const TOTAL = 100;
  const canNet = location.protocol === 'http:' || location.protocol === 'https:';

  let ws = null, myId = null, room = null, started = false, link = null, wantJoin = null, reconnectT = 0, pingT = 0;

  /* ---------- 공통 UI ---------- */
  function setStatus(t, err) { const el = $('lbStatus'); el.textContent = t; el.classList.toggle('err', !!err); }
  function roomStatus(t, err) { const el = $('lbRoomStatus'); el.textContent = t || ''; el.classList.toggle('err', !!err); }
  function currentName() { return ($('lbName').value || '').replace(/[<>&"'`\\]/g, '').trim().slice(0, 12); }
  function ensureName() {
    let n = currentName();
    if (!n) { n = '생존자' + Math.floor(100 + Math.random() * 900); $('lbName').value = n; }
    LS.set('island.name', n); SS.set('island.name', n);   // 탭마다 다른 이름을 쓸 수 있게 세션에도 저장
    return n;
  }
  function setNetButtons(on) {
    for (const id of ['lbCreate', 'lbJoin', 'lbRefresh']) $(id).disabled = !on;
  }
  function showHome() {
    $('lbHome').classList.remove('lb-hide');
    $('lbRoom').classList.add('lb-hide');
  }
  function wsSend(o) { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch (e) { } } }

  /* ---------- 혼자 하기 ---------- */
  function startSolo() {
    if (started) return;
    if (typeof window.runIslandGame !== 'function') { setStatus('게임 스크립트를 불러오지 못했습니다. 새로고침하세요.', true); return; }
    started = true;
    ensureName();
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) { } ws = null; }
    clearTimeout(reconnectT); clearInterval(pingT);
    $('lobby').style.display = 'none';
    $('menu').style.display = '';
    window.runIslandGame({ mode: 'solo' });
  }

  /* ---------- 서버 연결 ---------- */
  function connect() {
    if (started) return;
    if (!canNet) {
      setNetButtons(false);
      setStatus('파일을 직접 열었습니다. 멀티플레이는 서버 주소(예: http://localhost:3000)로 접속해야 합니다. 혼자 하기는 바로 가능합니다.', true);
      return;
    }
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    try { ws = new WebSocket(url); } catch (e) { setStatus('서버에 연결할 수 없습니다. 혼자 하기는 가능합니다.', true); return; }
    setStatus('서버에 연결하는 중…');
    ws.onopen = () => {
      wsSend({ t: 'hello', name: ensureName(), touch: IS_TOUCH });
      clearInterval(pingT);
      pingT = setInterval(() => wsSend({ t: 'ping', ts: Date.now() }), 20000);
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      try { onMsg(m); } catch (err) { console.error('로비 메시지 처리 오류', err); }
    };
    ws.onerror = () => { };
    ws.onclose = () => {
      clearInterval(pingT);
      ws = null; myId = null;
      if (started) { if (link && link.onDisconnect) link.onDisconnect(); return; }
      room = null; showHome(); setNetButtons(false);
      setStatus('서버와 연결이 끊겼습니다. 다시 연결하는 중… (혼자 하기는 가능합니다)', true);
      clearTimeout(reconnectT); reconnectT = setTimeout(connect, 2500);
    };
  }

  function onMsg(m) {
    switch (m.t) {
      case 'welcome':
        myId = m.id; setNetButtons(true);
        setStatus('서버 연결됨 · 방을 만들거나 방 코드로 참가하세요');
        if (wantJoin) { const c = wantJoin; wantJoin = null; wsSend({ t: 'join', code: c }); }
        break;
      case 'rooms': renderRooms(m.list || []); break;
      case 'room': room = m.room; renderRoom(); break;
      case 'err': if (room) roomStatus(m.msg, true); else setStatus(m.msg, true); break;
      case 'start': onStart(m); break;
      case 'go': if (link && link.onGo) link.onGo(m); break;
      case 'left': if (link && link.onLeft) link.onLeft(m.id); break;
      case 'host': if (link && link.onHost) link.onHost(m.id); break;
      case 'kicked': if (link && link.onKicked) link.onKicked(m.msg); break;
      case 'r': if (link && link.onMessage) link.onMessage(m.f, m.d); break;
    }
  }

  /* ---------- 방 목록 / 방 화면 ---------- */
  function renderRooms(list) {
    const box = $('lbRooms'); box.innerHTML = '';
    const open = list.filter(r => r.state === 'lobby' && r.count < r.max);
    if (!open.length) { const d = document.createElement('div'); d.className = 'lb-empty'; d.textContent = '참가할 수 있는 방이 아직 없습니다.'; box.appendChild(d); return; }
    for (const r of open) {
      const row = document.createElement('div'); row.className = 'lb-room';
      const left = document.createElement('div');
      const code = document.createElement('b'); code.textContent = r.code;
      const info = document.createElement('span'); info.textContent = r.host + '의 방 ';
      const sm = document.createElement('small'); sm.textContent = `${r.count}/${r.max}명 · ${r.team ? '협동전' : '개인전'}`;
      left.append(code, info, sm);
      const btn = document.createElement('button'); btn.className = 'lb-btn'; btn.textContent = '참가';
      btn.addEventListener('click', () => joinRoom(r.code));
      row.append(left, btn); box.appendChild(row);
    }
  }
  function renderRoom() {
    if (!room) { showHome(); return; }
    $('lbHome').classList.add('lb-hide'); $('lbRoom').classList.remove('lb-hide');
    $('lbRoomCode').textContent = room.code;
    const ul = $('lbPlayers'); ul.innerHTML = '';
    for (let i = 0; i < room.max; i++) {
      const mem = room.members[i], li = document.createElement('li');
      if (mem) {
        const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = SLOT_COL[i % 4];
        const nm = document.createElement('span'); nm.textContent = mem.name + (mem.id === myId ? ' (나)' : '');
        li.append(dot, nm);
        if (mem.id === room.hostId) { const t = document.createElement('span'); t.className = 'tag host'; t.textContent = '방장'; li.appendChild(t); }
        else if (room.state !== 'lobby' && mem.inGame) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = '게임 중'; li.appendChild(t); }
      } else { li.className = 'empty'; li.textContent = '빈 자리'; }
      ul.appendChild(li);
    }
    const isHost = room.hostId === myId, n = room.members.length;
    $('lbFfa').classList.toggle('on', !room.team); $('lbTeam').classList.toggle('on', !!room.team);
    $('lbFfa').disabled = $('lbTeam').disabled = !isHost || room.state !== 'lobby';
    $('lbInfo').innerHTML = `플레이어 <b>${n}</b>명 + 봇 <b>${TOTAL - n}</b>명<br>` +
      (room.team ? '협동전: 플레이어끼리 한 팀입니다. 봇을 모두 쓰러뜨리면 살아남은 플레이어 모두 승리합니다.' : '개인전: 플레이어끼리도 적입니다. 마지막 1명이 승리합니다.');
    const st = $('lbStart');
    if (room.state === 'playing') { st.disabled = true; st.textContent = '게임 진행 중…'; roomStatus('지금 진행 중인 판이 끝나면 함께 시작할 수 있습니다.'); }
    else if (room.state === 'loading') { st.disabled = true; st.textContent = '섬을 만드는 중…'; roomStatus(''); }
    else if (isHost) { st.disabled = false; st.textContent = n > 1 ? `게임 시작 (${n}명)` : '게임 시작 (혼자)'; roomStatus(n > 1 ? '모두 모였으면 시작하세요.' : '친구에게 방 코드를 알려주세요. 혼자서도 시작할 수 있습니다.'); }
    else { st.disabled = true; st.textContent = '방장이 시작하기를 기다리는 중'; roomStatus(''); }
  }
  function joinRoom(code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (code.length !== 5) { setStatus('방 코드 5자리를 입력하세요.', true); return; }
    ensureName();
    if (!myId) { wantJoin = code; setStatus('서버에 연결되면 참가합니다…'); return; }
    wsSend({ t: 'name', name: ensureName() });
    wsSend({ t: 'join', code });
  }

  /* ---------- 게임 시작 ---------- */
  function onStart(m) {
    if (started) return;
    if (typeof window.runIslandGame !== 'function') { roomStatus('게임 스크립트를 불러오지 못했습니다.', true); return; }
    started = true;
    const me = (m.players || []).find(p => p.id === myId);
    link = {
      send(d, to) {
        if (!ws || ws.readyState !== 1) return;
        try { ws.send(JSON.stringify(to ? { t: 'r', to, d } : { t: 'r', d })); } catch (e) { }
      },
      loaded(hash) { wsSend({ t: 'loaded', hash }); },
      onGo: null, onMessage: null, onLeft: null, onHost: null, onDisconnect: null, onKicked: null
    };
    $('lobby').style.display = 'none';
    $('menu').style.display = '';
    window.runIslandGame({
      mode: 'mp', seed: m.seed, low: !!m.low, team: !!m.team, botN: m.botN, players: m.players,
      myId, myName: me ? me.name : ensureName(), hostId: m.hostId, link, roomCode: room ? room.code : ''
    });
  }

  /* ---------- 이벤트 ---------- */
  $('lbName').value = SS.get('island.name') || LS.get('island.name') || '';
  $('lbName').addEventListener('change', () => { const n = ensureName(); wsSend({ t: 'name', name: n }); });
  $('lbSolo').addEventListener('click', startSolo);
  $('lbCreate').addEventListener('click', () => { wsSend({ t: 'name', name: ensureName() }); wsSend({ t: 'create', team: false }); });
  $('lbJoin').addEventListener('click', () => joinRoom($('lbCode').value));
  $('lbCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('lbCode').value); });
  $('lbCode').addEventListener('input', () => { const el = $('lbCode'); el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
  $('lbRefresh').addEventListener('click', () => wsSend({ t: 'list' }));
  $('lbLeave').addEventListener('click', () => { wsSend({ t: 'leave' }); room = null; showHome(); setStatus('방에서 나왔습니다.'); });
  $('lbStart').addEventListener('click', () => { if (room && room.hostId === myId) wsSend({ t: 'start' }); });
  $('lbFfa').addEventListener('click', () => wsSend({ t: 'team', team: false }));
  $('lbTeam').addEventListener('click', () => wsSend({ t: 'team', team: true }));
  $('lbCopy').addEventListener('click', () => {
    const code = room ? room.code : ''; if (!code) return;
    const done = () => { $('lbCopy').textContent = '복사됨'; setTimeout(() => { $('lbCopy').textContent = '코드 복사'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, () => window.prompt('방 코드', code));
    else window.prompt('방 코드', code);
  });
  // 방 목록 주기적 갱신
  setInterval(() => { if (!started && !room && myId) wsSend({ t: 'list' }); }, 5000);

  // 결과 화면에서 돌아온 경우
  const autoSolo = SS.get('island.autoSolo'), rejoin = SS.get('island.rejoin');
  SS.del('island.autoSolo'); SS.del('island.rejoin');
  if (autoSolo) { startSolo(); return; }
  if (rejoin) wantJoin = rejoin;
  setNetButtons(false);
  connect();
})();
