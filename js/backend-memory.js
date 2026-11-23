/* 示範／測試用後端：資料只存在瀏覽器記憶體，重新整理就回到範例資料 */
export const DEL = Symbol('DEL');

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function mergeInto(dst, src) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v === DEL) { delete dst[k]; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!dst[k] || typeof dst[k] !== 'object' || Array.isArray(dst[k])) dst[k] = {};
      mergeInto(dst[k], v);
    } else dst[k] = clone(v);
  }
  return dst;
}
function stripDel(v) {
  if (v === DEL) return undefined;
  if (Array.isArray(v)) return v.map(stripDel);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) { const x = stripDel(v[k]); if (x !== undefined) o[k] = x; } return o; }
  return v;
}

export function createMemoryBackend(seed) {
  const cols = {};          // col -> Map(id -> data)
  const listeners = [];     // {col, filters, cb, id?}
  const users = [];         // {uid, email, pw}
  let current = null, authCbs = [], seq = 0;
  const C = name => (cols[name] = cols[name] || new Map());
  const match = (d, filters) => (filters || []).every(f => f[1] === '==' ? d[f[0]] === f[2] : f[1] === '>=' ? d[f[0]] >= f[2] : f[1] === '<=' ? d[f[0]] <= f[2] : true);
  const fire = col => listeners.filter(l => l.col === col).forEach(l => {
    if (l.id !== undefined) l.cb(C(col).has(l.id) ? clone(C(col).get(l.id)) : null);
    else l.cb([...C(col)].filter(([, d]) => match(d, l.filters)).map(([id, d]) => ({ id, data: clone(d) })));
  });
  const write = (o) => {
    const m = C(o.col);
    if (o.op === 'del') m.delete(o.id);
    else if (o.merge) m.set(o.id, mergeInto(clone(m.get(o.id)) || {}, o.data));
    else m.set(o.id, stripDel(clone2(o.data)));
  };
  const clone2 = v => (v && typeof v === 'object') ? (Array.isArray(v) ? v.map(clone2) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === DEL ? DEL : clone2(x)]))) : v;

  if (seed) {
    (seed.users || []).forEach(u => users.push(u));
    Object.entries(seed.data || {}).forEach(([col, docs]) => Object.entries(docs).forEach(([id, d]) => C(col).set(id, clone(d))));
  }

  const api = {
    DEL,
    kind: 'memory',
    auth: {
      onChange(cb) { authCbs.push(cb); setTimeout(() => cb(current), 0); return () => {}; },
      async signIn(email, pw) {
        const u = users.find(x => x.email === String(email).trim().toLowerCase() && x.pw === pw);
        if (!u) throw new Error('Email 或密碼錯誤');
        current = { uid: u.uid, email: u.email }; authCbs.forEach(cb => cb(current));
      },
      async signOut() { current = null; authCbs.forEach(cb => cb(null)); },
      async reset(email) { if (!users.some(u => u.email === email)) throw new Error('找不到這個 Email'); },
      async createUser(email, pw) {
        email = String(email).trim().toLowerCase();
        if (users.some(u => u.email === email)) throw new Error('這個 Email 已經有帳號了');
        if (String(pw).length < 6) throw new Error('密碼至少要 8 個字元');
        const uid = 'u' + (++seq) + Date.now().toString(36);
        users.push({ uid, email, pw }); return uid;
      },
      async changePassword(oldPw, newPw) {
        const u = users.find(x => current && x.uid === current.uid);
        if (!u || u.pw !== oldPw) throw new Error('Email 或密碼錯誤');
        u.pw = newPw;
      },
      _users: users
    },
    db: {
      listen(col, filters, cb) { const l = { col, filters, cb }; listeners.push(l); setTimeout(() => fire(col), 0); return () => listeners.splice(listeners.indexOf(l), 1); },
      listenDoc(col, id, cb) { const l = { col, id, cb }; listeners.push(l); setTimeout(() => fire(col), 0); return () => listeners.splice(listeners.indexOf(l), 1); },
      async query(col, filters, order, max) {
        let rows = [...C(col)].filter(([, d]) => match(d, filters)).map(([id, d]) => ({ id, data: clone(d) }));
        if (order) rows.sort((a, b) => (a.data[order[0]] < b.data[order[0]] ? -1 : a.data[order[0]] > b.data[order[0]] ? 1 : 0) * (order[1] === 'desc' ? -1 : 1));
        return max ? rows.slice(0, max) : rows;
      },
      async get(col, id) { return C(col).has(id) ? clone(C(col).get(id)) : null; },
      newId() { return 'id' + (++seq) + Math.random().toString(36).slice(2, 8); },
      async set(col, id, data, merge) { write({ op: 'set', col, id, data, merge }); fire(col); },
      async del(col, id) { write({ op: 'del', col, id }); fire(col); },
      async batch(ops) { ops.forEach(write); [...new Set(ops.map(o => o.col))].forEach(fire); },
      _dump() { const o = {}; Object.keys(cols).forEach(c => { o[c] = Object.fromEntries([...cols[c]].map(([k, v]) => [k, clone(v)])); }); return o; }
    }
  };
  return api;
}
