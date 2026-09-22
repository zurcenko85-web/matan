/* ═══ ТЕОРЕМА — Cloudflare Pages Functions + D1 ═══ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' && request.method === 'POST') {
      let d = {};
      try { d = await request.json(); } catch (e) {}
      let out;
      try { out = await handle(d, env); }
      catch (e) { out = { error: 'ошибка сервера: ' + (e.message || e) }; }
      return json(out);
    }
    return env.ASSETS.fetch(request);
  }
};
function json(o) {
  return new Response(JSON.stringify(o), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];
const tok = (n = 12) => crypto.randomUUID().replace(/-/g, '').slice(0, n * 2);
const now = () => Date.now();
const cleanName = s => {
  s = String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || pick(['Пифагор', 'Эйлер', 'Ковалевская', 'Гаусс', 'Гипатия', 'Коши']);
};
async function hashPw(pw, salt) {
  const data = new TextEncoder().encode(salt + ':' + pw);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── БД: аккуратно с двумя Write-операциями на соединение ── */
async function dbInit(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users(
      login TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY, login TEXT NOT NULL, ts INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS rooms(
      code TEXT PRIMARY KEY, state TEXT NOT NULL, ts INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS roomsV(
      code TEXT PRIMARY KEY, ver INTEGER DEFAULT 0)`)
  ]);
}
/* Сериализация мутаций комнаты: короткий блокировочный ключ */
async function mutate(env, code, fn) {
  for (let i = 0; i < 6; i++) {
    const t = tok(6);
    const nx = await env.DB.prepare(
      `INSERT INTO roomsV(code,ver) VALUES(?,0) ON CONFLICT(code) DO NOTHING`
    ).bind('L:' + code, 0).run();
    if (nx.meta.changes) {
      try { return await fn(); }
      finally { await env.DB.prepare(`DELETE FROM roomsV WHERE code=?`).bind('L:' + code).run(); }
    }
    await new Promise(r => setTimeout(r, 50 + Math.random() * 80));
  }
  return { error: 'сервер занят, повторите' };
}
const getRoom = async (env, code) => {
  const r = await env.DB.prepare(`SELECT state FROM rooms WHERE code=?`).bind(code).first();
  return r ? JSON.parse(r.state) : null;
};
const saveRoom = (env, code, room) =>
  env.DB.prepare(`INSERT INTO rooms(code,state,ts) VALUES(?,?,?)
    ON CONFLICT(code) DO UPDATE SET state=excluded.state, ts=excluded.ts`)
    .bind(code, JSON.stringify(room), now()).run();

/* ── аккаунты ── */
const LOGIN_RE = /^[A-Za-z0-9_\-]{3,20}$/;
async function register(env, login, pw) {
  login = String(login || '').trim();
  if (!LOGIN_RE.test(login)) return { error: 'Логин: 3–20 символов — латиница, цифры, «_» или «-».' };
  if (String(pw || '').length < 6) return { error: 'Пароль — минимум 6 символов.' };
  const key = login.toLowerCase();
  const ex = await env.DB.prepare(`SELECT login FROM users WHERE login=?`).bind(key).first();
  if (ex) return { error: 'Такой логин уже занят.' };
  const salt = tok(8);
  const hash = await hashPw(pw, salt);
  await env.DB.prepare(`INSERT INTO users(login,salt,hash) VALUES(?,?,?)`).bind(key, salt, hash).run();
  const token = tok(16);
  await env.DB.prepare(`INSERT INTO sessions(token,login,ts) VALUES(?,?,?)`).bind(token, key, now()).run();
  return { token, login };
}
async function login(env, login, pw) {
  const key = String(login || '').trim().toLowerCase();
  const u = await env.DB.prepare(`SELECT * FROM users WHERE login=?`).bind(key).first();
  if (!u) return { error: 'Нет такого логина. Зарегистрируйтесь.' };
  if ((await hashPw(String(pw || ''), u.salt)) !== u.hash) return { error: 'Неверный пароль.' };
  const token = tok(16);
  await env.DB.prepare(`INSERT INTO sessions(token,login,ts) VALUES(?,?,?)`).bind(token, key, now()).run();
  return { token, login: u.login };
}
async function who(env, token) {
  const s = await env.DB.prepare(`SELECT login FROM sessions WHERE token=?`).bind(token || '').first();
  return s ? { login: s.login } : { error: 'сессия истекла' };
}

/* ── генераторы задач (как раньше, без парсера) ── */
const MINUS = '−';
const SUP = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','-':'⁻','−':'⁻','x':'ˣ' };
const SUB = { '0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉' };
const sup = s => String(s).split('').map(c => SUP[c] || '').join('');
const sub = s => String(s).split('').map(c => SUB[c] || '').join('');
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100;
  return (a === 1 && b !== 11) ? one : (a >= 2 && a <= 4 && (b < 10 || b >= 20)) ? few : many };
function lin(a, b) { let s = (a === 1 ? '' : a) + 'x';
  if (b) s += b < 0 ? ` − ${Math.abs(b)}` : ` + ${b}`; return s }
function poly3(A, B) { let s = 'x³';
  if (A) s += A < 0 ? ` − ${Math.abs(A)}x²` : ` + ${A}x²`;
  if (B) s += B < 0 ? ` − ${Math.abs(B)}x` : ` + ${B}x`;
  return s + ' + 7' }
function fmtAnswer(v, p) { let s = p > 0 ? (+v).toFixed(p).replace(/0+$/, '').replace(/[.,]$/, '') : String(Math.round(v));
  return s.replace('-', '−').replace('.', ',') }
function parseAnswer(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(',', '.').replace(/[−–—]/g, '-').replace(/\s+/g, '');
  const f = /^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(s);
  if (f) { const d = parseFloat(f[2]); return d ? parseFloat(f[1]) / d : null }
  return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
}
const TOPICS = [['eq','Уравнения'],['pow','Преобразования'],['der','Производная'],['pro','Вероятность'],
  ['pla','Планиметрия'],['ste','Стереометрия'],['txt','Текстовые']];
const TLBL = Object.fromEntries(TOPICS);
const g_linear = () => { const x = rnd(-9,9), a = rnd(2,9), b = rnd(-20,20), c = a*x+b;
  return { text: `Найдите корень уравнения ${lin(a,b)} = ${c<0?MINUS+Math.abs(c):c}.`, ans: x, prec: 0 } };
const g_quadratic = () => { let p = rnd(-9,9), q = rnd(-9,9); while (q === p) q = rnd(-9,9);
  const B = -(p+q), C = p*q; let s = 'x²';
  if (B) s += B < 0 ? ` − ${Math.abs(B)}x` : ` + ${B}x`;
  if (C) s += C < 0 ? ` − ${Math.abs(C)}` : ` + ${C}`;
  return { text: `Решите уравнение ${s} = 0. Если корней несколько, в ответе укажите больший.`, ans: Math.max(p,q), prec: 0 } };
const g_exponential = () => { const a = pick([2,3,4,5]);
  if (Math.random() < .6) { const k = rnd(2,5), n = rnd(1,9);
    return { text: `Найдите корень уравнения ${a}${sup('x-'+n)} = ${a**k}.`, ans: k+n, prec: 0 } }
  const k = rnd(2,5), n = rnd(k+1,k+9);
  return { text: `Найдите корень уравнения (1/${a})${sup('x-'+n)} = ${a**k}.`, ans: n-k, prec: 0 } };
const g_logarithm = () => { const a = pick([2,3,5]), k = rnd(2,4);
  if (Math.random() < .5) { const n = rnd(1, Math.min(30, a**k - 1));
    return { text: `Найдите корень уравнения log${sub(a)}(x + ${n}) = ${k}.`, ans: a**k - n, prec: 0 } }
  const n = rnd(1, 20);
  return { text: `Найдите корень уравнения log${sub(a)}(x − ${n}) = ${k}.`, ans: a**k + n, prec: 0 } };
function g_trig() {
  for (let t = 0; t < 200; t++) {
    const f = Math.random() < .5 ? 'sin' : 'cos', k = pick([2,3,4,6]);
    const bank = f === 'sin'
      ? [['1/2',[30,150]],['√2/2',[45,135]],['√3/2',[60,120]],[MINUS+'1/2',[210,330]],['1',[90]],[MINUS+'1',[270]]]
      : [['1/2',[60,300]],['√2/2',[45,315]],['√3/2',[30,330]],[MINUS+'1/2',[120,240]],['1',[0]],[MINUS+'1',[180]]];
    const [sv, ts] = pick(bank);
    if ((k*ts[0]) % 180 !== 0) continue;
    const cands = []; for (let n = -6; n <= 6; n++) for (const tt of ts) cands.push(k*tt/180 + 2*k*n);
    const pos = cands.filter(x => x > 0), neg = cands.filter(x => x < 0);
    if (!pos.length || !neg.length) continue;
    const mp = Math.random() < .5;
    return { text: `Решите уравнение ${f}(πx/${k}) = ${sv}. В ответе укажите ${mp?'наименьший положительный':'наибольший отрицательный'} корень.`,
      ans: mp ? Math.min(...pos) : Math.max(...neg), prec: 0 };
  }
  return { text: 'Решите уравнение sin(πx/3) = √3/2. В ответе укажите наименьший положительный корень.', ans: 1, prec: 0 } }
const g_powers = () => { const A = pick([2,3,5,10]), m = rnd(2,7), n = rnd(1,6), k = rnd(1,6), e = m+n-k;
  if (e >= 1 && e <= 5) return { text: `Найдите значение выражения a${sup(m)} · a${sup(n)} / a${sup(k)}, если a = ${A}.`, ans: A**e, prec: 0 };
  const m2 = rnd(2,3), n2 = rnd(2,3), k2 = rnd(1, m2*n2 - 1);
  return { text: `Найдите значение выражения (a${sup(m2)})${sup(n2)} / a${sup(k2)}, если a = ${A}.`, ans: A**(m2*n2-k2), prec: 0 } };
const g_quadmin = () => { const a = rnd(-9,9) || 5, c = rnd(-15,15), b = -2*a; let s = 'x²';
  if (b) s += b < 0 ? ` − ${Math.abs(b)}x` : ` + ${b}x`;
  if (c) s += c < 0 ? ` − ${Math.abs(c)}` : ` + ${c}`;
  return { text: `Найдите точку минимума функции y = ${s}.`, ans: a, prec: 0 } };
const g_cubicmin = () => { const u = rnd(-5,2), v = u + rnd(1,4), A = -(v+2*u), B = u*u + 2*u*v;
  return { text: `Найдите точку минимума функции y = ${poly3(A,B)}.`, ans: v, prec: 0 } };
function g_derivgraph() {
  const ys = []; let y = rnd(-3,3);
  for (let i = 0; i < 13; i++) { if (y === 0) y = Math.random() < .5 ? 1 : -1; ys.push(y); y = Math.max(-4, Math.min(4, y + rnd(-2,2))) }
  const pos = ys.filter(v => v > 0).length, neg = ys.filter(v => v < 0).length;
  let zeros = 0; for (let i = 0; i < 12; i++) if (ys[i]*ys[i+1] < 0) zeros++;
  const opts = [
    [`укажите количество целых точек отрезка [−6; 6], в которых производная функции f(x) положительна.`, pos],
    [`укажите количество целых точек отрезка [−6; 6], в которых производная функции f(x) отрицательна.`, neg]];
  if (zeros) opts.push(['укажите количество точек, в которых производная функции f(x) равна нулю.', zeros]);
  const [q, answ] = pick(opts);
  const X = x => 40 + (x+6)*40, Y = v => 160 - 28*v; let g = '';
  for (let x = -6; x <= 6; x++) g += `<line x1="${X(x)}" y1="26" x2="${X(x)}" y2="294" stroke="rgba(33,29,23,.09)"/>`;
  for (let v = -4; v <= 4; v++) g += `<line x1="40" y1="${Y(v)}" x2="520" y2="${Y(v)}" stroke="rgba(33,29,23,.09)"/>`;
  g += '<line x1="34" y1="160" x2="528" y2="160" stroke="#211D17" stroke-width="1.6"/>';
  g += `<line x1="${X(0)}" y1="26" x2="${X(0)}" y2="294" stroke="#211D17" stroke-width="1.6"/>`;
  for (let x = -6; x <= 6; x++) {
    g += `<line x1="${X(x)}" y1="156" x2="${X(x)}" y2="164" stroke="#211D17" stroke-width="1.4"/>`;
    g += `<text x="${X(x)}" y="182" font-size="10.5" text-anchor="middle" fill="rgba(33,29,23,.5)">${x===0?'':x}</text>`;
  }
  const pts = ys.map((v,i) => `${X(i-6)},${Y(v)}`).join(' ');
  const svg = `<svg viewBox="0 0 560 320" xmlns="http://www.w3.org/2000/svg">${g}<polyline points="${pts}" fill="none" stroke="#211D17" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  return { text: `На рисунке изображён график y = f′(x) — производной функции f(x), определённой на интервале (−7; 7). ${q[0].toUpperCase()+q.slice(1)}`,
    ans: answ, prec: 0, img: svg } }
const g_pies = () => { const N = pick([4,5,8,10,16,20,25]), M = rnd(1, N-1);
  return { text: `На тарелке лежат ${N} ${plural(N,'пирожок','пирожка','пирожков')}: ${M} ${plural(M,'пирожок','пирожка','пирожков')} с капустой, остальные — с яблоками. Найдите вероятность того, что случайно выбранный пирожок окажется с яблоками. Ответ округлите до сотых.`, ans: (N-M)/N, prec: 2 } };
const g_dice = () => { const s = rnd(2,12), c = [0,0,1,2,3,4,5,6,5,4,3,2,1][s];
  return { text: `Игральный кубик бросают дважды. Найдите вероятность того, что сумма выпавших очков равна ${s}. Ответ округлите до сотых.`, ans: c/36, prec: 2 } };
const g_tickets = () => { const N = pick([10,20,25,40,50]), M = rnd(1, N-1);
  return { text: `На экзамене по механике ${N} ${plural(N,'билет','билета','билетов')}, из которых ${M} студент не выучил. Найдите вероятность того, что ему попадётся выученный билет. Ответ округлите до сотых.`, ans: (N-M)/N, prec: 2 } };
const g_trisides = () => { const a = rnd(6,20), b = rnd(6,20), s = pick([0.4,0.5,0.6]);
  return { text: `Две стороны треугольника равны ${a} и ${b}, а синус угла между ними равен ${String(s).replace('.',',')}. Найдите площадь этого треугольника.`, ans: a*b*s/2, prec: 2 } };
const g_righttri = () => { const a = rnd(3,16), b = rnd(3,16);
  return { text: `В прямоугольном треугольнике катеты равны ${a} и ${b}. Найдите площадь этого треугольника.`, ans: a*b/2, prec: 1 } };
const g_rhombus = () => { const m = rnd(2,7);
  return { text: `Сторона ромба равна ${2*m}, а один из углов этого ромба равен 30°. Найдите площадь ромба.`, ans: 2*m*m, prec: 0 } };
const g_box = () => { const a = rnd(2,9), b = rnd(2,9), c = rnd(2,9);
  return { text: `Два ребра прямоугольного параллелепипеда, выходящие из одной вершины, равны ${a} и ${b}. Объём параллелепипеда равен ${a*b*c}. Найдите третье ребро, выходящее из той же вершины.`, ans: c, prec: 0 } };
const g_pyramid = () => { const h = rnd(2,12), S = 3*rnd(2,15);
  return { text: `Площадь основания пирамиды равна ${S}, а высота пирамиды равна ${h}. Найдите её объём.`, ans: S*h/3, prec: 0 } };
function g_percent() {
  for (let t = 0; t < 300; t++) { const base = pick([800,1000,1200,1600,2000,2400,3000,4000]), p = rnd(5,50), q = rnd(5,50);
    const f = base*(1+p/100)*(1-q/100);
    if (Math.abs(f - Math.round(f)) < 1e-9)
      return { text: `Куртка стоила ${base} рублей. На распродаже её цену сначала повысили на ${p}%, а затем снизили на ${q}%. Сколько рублей стала стоить куртка после снижения цены?`, ans: Math.round(f), prec: 0 } }
  return { text: 'Куртка стоила 1000 рублей. На распродаже её цену сначала повысили на 10%, а затем снизили на 10%. Сколько рублей стала стоить куртка после снижения цены?', ans: 990, prec: 0 } }
function g_speed() {
  for (let t = 0; t < 300; t++) { const t1 = rnd(1,4), t2 = rnd(1,4), v1 = rnd(3,12)*10, v2 = rnd(3,12)*10;
    const s = (t1*v1 + t2*v2) / (t1+t2);
    if (Math.abs(s - Math.round(s)) < 1e-9) {
      const w1 = t1 === 1 ? 'Первый час' : `Первые ${t1} ${plural(t1,'час','часа','часов')}`;
      const w2 = t2 === 1 ? 'следующий час' : `следующие ${t2} ${plural(t2,'час','часа','часов')}`;
      return { text: `${w1} велосипедист ехал со скоростью ${v1} км/ч, ${w2} — со скоростью ${v2} км/ч. Найдите среднюю скорость велосипедиста на всём пути. Ответ дайте в км/ч.`, ans: Math.round(s), prec: 0 }
    } }
  return { text: 'Первый час велосипедист ехал со скоростью 50 км/ч, следующий час — со скоростью 70 км/ч. Найдите его среднюю скорость. Ответ дайте в км/ч.', ans: 60, prec: 0 } }
const GENS = [['eq',g_linear],['eq',g_quadratic],['eq',g_exponential],['eq',g_logarithm],['eq',g_trig],
  ['pow',g_powers],['der',g_quadmin],['der',g_cubicmin],['der',g_derivgraph],
  ['pro',g_pies],['pro',g_dice],['pro',g_tickets],
  ['pla',g_trisides],['pla',g_righttri],['pla',g_rhombus],
  ['ste',g_box],['ste',g_pyramid],['txt',g_percent],['txt',g_speed]];

/* ── комнаты ── */
const CODE_AB = 'abcdefghjkmnpqrstuvwxyz23456789';
const genCode = () => Array.from({ length: 6 }, () => pick(CODE_AB.split(''))).join('');
const HOLD_MS = 150000, IDLE_LIMIT = 3;
function newRoom(login, name) {
  return { names: [name, null], rtok: [tok(12), null], seen: [now(), 0],
    settings: { target: 5, time: 120, topics: Object.fromEntries(TOPICS.map(([k]) => [k, true])) },
    phase: 'lobby', scores: [0,0], hist: [], tries: [0,0], n: 0, idleRounds: 0,
    round: null, between: null, pendingSkip: null, skipEv: null, winner: null, note: null,
    deck: [], used: {}, v: 1,
    stats: [{solved:0,sum:0,best:null,wrong:0},{solved:0,sum:0,best:null,wrong:0}] };
}
function view(r, seat) {
  const t = now();
  const onHold = r.phase === 'between' && r.between && r.between.holdNoted && !r.between.finalAfter;
  return { seat, v: r.v, names: r.names,
    online: [t-(r.seen[0]||0) < 8000, t-(r.seen[1]||0) < 8000],
    phase: r.phase, scores: r.scores, hist: r.hist, tries: r.tries,
    target: r.settings.target, time: r.settings.time, topics: r.settings.topics,
    note: r.note || null, hold: onHold,
    round: r.round ? { n: r.round.n, text: r.round.text, topic: r.round.topic, img: r.round.img, deadline: r.round.deadline } : null,
    between: r.between ? { until: r.between.until, last: r.between.last, finalAfter: r.between.finalAfter } : null,
    pendingSkip: r.pendingSkip ? { by: r.pendingSkip.by, n: r.pendingSkip.n, until: r.pendingSkip.until } : null,
    skipEv: r.skipEv, myStats: r.stats[seat], winner: r.winner, servertime: t };
}
function finishRound(r, kind, ms) {
  const round = r.round, answer = round.answer;
  if (kind === 0 || kind === 1) { r.scores[kind]++; r.idleRounds = 0; }
  else r.idleRounds++;
  r.hist.push(kind);
  const done = r.scores[0] >= r.settings.target || r.scores[1] >= r.settings.target;
  r.between = { until: now()+5200, last: { n: round.n, kind, answer, ms }, finalAfter: done };
  r.round = null; r.pendingSkip = null; r.v++;
}
function resetMatch(r) {
  Object.assign(r, { scores:[0,0], hist:[], tries:[0,0], n:0, idleRounds:0, round:null, deck:[],
    used:{}, winner:null, pendingSkip:null, skipEv:null, note:null,
    stats:[{solved:0,sum:0,best:null,wrong:0},{solved:0,sum:0,best:null,wrong:0}] });
  r.phase = 'between'; r.between = { until: now()+1500, last: null, finalAfter: false }; r.v++;
}
function pickTask(r) {
  const pool = GENS.filter(([c]) => r.settings.topics[c]);
  if (!pool.length) return null;
  if (!r.deck.length) { r.deck = pool.slice();
    for (let i = r.deck.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1));
      [r.deck[i], r.deck[j]] = [r.deck[j], r.deck[i]] } }
  const [cat, fn] = r.deck.pop();
  let t = fn(), sig = t.text+'|'+t.ans, guard = 0;
  while (r.used[sig] && guard < 60) { t = fn(); sig = t.text+'|'+t.ans; guard++ }
  r.used[sig] = 1;
  return { text: t.text, ans: t.ans, prec: t.prec, topic: (TLBL[cat]||'')+' · прототип банка', img: t.img || '' };
}
function newRound(r) {
  const task = pickTask(r);
  if (!task) { r.phase='lobby'; r.between=null; r.note='Нет задач: включите темы генераторов.'; r.v++; return }
  r.n++;
  r.round = { n: r.n, text: task.text, topic: task.topic, img: task.img, prec: task.prec,
    ans: task.ans, answer: fmtAnswer(task.ans, task.prec), started: now(), deadline: now()+r.settings.time*1000 };
  r.tries = [0,0]; r.pendingSkip = null; r.skipEv = null; r.note = null; r.v++;
}
function advanceRoom(r) {
  const t = now();
  if (r.phase === 'round' && r.round && t >= r.round.deadline) { finishRound(r, 'draw', null); return }
  if (r.phase === 'between' && r.between && t >= r.between.until) {
    if (r.between.finalAfter) {
      r.phase = 'final'; r.winner = r.scores[0] >= r.settings.target ? 0 : 1;
      r.between = null; r.v++; return;
    }
    const gone = (t-(r.seen[0]||0) > HOLD_MS) || (t-(r.seen[1]||0) > HOLD_MS);
    if (gone) { r.between.until = t+8000;
      if (!r.between.holdNoted) { r.between.holdNoted = true;
        r.note = 'Пауза: один из игроков недоступен. Матч продолжится, когда оба вернутся.'; r.v++; }
      return; }
    if (r.idleRounds >= IDLE_LIMIT) {
      r.phase = 'lobby'; r.round = null; r.between = null; r.pendingSkip = null; r.idleRounds = 0;
      r.note = 'Матч остановлен: 3 раунда подряд без верных ответов. Создатель может начать дуэль заново.'; r.v++; return;
    }
    newRound(r); return;
  }
  if (r.pendingSkip && t >= r.pendingSkip.until) {
    r.skipEv = { res:'timeout', to: r.pendingSkip.by, n: r.pendingSkip.n };
    r.pendingSkip = null; r.v++;
  }
}
function seatOf(r, rtok) { const i = r.rtok.indexOf(rtok || ''); return i >= 0 ? i : -1 }
function actOn(r, seat, d) {
  const a = d.action;
  switch (a) {
    case 'settings':
      if (seat !== 0 || r.phase !== 'lobby') return { error: 'настройки меняет создатель до старта' };
      { const s = d.settings || {};
        if ([3,5,7].includes(+s.target)) r.settings.target = +s.target;
        if ([60,90,120,180,240].includes(+s.time)) r.settings.time = +s.time;
        if (s.topics) for (const [k] of TOPICS) if (k in s.topics) r.settings.topics[k] = !!s.topics[k];
        r.v++; return { ok: true }; }
    case 'start':
      if (seat !== 0) return { error: 'стартует создатель комнаты' };
      if (!r.rtok[1]) return { error: 'ждём второго игрока' };
      if (!Object.values(r.settings.topics).some(Boolean)) return { error: 'выберите хотя бы одну тему' };
      resetMatch(r); return { ok: true };
    case 'answer': {
      const rd = r.round;
      if (r.phase !== 'round' || !rd || +d.n !== rd.n) return { ok: false, msg: 'раунд уже завершён' };
      const val = parseAnswer(d.value);
      if (val === null) return { ok: false, msg: 'Введите число или дробь вида 7/3.' };
      const tol = Math.pow(10, -(rd.prec||0))/2 + 1e-9;
      r.tries[seat]++;
      if (Math.abs(val - rd.ans) > tol) {
        r.stats[seat].wrong++; r.v++; return { ok: false, msg: 'неверно' };
      }
      const ms = Math.max(1, now()-rd.started), st = r.stats[seat];
      st.solved++; st.sum += ms; st.best = st.best == null ? ms : Math.min(st.best, ms);
      finishRound(r, seat, ms); return { ok: true }; }
    case 'skip': {
      const rd = r.round;
      if (r.phase !== 'round' || !rd || +d.n !== rd.n) return { error: 'раунд не активен' };
      if (r.pendingSkip) return { error: 'запрос уже отправлен' };
      r.pendingSkip = { by: seat, n: rd.n, until: now()+15000 }; r.v++; return { ok: true }; }
    case 'skipReply': {
      const p = r.pendingSkip;
      if (!p || p.by === seat) return { error: 'нет запроса к вам' };
      if (d.ok) { r.skipEv = { res:'ok', to: p.by, n: p.n }; finishRound(r, 'skip', null); }
      else { r.skipEv = { res:'no', to: p.by, n: p.n }; r.pendingSkip = null; r.v++; }
      return { ok: true }; }
    case 'rematch':
      if (seat !== 0 || r.phase !== 'final') return { error: 'реванш недоступен' };
      resetMatch(r); return { ok: true };
  }
  return { error: 'неизвестное действие' };
}

