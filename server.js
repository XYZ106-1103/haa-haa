'use strict';
/*
 * 최후의 섬 — 멀티플레이 서버
 * - public/ 폴더의 정적 파일 제공 (게임 페이지)
 * - /ws 웹소켓: 방 만들기/참가, 게임 시작 신호, 게임 메시지 중계, 방장 승계
 * 게임 시뮬레이션 자체는 브라우저(방장)가 맡고, 서버는 중계만 합니다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUB = path.join(__dirname, 'public');
const MAX_PLAYERS = 4;
const TOTAL_SLOTS = 100;          // 플레이어 + 봇 = 100
const LOAD_TIMEOUT_MS = 150000;   // 월드 생성 대기 한도
const MAX_MSG = 256 * 1024;
const EMPTY_ROOM_MS = 60000;      // 빈 방 유지 시간

/* ---------------- 정적 파일 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
const gzCache = new Map();

function serveStatic(req, res) {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  if (u.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  let p;
  try { p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/' || p === '') p = '/index.html';
  const fp = path.normalize(path.join(PUB, p));
  if (!fp.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /text|javascript|json|svg/.test(type);
    fs.readFile(fp, (err2, buf) => {
      if (err2) { res.writeHead(500); return res.end(); }
      if (gz) {
        const key = fp + ':' + st.mtimeMs;
        let z = gzCache.get(key);
        if (!z) { z = zlib.gzipSync(buf, { level: 6 }); gzCache.set(key, z); }
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
        buf = z;
      }
      headers['Content-Length'] = buf.length;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  });
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG });

/* ---------------- 상태 ---------------- */
const clients = new Map();   // id -> client
const rooms = new Map();     // code -> room
let nextId = 1;

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s;
  do { s = ''; for (let i = 0; i < 5; i++) s += A[crypto.randomInt(A.length)]; } while (rooms.has(s));
  return s;
}
function cleanName(n) {
  n = String(n || '').replace(/[<>&"'`\\\u0000-\u001f]/g, '').trim().slice(0, 12);
  return n || ('생존자' + Math.floor(100 + Math.random() * 900));
}
function send(c, obj) {
  if (c && c.ws.readyState === 1) {
    try { c.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (e) { /* 무시 */ }
  }
}
function roomView(r) {
  return {
    code: r.code, hostId: r.hostId, state: r.state, team: r.team, max: MAX_PLAYERS,
    members: r.members.map(id => { const c = clients.get(id); return { id, name: c ? c.name : '?', inGame: !!(r.match && r.match.inGame.has(id)) }; })
  };
}
function broadcastRoom(r) { const v = { t: 'room', room: roomView(r) }; for (const id of r.members) send(clients.get(id), v); }
function roomList() {
  const list = [];
  for (const r of rooms.values()) {
    if (!r.members.length) continue;
    const host = clients.get(r.hostId);
    list.push({ code: r.code, host: host ? host.name : '?', count: r.members.length, max: MAX_PLAYERS, state: r.state, team: r.team });
  }
  return list.slice(0, 30);
}
function sendList(c) { send(c, { t: 'rooms', list: roomList() }); }

function leaveRoom(c, reason) {
  const r = c.room ? rooms.get(c.room) : null;
  c.room = null;
  if (!r) return;
  r.members = r.members.filter(id => id !== c.id);
  const m = r.match;
  const wasInGame = !!(m && m.inGame.has(c.id));
  if (m) { m.inGame.delete(c.id); m.loaded.delete(c.id); }
  if (r.members.length === 0) {
    // 결과 화면에서 "방으로 돌아가기"로 새로고침하는 사람이 다시 들어올 수 있게 잠시 유지
    if (m && m.timer) clearTimeout(m.timer);
    r.match = null; r.state = 'lobby'; r.hostId = null;
    clearTimeout(r.emptyTimer);
    r.emptyTimer = setTimeout(() => { if (!r.members.length) rooms.delete(r.code); }, EMPTY_ROOM_MS);
    return;
  }

  // 진행 중인 게임 참가자에게 이탈 알림
  if (m && wasInGame) {
    for (const id of m.inGame) send(clients.get(id), { t: 'left', id: c.id, reason: reason || 'leave' });
  }
  // 방장 승계: 게임 중이면 게임 참가자 중에서, 아니면 가장 먼저 들어온 사람
  if (r.hostId === c.id) {
    let nh = null;
    if (m && m.inGame.size) nh = r.members.find(id => m.inGame.has(id)) || null;
    if (!nh) nh = r.members[0];
    r.hostId = nh;
    if (m && m.inGame.size) for (const id of m.inGame) send(clients.get(id), { t: 'host', id: nh });
  }
  if (m) {
    if (r.state === 'loading') maybeGo(r);
    if (m.inGame.size === 0) endMatch(r);
  }
  broadcastRoom(r);
}

function endMatch(r) {
  if (r.match && r.match.timer) clearTimeout(r.match.timer);
  r.match = null;
  r.state = 'lobby';
  if (!clients.has(r.hostId) || !r.members.includes(r.hostId)) r.hostId = r.members[0];
}

function startMatch(r) {
  const players = r.members.map((id, i) => ({ id, name: clients.get(id).name, slot: i }));
  const low = r.members.some(id => clients.get(id).touch);
  const seed = crypto.randomInt(1, 2147483647);
  r.state = 'loading';
  r.match = { seed, players, low, inGame: new Set(r.members), loaded: new Set(), hashes: {}, timer: null, started: Date.now() };
  r.match.timer = setTimeout(() => forceGo(r), LOAD_TIMEOUT_MS);
  const msg = { t: 'start', seed, low, team: r.team, hostId: r.hostId, botN: TOTAL_SLOTS - players.length, players };
  for (const id of r.members) send(clients.get(id), msg);
  broadcastRoom(r);
}

function maybeGo(r) {
  const m = r.match;
  if (!m || r.state !== 'loading') return;
  if (m.inGame.size === 0) { endMatch(r); broadcastRoom(r); return; }
  for (const id of m.inGame) if (!m.loaded.has(id)) return;
  go(r);
}
function forceGo(r) {
  const m = r.match;
  if (!m || r.state !== 'loading') return;
  // 시간 안에 로딩을 못 끝낸 사람은 이번 판에서 제외
  for (const id of [...m.inGame]) {
    if (!m.loaded.has(id)) {
      m.inGame.delete(id);
      send(clients.get(id), { t: 'kicked', msg: '월드 생성이 너무 오래 걸려 이번 판에서 제외되었습니다.' });
    }
  }
  if (!m.inGame.has(r.hostId) && m.inGame.size) r.hostId = [...m.inGame][0];
  maybeGo(r);
  broadcastRoom(r);
}
function go(r) {
  const m = r.match;
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  r.state = 'playing';
  if (!m.inGame.has(r.hostId)) r.hostId = [...m.inGame][0];
  const players = m.players.filter(p => m.inGame.has(p.id));
  const msg = { t: 'go', hostId: r.hostId, players, hashes: m.hashes };
  for (const id of m.inGame) send(clients.get(id), msg);
  broadcastRoom(r);
}

/* ---------------- 메시지 처리 ---------------- */
function onMessage(c, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || typeof msg.t !== 'string') return;
  const r = c.room ? rooms.get(c.room) : null;

  switch (msg.t) {
    case 'r': { // 게임 메시지 중계
      if (!r || !r.match || r.state !== 'playing' || !r.match.inGame.has(c.id)) return;
      const out = JSON.stringify({ t: 'r', f: c.id, d: msg.d });
      if (msg.to !== undefined && msg.to !== null) {
        if (r.match.inGame.has(msg.to)) send(clients.get(msg.to), out);
      } else {
        for (const id of r.match.inGame) if (id !== c.id) send(clients.get(id), out);
      }
      return;
    }
    case 'hello':
      c.name = cleanName(msg.name);
      c.touch = !!msg.touch;
      send(c, { t: 'welcome', id: c.id, name: c.name });
      sendList(c);
      return;
    case 'name':
      c.name = cleanName(msg.name);
      if (r) broadcastRoom(r);
      return;
    case 'list':
      sendList(c);
      return;
    case 'create': {
      if (r) leaveRoom(c);
      const code = newCode();
      const room = { code, hostId: c.id, state: 'lobby', members: [c.id], team: !!msg.team, match: null, created: Date.now() };
      rooms.set(code, room);
      c.room = code;
      broadcastRoom(room);
      return;
    }
    case 'join': {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(c, { t: 'err', msg: '방을 찾을 수 없습니다. 코드를 확인하세요.' });
      if (room.members.includes(c.id)) return broadcastRoom(room);
      if (room.members.length >= MAX_PLAYERS) return send(c, { t: 'err', msg: '방이 가득 찼습니다 (최대 4명).' });
      if (room.state === 'loading') return send(c, { t: 'err', msg: '게임을 준비하는 중입니다. 잠시 후 다시 시도하세요.' });
      if (r) leaveRoom(c);
      if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }
      room.members.push(c.id);
      if (!room.hostId || !room.members.includes(room.hostId)) room.hostId = c.id;
      c.room = code;
      broadcastRoom(room);
      return;
    }
    case 'leave':
      if (r) leaveRoom(c, 'leave');
      sendList(c);
      return;
    case 'team':
      if (r && r.hostId === c.id && r.state === 'lobby') { r.team = !!msg.team; broadcastRoom(r); }
      return;
    case 'start':
      if (!r) return;
      if (r.hostId !== c.id) return send(c, { t: 'err', msg: '방장만 게임을 시작할 수 있습니다.' });
      if (r.state !== 'lobby') return send(c, { t: 'err', msg: '이미 게임이 진행 중입니다.' });
      startMatch(r);
      return;
    case 'loaded':
      if (!r || !r.match || r.state !== 'loading' || !r.match.inGame.has(c.id)) return;
      r.match.loaded.add(c.id);
      r.match.hashes[c.id] = String(msg.hash || '').slice(0, 64);
      maybeGo(r);
      return;
    case 'ping':
      send(c, { t: 'pong', ts: msg.ts });
      return;
  }
}

wss.on('connection', (ws) => {
  const c = { id: 'p' + (nextId++), ws, name: '생존자', touch: false, room: null, alive: true };
  clients.set(c.id, c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try { onMessage(c, data.toString()); } catch (e) { console.error('메시지 처리 오류', e); }
  });
  ws.on('close', () => {
    try { leaveRoom(c, 'disconnect'); } catch (e) { console.error(e); }
    clients.delete(c.id);
  });
  ws.on('error', () => { /* close 이벤트에서 정리 */ });
});

// 끊긴 연결 정리 (Render 같은 프록시 환경에서 유휴 연결 유지에도 도움)
const hb = setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { try { c.ws.terminate(); } catch (e) { } continue; }
    c.alive = false;
    try { c.ws.ping(); } catch (e) { }
  }
}, 20000);
wss.on('close', () => clearInterval(hb));

server.listen(PORT, () => {
  console.log(`최후의 섬 서버 실행 중: http://localhost:${PORT}`);
});
