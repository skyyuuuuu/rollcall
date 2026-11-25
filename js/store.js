/* 資料層：把 Firestore 的資料整理成和試算表版相同的「列」格式，計算邏輯就能原封不動沿用 */
import { normDateStr } from './logic.js';

export const COL = { CLASS: 'classes', PAY_RULE: 'classPay', ROSTER: 'roster', ATT: 'attendance', PAY: 'payments', SET: 'settings', USER: 'users', LOG: 'logs' };
export const DEFAULT_SETTINGS = { '分校': ['光武', '科園'], '補課期限天數': 14, '缺課追蹤起始日': '', '續費提醒堂數': 6, '預設續費堂數': 12, '網頁標題': '團班點名', '補課統計至': {}, '已結算至': '' };

/** Firestore 文件 id 不能有「/」 */
export function idOf() { return [].slice.call(arguments).map(x => String(x).replace(/\//g, '／')).join('｜'); }

export function createStore(B, me) {
  const st = { classes: new Map(), rules: new Map(), roster: new Map(), att: new Map(), pay: new Map(), settings: Object.assign({}, DEFAULT_SETTINGS), users: new Map() };
  const unsubs = [], changeCbs = [];
  const staff = me.role === 'boss' || me.role === 'branch';
  const boss = me.role === 'boss';
  const notify = () => changeCbs.forEach(cb => { try { cb(); } catch (e) { console.error(e); } });

  function start() {
    const jobs = [];
    const sub = (key, col, filters) => jobs.push(new Promise((ok, bad) => {
      let first = true;
      unsubs.push(B.db.listen(col, filters, docs => {
        const m = new Map(); docs.forEach(d => m.set(d.id, d.data)); st[key] = m;
        if (first) { first = false; ok(); } else notify();
      }, e => { if (first) { first = false; bad(e); } else console.error(e); }));
    }));
    sub('classes', COL.CLASS);
    sub('roster', COL.ROSTER);
    sub('att', COL.ATT);
    if (staff) {
      sub('rules', COL.PAY_RULE);
      sub('pay', COL.PAY, me.role === 'branch' ? [['分校', '==', me.branch]] : null);
    }
    if (boss) sub('users', COL.USER);
    jobs.push(new Promise((ok, bad) => {
      let first = true;
      unsubs.push(B.db.listenDoc(COL.SET, 'main', d => {
        st.settings = Object.assign({}, DEFAULT_SETTINGS, d || {});
        if (first) { first = false; ok(); } else notify();
      }, e => { if (first) { first = false; bad(e); } }));
    }));
    return Promise.all(jobs);
  }
  function stop() { unsubs.splice(0).forEach(u => { try { u(); } catch (e) {} }); }

  // ─── 讀取（列格式） ───
  function classes() {
    return [...st.classes].map(([id, c]) => Object.assign({ _id: id }, c, { '薪資規則': (st.rules.get(id) || {})['薪資規則'] || (staff ? '' : '0') }));
  }
  function read(name) {
    switch (name) {
      case 'CLASS': return classes().map(c => { const o = Object.assign({}, c); delete o.sessions; return o; });
      case 'SESS': {
        const out = [];
        st.classes.forEach(c => (c.sessions || []).forEach(s => out.push({ '班級': c['班級名稱'], '堂次': s['堂次'], '日期': s['日期'], '狀態': s['狀態'], '備註': s['備註'] || '' })));
        return out;
      }
      case 'ROSTER': return [...st.roster].map(([id, r]) => Object.assign({ _id: id, '身分': '正式', '加入日': '', '正式起日': '', '退班日': '', '家長聯絡': '', '備註': '', '續費開單日': '' }, r));
      case 'ATT': {
        const out = [];
        st.att.forEach((d, id) => Object.keys(d.marks || {}).forEach(k => {
          const m = d.marks[k] || {}, i = k.indexOf('|');
          out.push({ _doc: id, _key: k, '班級': d['班級'], '日期': d['日期'], '分校': k.slice(0, i), '學生姓名': k.slice(i + 1),
                     '狀態': m['狀態'] || '', '補課日期': m['補課日期'] || '', '點名人': m['點名人'] || '', '更新時間': m['更新時間'] || '' });
        }));
        return out;
      }
      case 'PAY': return [...st.pay].map(([id, p]) => Object.assign({ _id: id }, p)).sort((a, b) => (a['登記日'] || '') < (b['登記日'] || '') ? -1 : 1);
      case 'ACC': return [...st.users].map(([uid, u]) => Object.assign({ uid }, u));
    }
    throw new Error('未知資料：' + name);
  }
  const conf = () => st.settings;
  const branches = () => (Array.isArray(st.settings['分校']) ? st.settings['分校'] : String(st.settings['分校'] || '').split(/[,，、\s]+/)).filter(String);
  const cutoffs = () => {
    const o = {}, c = st.settings['補課統計至'] || {};
    Object.keys(c).forEach(k => { if (c[k]) o[k] = normDateStr(c[k]); });
    return o;
  };
  const classByName = name => { for (const [id, c] of st.classes) if (c['班級名稱'] === name) return Object.assign({ _id: id }, c); return null; };

  // ─── 寫入 ───
  const W = {
    /** 新增或修改班級（rule = 薪資規則，只有主管會送） */
    async saveClass(id, fields, rule) {
      id = id || B.db.newId(COL.CLASS);
      const ops = [{ op: 'set', col: COL.CLASS, id, data: fields, merge: true }];
      if (rule !== undefined) ops.push({ op: 'set', col: COL.PAY_RULE, id, data: { '薪資規則': rule } });
      await B.db.batch(ops);
      return id;
    },
    async deleteClass(id) { await B.db.batch([{ op: 'del', col: COL.CLASS, id }, { op: 'del', col: COL.PAY_RULE, id }]); },
    async setSessions(clsName, list) {
      const c = classByName(clsName); if (!c) throw new Error('找不到班級：' + clsName);
      const clean = list.map(s => ({ '日期': s['日期'], '堂次': s['堂次'] === '' || s['堂次'] == null ? '' : Number(s['堂次']), '狀態': s['狀態'] || '上課', '備註': s['備註'] || '' }));
      await B.db.set(COL.CLASS, c._id, { sessions: clean }, true);
    },
    /** marks: {'分校|姓名': {...} 或 B.DEL} */
    async setMarks(cls, date, marks) {
      await B.db.set(COL.ATT, idOf(cls, date), { '班級': cls, '日期': date, marks }, true);
    },
    async moveAttendance(cls, from, to) {
      const old = st.att.get(idOf(cls, from)); if (!old) return 0;
      await B.db.batch([
        { op: 'set', col: COL.ATT, id: idOf(cls, to), data: Object.assign({}, old, { '日期': to }) },
        { op: 'del', col: COL.ATT, id: idOf(cls, from) }
      ]);
      return Object.keys(old.marks || {}).length;
    },
    async putRoster(rec) {
      const keep = ['班級', '分校', '學生姓名', '身分', '加入日', '正式起日', '退班日', '家長聯絡', '備註', '續費開單日'];
      const data = {}; keep.forEach(k => { data[k] = rec[k] == null ? '' : rec[k]; });
      await B.db.set(COL.ROSTER, idOf(rec['班級'], rec['分校'], rec['學生姓名']), data);
    },
    async putRosterMany(recs) {
      await B.db.batch(recs.map(r => ({ op: 'set', col: COL.ROSTER, id: idOf(r['班級'], r['分校'], r['學生姓名']), data: r })));
    },
    async addPayment(rec) { const id = B.db.newId(COL.PAY); await B.db.set(COL.PAY, id, rec); return id; },
    async addPayments(recs) { await B.db.batch(recs.map(r => ({ op: 'set', col: COL.PAY, id: B.db.newId(COL.PAY), data: r }))); },
    async delPayment(id) { await B.db.del(COL.PAY, id); },
    async saveSettings(patch) { await B.db.set(COL.SET, 'main', patch, true); },
    async setUser(uid, data) { await B.db.set(COL.USER, uid, data, true); },
    /** 操作紀錄：失敗不影響原本的動作 */
    async log(rec) { try { await B.db.set(COL.LOG, B.db.newId(COL.LOG), rec); } catch (e) { console.warn('操作紀錄寫入失敗', e); } }
  };

  return { st, start, stop, read, conf, branches, cutoffs, classByName, W, me, onChange: cb => changeCbs.push(cb), DEL: B.DEL };
}