/* ── диспетчер ── */
async function handle(d, env) {
  await dbInit(env);
  switch (d.action) {
    case 'register': return register(env, d.login, d.password);
    case 'login':    return login(env, d.login, d.password);
    case 'me':       return who(env, d.token);
    case 'create': {
      const u = await who(env, d.token); if (u.error) return { error: 'войдите в аккаунт' };
      for (let i = 0; i < 10; i++) {
        const code = genCode();
        const free = await mutate(env, code, async () => {
          if (await getRoom(env, code)) return null;
          const room = newRoom(u.login, cleanName(d.name));
          await saveRoom(env, code, room);
          return room;
        });
        if (free && !free.error) return { code, rtok: free.rtok[0], seat: 0 };
      }
      return { error: 'не удалось выделить код, попробуйте ещё' };
    }
    case 'join': {
      const u = await who(env, d.token); if (u.error) return { error: 'войдите в аккаунт' };
      const code = String(d.code||'').toLowerCase().trim();
      const out = await mutate(env, code, async () => {
        const room = await getRoom(env, code);
        if (!room) return { error: 'Комната не найдена. Проверьте код.' };
        if (room.rtok[1]) return { error: 'В этой комнате уже играют вдвоём.' };
        room.rtok[1] = tok(12); room.names[1] = cleanName(d.name);
        room.seen[1] = now(); room.v++;
        await saveRoom(env, code, room);
        return { rtok: room.rtok[1], seat: 1 };
      });
      if (out.error) return out;
      return { code, rtok: out.rtok, seat: out.seat };
    }
    case 'state': {
      const code = String(d.code||'').toLowerCase();
      const room = await getRoom(env, code);
      if (!room) return { die: 'Комната удалена (2 недели бездействия). Создайте новую.' };
      const seat = seatOf(room, d.rtok);
      if (seat < 0) return { die: 'Сессия комнаты устарела — войдите заново.' };
      room.seen[seat] = now();
      advanceRoom(room);
      const same = (+d.v || 0) === room.v;
      if (same) return { same: true };
      await saveRoom(env, code, room);
      return { room: view(room, seat) };
    }
    case 'act': {
      const code = String(d.code||'').toLowerCase();
      const out = await mutate(env, code, async () => {
        const room = await getRoom(env, code);
        if (!room) return { die: 'Комната не найдена.' };
        const seat = seatOf(room, d.rtok);
        if (seat < 0) return { die: 'Сессия комнаты устарела.' };
        room.seen[seat] = now();
        const resp = actOn(room, seat, d);
        advanceRoom(room);
        await saveRoom(env, code, room);
        return { resp, seat };
      });
      if (out.die) return out;
      return out.resp || out;
    }
  }
  return { error: 'неизвестное действие' };
}
let VIEWVER = -1;
