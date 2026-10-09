/* 서버 동작 점검 스크립트: 1~4명 방에서 시작 신호와 봇 수를 확인합니다.
   사용법: 서버를 켠 상태에서  node test-server.js  (기본 ws://localhost:3000/ws) */
const WebSocket = require('ws');
const URL = process.env.WS_URL || 'ws://localhost:3000/ws';
function client(name) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL); const c = { ws, name, msgs: [], id: null };
    ws.on('message', d => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'welcome') { c.id = m.id; res(c); } });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, touch: false })));
    ws.on('error', rej);
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const last = (c, t) => [...c.msgs].reverse().find(m => m.t === t);
(async () => {
  let ok = true;
  for (let n = 1; n <= 4; n++) {
    const cs = [];
    for (let i = 0; i < n; i++) cs.push(await client('테스터' + i));
    cs[0].ws.send(JSON.stringify({ t: 'create' })); await wait(150);
    const code = last(cs[0], 'room').room.code;
    for (let i = 1; i < n; i++) cs[i].ws.send(JSON.stringify({ t: 'join', code }));
    await wait(200);
    cs[0].ws.send(JSON.stringify({ t: 'start' })); await wait(200);
    const st = last(cs[n - 1], 'start');
    for (const c of cs) c.ws.send(JSON.stringify({ t: 'loaded', hash: 'h' }));
    await wait(200);
    const go = last(cs[n - 1], 'go');
    // 중계 확인: 마지막 사람이 보낸 메시지를 방장이 받는지
    cs[n - 1].ws.send(JSON.stringify({ t: 'r', d: { t: 'ping', v: n } })); await wait(150);
    const relayed = n === 1 ? true : !!cs[0].msgs.find(m => m.t === 'r' && m.d && m.d.v === n);
    const pass = st && st.botN === 100 - n && go && go.players.length === n && relayed;
    ok = ok && pass;
    console.log(`${n}명: botN=${st && st.botN} (기대 ${100 - n}), go=${!!go}, 중계=${relayed} → ${pass ? '통과' : '실패'}`);
    for (const c of cs) c.ws.close();
    await wait(100);
  }
  // 5번째 사람은 거절되어야 함
  const cs = []; for (let i = 0; i < 5; i++) cs.push(await client('꽉참' + i));
  cs[0].ws.send(JSON.stringify({ t: 'create' })); await wait(150);
  const code = last(cs[0], 'room').room.code;
  for (let i = 1; i < 5; i++) { cs[i].ws.send(JSON.stringify({ t: 'join', code })); await wait(60); }
  await wait(200);
  const err = last(cs[4], 'err');
  console.log(`5번째 참가 거절: ${err ? err.msg : '없음'} → ${err ? '통과' : '실패'}`);
  ok = ok && !!err;
  for (const c of cs) c.ws.close();
  console.log(ok ? '\n모든 서버 점검 통과' : '\n일부 점검 실패');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('서버에 연결할 수 없습니다. 먼저 npm start 로 서버를 켜세요.', e.message); process.exit(1); });
