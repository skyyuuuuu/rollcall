/* 功能層：與 Apps Script 版的 api* 一一對應，權限判斷相同（Firestore 安全規則會再把關一次） */
import * as L from './logic.js';
import { idOf } from './store.js';
import { checkEmail, checkPassword } from './accounts.js';

const ROLE_LABEL = { boss: '主管', branch: '分校行政', teacher: '老師', assistant: '助教' };
export { ROLE_LABEL };

export function createApi(S) {
  const au = S.me;
  const today = () => L.todayTPE();
  const now = () => L.nowTPE();
  const isStaff = () => au.role === 'boss' || au.role === 'branch';
  const allowed = cls => au.role === 'boss' || !au.classes || !au.classes.length || au.classes.indexOf(L.norm_(cls)) >= 0;
  const brOk = br => au.role !== 'branch' || br === au.branch;
  const needStaff = () => { if (!isStaff()) throw new Error('需要行政權限'); };
  const needBoss = () => { if (au.role !== 'boss') throw new Error('需要主管權限'); };
  const notAssistant = () => { if (au.role === 'assistant') throw new Error('助教只能點名'); };
  const canCls = cls => { if (!allowed(cls)) throw new Error('你沒有「' + cls + '」的權限'); };
  const needBr = br => { if (!brOk(br)) throw new Error('你只能處理' + au.branch + '的學生'); };
  const activeClasses = () => S.read('CLASS').filter(c => c['班級名稱'] && c['狀態'] !== '結束');
  const conf = () => S.conf();
  const limit = () => Number(conf()['補課期限天數']) || 14;
  const findRoster = (cls, br, name) => S.read('ROSTER').filter(r => r['班級'] === cls && r['分校'] === br && r['學生姓名'] === name)[0];
  const renewalCtx = () => ({ bal: L.balances(S.read('ROSTER'), S.read('SESS'), S.read('PAY'), today()), threshold: Number(conf()['續費提醒堂數']) || 6, def: Number(conf()['預設續費堂數']) || 12 });

  const A = {};

  A.apiLogin = function () {
    const t = today(), todayCls = {};
    S.read('SESS').forEach(s => { if (s['日期'] === t && s['狀態'] === '上課') todayCls[s['班級']] = true; });
    const classes = activeClasses().filter(c => allowed(c['班級名稱'])).map(c => ({ name: c['班級名稱'], time: c['時段'], weekday: c['星期'], today: !!todayCls[c['班級名稱']] }));
    const known = activeClasses().map(c => L.norm_(c['班級名稱']));
    const unknown = au.role === 'boss' || !au.classes ? [] : au.classes.filter(c => known.indexOf(c) < 0);
    return { role: au.role, roleLabel: ROLE_LABEL[au.role], branch: au.branch, name: au.name, needName: false, today: t, branches: S.branches(), classes, unknownClasses: unknown, title: conf()['網頁標題'] };
  };

  A.apiSession = function (cls, date) {
    canCls(cls);
    const t = today();
    const sess = S.read('SESS').filter(s => s['班級'] === cls).sort((a, b) => a['日期'] < b['日期'] ? -1 : 1);
    const classRow = S.read('CLASS').filter(c => c['班級名稱'] === cls)[0];
    if (!classRow) throw new Error('找不到班級：' + cls);
    if (!date) {
      const past = sess.filter(s => s['狀態'] === '上課' && s['日期'] <= t);
      date = past.length ? past[past.length - 1]['日期'] : (sess[0] ? sess[0]['日期'] : t);
    }
    const roster = S.read('ROSTER'), att = S.read('ATT').filter(a => a['班級'] === cls);
    const mark = {}, info = {};
    att.forEach(a => { if (a['日期'] === date) { const k = a['分校'] + '|' + a['學生姓名']; mark[k] = a['狀態']; info[k] = a['點名人'] + ' ' + a['更新時間']; } });
    const br = S.branches();
    const studs = roster.filter(r => r['班級'] === cls && (L.onRoll(r, date) || mark[r['分校'] + '|' + r['學生姓名']])).map(r => {
      const k = r['分校'] + '|' + r['學生姓名'];
      return { branch: r['分校'], name: r['學生姓名'], trial: !L.formalOn(r, date), status: mark[k] || '', by: info[k] || '' };
    }).sort((a, b) => (a.trial - b.trial) || (br.indexOf(a.branch) - br.indexOf(b.branch)));
    const recorded = {}; att.forEach(a => { recorded[a['日期']] = true; });
    return {
      cls, time: classRow['時段'], date, today: t,
      sessions: sess.map(s => ({ date: s['日期'], no: s['堂次'], status: s['狀態'], note: s['備註'] || '', done: !!recorded[s['日期']] })),
      sessStatus: (sess.filter(s => s['日期'] === date)[0] || {})['狀態'] || '',
      expected: L.expectedCount(roster, cls, date), students: studs
    };
  };

  A.apiSave = async function (cls, date, entries) {
    canCls(cls);
    date = L.normDateStr(date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式錯誤');
    if (date > today()) throw new Error('不能點未來的課');
    const s0 = S.read('SESS').filter(s => s['班級'] === cls && s['日期'] === date)[0];
    if (!s0) throw new Error('這天不是「' + cls + '」的上課日');
    if (s0['狀態'] === '停課') throw new Error('這堂已停課，不能點名');
    const existing = {};
    S.read('ATT').forEach(a => { if (a['班級'] === cls && a['日期'] === date) existing[a['分校'] + '|' + a['學生姓名']] = a; });
    const stamp = now(), marks = {}; let added = 0, updated = 0, removed = 0;
    entries.forEach(e => {
      const r = findRoster(cls, e.branch, e.name);
      if (!r) throw new Error('名單中找不到：' + e.branch + ' ' + e.name);
      const k = e.branch + '|' + e.name, old = existing[k];
      let st = e.status;
      if (st === '' || st == null) { if (old && old['狀態'] !== '△') { marks[k] = S.DEL; removed++; } return; }
      if (st === 'V' && !L.formalOn(r, date)) st = '☆';
      if (['V', '☆', '缺', '△'].indexOf(st) < 0) return;
      if (old) {
        if (old['狀態'] === st) return;
        if (old['狀態'] === '△' && st === '缺') return;
        marks[k] = { '狀態': st, '補課日期': st === '△' ? old['補課日期'] : '', '點名人': au.name, '更新時間': stamp }; updated++;
      } else { marks[k] = { '狀態': st, '補課日期': '', '點名人': au.name, '更新時間': stamp }; added++; }
    });
    if (Object.keys(marks).length) await S.W.setMarks(cls, date, marks);
    return { added, updated, removed };
  };

  A.apiAddTrial = async function (cls, branch, name, date) {
    canCls(cls);
    name = String(name || '').trim();
    if (!name) throw new Error('請輸入姓名');
    if (S.branches().indexOf(branch) < 0) throw new Error('分校錯誤');
    if (findRoster(cls, branch, name)) throw new Error(name + ' 已在名單中');
    await S.W.putRoster({ '班級': cls, '分校': branch, '學生姓名': name, '身分': '試聽', '加入日': L.normDateStr(date), '備註': '點名頁新增 ' + now() });
    return true;
  };

  A.apiPending = function () {
    notAssistant();
    return L.pendingMakeups(S.read('ATT'), S.read('ROSTER'), today(), limit(), conf()['缺課追蹤起始日']).filter(p => allowed(p.cls) && brOk(p.branch));
  };

  const findMark = (cls, date, branch, name) => S.read('ATT').filter(x => x['班級'] === cls && x['日期'] === date && x['分校'] === branch && x['學生姓名'] === name)[0];
  A.apiMakeup = async function (cls, date, branch, name, makeupDate) {
    notAssistant(); canCls(cls); needBr(branch);
    const a = findMark(cls, date, branch, name);
    if (!a) throw new Error('找不到這筆缺課紀錄');
    const m = {}; m[branch + '|' + name] = { '狀態': '△', '補課日期': L.normDateStr(makeupDate) || today(), '點名人': au.name || a['點名人'], '更新時間': now() };
    await S.W.setMarks(cls, date, m); return true;
  };
  A.apiUnmakeup = async function (cls, date, branch, name) {
    notAssistant(); canCls(cls); needBr(branch);
    const a = findMark(cls, date, branch, name);
    if (!a || a['狀態'] !== '△') throw new Error('這筆不是補課紀錄');
    const m = {}; m[branch + '|' + name] = { '狀態': '缺', '補課日期': '', '點名人': a['點名人'], '更新時間': now() };
    await S.W.setMarks(cls, date, m); return true;
  };
  A.apiRecentMakeups = function () {
    notAssistant();
    const since = L.addDays(today(), -14);
    return S.read('ATT').filter(a => a['狀態'] === '△' && a['補課日期'] && a['補課日期'] >= since && allowed(a['班級']) && brOk(a['分校']))
      .map(a => ({ cls: a['班級'], date: a['日期'], branch: a['分校'], name: a['學生姓名'], on: a['補課日期'], by: a['點名人'] }))
      .sort((a, b) => a.on < b.on ? 1 : -1);
  };

  A.apiSessionOp = async function (op, p) {
    needStaff();
    const cls = p.cls, t = today();
    const c = S.read('CLASS').filter(x => x['班級名稱'] === cls)[0];
    if (!c) throw new Error('找不到班級：' + cls);
    let mine = S.read('SESS').filter(s => s['班級'] === cls);
    const att = S.read('ATT'), hasAtt = d => att.some(a => a['班級'] === cls && a['日期'] === d);
    const find = d => mine.filter(s => s['日期'] === d)[0];
    const md = d => d.slice(5).replace('-', '/');
    if (op === 'move') {
      const from = L.normDateStr(p.from), to = L.normDateStr(p.to);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('新日期格式錯誤，例：2026-10-22');
      const s = find(from);
      if (!s || s['狀態'] !== '上課') throw new Error('找不到 ' + from + ' 這堂課');
      if (from === to) throw new Error('日期沒有改變');
      if (find(to)) throw new Error(to + ' 已經有一堂（' + find(to)['狀態'] + '），請換一天');
      if (hasAtt(to)) throw new Error(to + ' 已有點名紀錄，無法搬移');
      s['日期'] = to;
      s['備註'] = ('調課：原 ' + md(from) + (p.note ? '，' + p.note : '') + (s['備註'] ? '；' + s['備註'] : '')).slice(0, 200);
      await S.W.setSessions(cls, L.renumber(mine));
      const moved = await S.W.moveAttendance(cls, from, to);
      return { moved };
    }
    if (op === 'cancel') {
      const s2 = find(L.normDateStr(p.date));
      if (!s2 || s2['狀態'] !== '上課') throw new Error('找不到這堂課');
      if (hasAtt(s2['日期'])) throw new Error('這堂已有點名紀錄，請先把點名取消再停課');
      s2['狀態'] = '停課'; s2['備註'] = ('停課' + (p.note ? '：' + p.note : '') + (s2['備註'] ? '；' + s2['備註'] : '')).slice(0, 200);
      const plan = L.planSessions(c, mine);
      await S.W.setSessions(cls, plan);
      return { appended: plan.filter(x => !mine.some(m => m['日期'] === x['日期'])).map(x => x['日期']) };
    }
    if (op === 'restore') {
      const d3 = L.normDateStr(p.date), s3 = find(d3);
      if (!s3 || s3['狀態'] !== '停課') throw new Error('這堂不是停課狀態');
      s3['狀態'] = '上課'; s3['備註'] = String(s3['備註'] || '').replace(/^停課[^；]*；?/, '');
      const stops = String(c['停課日期'] || '').split(/[,，、\s]+/).filter(String).map(L.normDateStr);
      if (stops.indexOf(d3) >= 0) await S.W.saveClass(c._id, { '停課日期': stops.filter(x => x !== d3).join(', ') });
      const want = Number(c['預計堂數']) || 0; let removed = '';
      const on = mine.filter(x => x['狀態'] === '上課').sort((a, b) => a['日期'] < b['日期'] ? -1 : 1);
      if (want && on.length > want) {
        const last = on[on.length - 1];
        if (last['日期'] > t && !hasAtt(last['日期'])) { mine = mine.filter(x => x !== last); removed = last['日期']; }
      }
      await S.W.setSessions(cls, L.renumber(mine));
      return { removed };
    }
    throw new Error('未知動作');
  };

  A.apiDashboard = function () {
    needStaff();
    const t = today(), att = S.read('ATT'), sessions = S.read('SESS');
    const names = activeClasses().map(c => c['班級名稱']);
    const mine = sessions.filter(s => names.indexOf(s['班級']) >= 0);
    const done = {}; att.forEach(a => { done[a['班級'] + '|' + a['日期']] = true; });
    const todays = mine.filter(s => s['日期'] === t && s['狀態'] === '上課').map(s => ({ cls: s['班級'], no: s['堂次'], done: !!done[s['班級'] + '|' + t] }));
    const pend = L.pendingMakeups(att, S.read('ROSTER'), t, limit(), conf()['缺課追蹤起始日']).filter(p => brOk(p.branch));
    const rx = renewalCtx(), due = L.renewalsDue(rx.bal, rx.threshold).filter(b => brOk(b.branch));
    const trials = S.read('ROSTER').filter(r => names.indexOf(r['班級']) >= 0 && brOk(r['分校']) && r['身分'] === '試聽' && (!r['退班日'] || r['退班日'] > t)).length;
    return { branch: au.branch, trials, today: t, todays, missing: L.unrecordedSessions(mine, att, t),
             pending: pend.length, overdue: pend.filter(p => p.overdue).length,
             renew: due.filter(b => !b.billedOn).length, renewBilled: due.filter(b => b.billedOn).length };
  };

  A.apiRoster = function (cls) {
    needStaff();
    const t = today(), br = S.branches(), bal = {};
    L.balances(S.read('ROSTER').filter(r => r['班級'] === cls), S.read('SESS'), S.read('PAY'), t).forEach(b => { bal[b.branch + '|' + b.name] = b; });
    return S.read('ROSTER').filter(r => r['班級'] === cls && brOk(r['分校'])).map(r => {
      const b = bal[r['分校'] + '|' + r['學生姓名']];
      return { remain: b.hasPay ? b.remain : null, branch: r['分校'], name: r['學生姓名'], ident: r['身分'], join: r['加入日'], formal: r['正式起日'],
               quit: r['退班日'], note: r['備註'], contact: r['家長聯絡'], active: L.onRoll(r, t) || (r['加入日'] > t) };
    }).sort((a, b) => (b.active - a.active) || (br.indexOf(a.branch) - br.indexOf(b.branch)));
  };

  A.apiRosterAction = async function (act, p) {
    needStaff();
    if (au.role === 'branch') { if (act === 'add' && !p.branch) p.branch = au.branch; needBr(p.branch); }
    const date = L.normDateStr(p.date) || today();
    if (act === 'add') {
      const name = String(p.name || '').trim();
      if (!name) throw new Error('請輸入姓名');
      if (S.branches().indexOf(p.branch) < 0) throw new Error('請選分校');
      if (!p.classes || !p.classes.length) throw new Error('請至少勾一個班級');
      const added = [], skipped = [];
      for (const cls of p.classes) {
        if (findRoster(cls, p.branch, name)) { skipped.push(cls); continue; }
        await S.W.putRoster({ '班級': cls, '分校': p.branch, '學生姓名': name, '身分': p.ident || '正式', '加入日': date,
                              '正式起日': p.ident === '試聽' ? '' : date, '家長聯絡': p.contact || '', '備註': p.note || '' });
        added.push(cls);
      }
      return { added, skipped };
    }
    const r = findRoster(p.cls, p.branch, p.name);
    if (!r) throw new Error('找不到這位學生');
    if (act === 'formal') { r['身分'] = '正式'; r['正式起日'] = date; }
    else if (act === 'quit') r['退班日'] = date;
    else if (act === 'undoquit') { r['退班日'] = ''; r['備註'] = String(r['備註'] || '').replace(/；?試聽未續班 \d{4}-\d{2}-\d{2}/g, '').replace(/^；/, ''); }
    else if (act === 'undoformal') { r['身分'] = '試聽'; r['正式起日'] = ''; }
    else if (act === 'notcontinue') {
      if (r['身分'] !== '試聽') throw new Error(r['學生姓名'] + ' 不是試聽生');
      r['退班日'] = date; r['備註'] = (r['備註'] ? r['備註'] + '；' : '') + '試聽未續班 ' + date;
    }
    else if (act === 'contact') { r['家長聯絡'] = String(p.contact || ''); }
    else throw new Error('未知動作');
    await S.W.putRoster(r);
    return true;
  };

  A.apiTrials = function () {
    needStaff();
    const t = today(), since = L.addDays(t, -14);
    const names = activeClasses().map(c => c['班級名稱']);
    const att = S.read('ATT'), roster = S.read('ROSTER').filter(r => names.indexOf(r['班級']) >= 0 && brOk(r['分校']));
    const trialDates = r => att.filter(a => a['班級'] === r['班級'] && a['分校'] === r['分校'] && a['學生姓名'] === r['學生姓名'] && a['狀態'] === '☆').map(a => a['日期']).sort();
    const pick = r => ({ cls: r['班級'], branch: r['分校'], name: r['學生姓名'], join: r['加入日'], dates: trialDates(r), contact: r['家長聯絡'] || '' });
    const pending = roster.filter(r => r['身分'] === '試聽' && (!r['退班日'] || r['退班日'] > t)).map(pick).sort((a, b) => (a.join || '') < (b.join || '') ? -1 : 1);
    const done = [];
    roster.forEach(r => {
      if (r['身分'] === '正式' && r['正式起日'] && r['正式起日'] >= since && r['正式起日'] !== r['加入日'] && trialDates(r).length) done.push(Object.assign(pick(r), { result: '轉正', on: r['正式起日'] }));
      else if (r['身分'] === '試聽' && r['退班日'] && r['退班日'] <= t && r['退班日'] >= since) done.push(Object.assign(pick(r), { result: '不續班', on: r['退班日'] }));
    });
    done.sort((a, b) => a.on < b.on ? 1 : -1);
    return { today: t, pending, done };
  };

  A.apiRenewals = function () {
    needStaff();
    const x = renewalCtx(); x.bal = x.bal.filter(b => brOk(b.branch));
    const since = L.addDays(today(), -30);
    const recent = S.read('PAY').filter(p => p['登記日'] >= since && brOk(p['分校'])).map(p => ({ row: p._id, cls: p['班級'], branch: p['分校'], name: p['學生姓名'], count: Number(p['堂數']) || 0, amount: p['金額'], on: p['登記日'], by: p['登記人'], note: p['備註'] })).reverse().slice(0, 40);
    return { threshold: x.threshold, def: x.def, due: L.renewalsDue(x.bal, x.threshold), recent,
             unset: x.bal.filter(b => b.active && b.ident === '正式' && !b.hasPay), classes: activeClasses().map(c => c['班級名稱']) };
  };

  A.apiRenewAction = async function (act, p) {
    needStaff();
    const who = au.name || '行政', t = today();
    const roster = S.read('ROSTER'), sessions = S.read('SESS'), pays = S.read('PAY');
    const findR = (cls, br, nm) => { needBr(br); const r = roster.filter(x => x['班級'] === cls && x['分校'] === br && x['學生姓名'] === nm)[0]; if (!r) throw new Error('找不到這位學生'); return r; };
    const payRec = (cls, br, nm, n, amt, note) => ({ '班級': cls, '分校': br, '學生姓名': nm, '堂數': n, '金額': amt || '', '登記日': t, '登記人': who, '備註': note || '' });
    if (act === 'pay' || act === 'billed') {
      const items = p.items && p.items.length ? p.items : [{ cls: p.cls, branch: p.branch, name: p.name }];
      const n = Math.round(Number(p.count));
      if (act === 'pay' && !(n > 0 && n <= 200)) throw new Error('堂數要是 1～200 的整數');
      const recs = [];
      for (const it of items) {
        const r = findR(it.cls, it.branch, it.name);
        if (act === 'pay') { recs.push(payRec(it.cls, it.branch, it.name, n, Number(p.amount) || '', p.note)); if (r['續費開單日']) { r['續費開單日'] = ''; await S.W.putRoster(r); } }
        else { r['續費開單日'] = p.on ? t : ''; await S.W.putRoster(r); }
      }
      if (recs.length) await S.W.addPayments(recs);
      return items.length;
    }
    if (act === 'opening') {
      const rem = Math.round(Number(p.remain));
      if (!(rem >= 0 && rem <= 200)) throw new Error('剩餘堂數要是 0～200 的整數');
      const r2 = findR(p.cls, p.branch, p.name), b = L.balances([r2], sessions, pays, t)[0];
      if (b.hasPay) throw new Error('這位學生已有繳費紀錄，請改用「已續費」');
      await S.W.addPayment(payRec(p.cls, p.branch, p.name, b.used + rem, '', '期初（當時剩 ' + rem + ' 堂）'));
      return true;
    }
    if (act === 'classOpening') {
      const no = Math.round(Number(p.uptoNo));
      const sess = sessions.filter(s => s['班級'] === p.cls && s['狀態'] === '上課' && Number(s['堂次']) === no)[0];
      if (!sess) throw new Error('找不到第 ' + no + ' 堂');
      const upto = sess['日期'], recs = [];
      const cut = sessions.filter(s => s['班級'] === p.cls && s['日期'] <= upto);
      L.balances(roster.filter(x => x['班級'] === p.cls && brOk(x['分校'])), cut, pays, '9999-12-31').forEach(b => {
        if (b.hasPay || b.ident !== '正式' || !b.active || b.used <= 0) return;
        recs.push(payRec(b.cls, b.branch, b.name, b.used, '', '期初（整班繳到第 ' + no + ' 堂 ' + upto + '）'));
      });
      if (recs.length) await S.W.addPayments(recs);
      return recs.length;
    }
    if (act === 'undoPay') {
      needBr(p.branch);
      const rec = pays.filter(x => x._id === p.row)[0];
      if (!rec || rec['班級'] !== p.cls || rec['分校'] !== p.branch || rec['學生姓名'] !== p.name) throw new Error('資料已變動，請重新整理後再試');
      await S.W.delPayment(rec._id); return true;
    }
    throw new Error('未知動作');
  };

  /** 月結；cutoff = 影片補課統計截止日（只有主管能改） */
  A.apiMonthly = async function (month, cutoff) {
    needStaff();
    if (cutoff) {
      if (au.role !== 'boss') throw new Error('只有主管可以設定補課統計截止日');
      const cd = L.normDateStr(cutoff), cur = S.cutoffs()[month] || L.lastDayOf(month);
      if (cd !== cur) {
        if (cd < L.lastDayOf(month) || cd >= L.lastDayOf(L.nextMonth(month))) throw new Error('截止日要在 ' + L.lastDayOf(month) + ' 到 ' + L.addDays(L.lastDayOf(L.nextMonth(month)), -1) + ' 之間');
        const c = Object.assign({}, S.conf()['補課統計至'] || {}); c[month] = cd;
        await S.W.saveSettings({ '補課統計至': c });
      }
    }
    return A.monthlyData(month);
  };
  A.monthlyData = function (month) {
    needStaff();
    const br = S.branches();
    const res = L.monthlyPayroll(month, S.read('CLASS').filter(c => c['班級名稱']), S.read('SESS'), S.read('ROSTER'), S.read('ATT'), br, S.cutoffs());
    res.branches = br; res.showTotal = true; res.canSetCutoff = au.role === 'boss'; res.allBranches = br;
    if (au.role === 'branch') {
      const b = au.branch, only = sp => { const o = {}; o[b] = sp[b] || 0; return o; };
      res.rows = res.rows.filter(x => x.raw[b] > 0 || x.prevList.some(p => p.branch === b) || x.detail.some(d => d.split[b])).map(x => {
        const o = Object.assign({}, x); o.total = null; o.split = only(x.split); delete o.raw;
        o.detail = x.detail.map(d => Object.assign({}, d, { total: null, split: only(d.split) }));
        o.prevList = x.prevList.map(p => Object.assign({}, p, { amount: p.branch === b ? p.amount : null }));
        return o;
      });
      res.prev = res.prev.filter(p => p.branch === b);
      res.grand = { sessions: res.grand.sessions, n: res.grand.n, prev: res.grand.prev, nb: res.grand.nb, prevB: res.grand.prevB, total: null, split: only(res.grand.split) };
      res.branches = [b]; res.showTotal = false;
    } else res.rows.forEach(x => { delete x.raw; });
    return res;
  };

  A.apiMatrix = function (cls) {
    notAssistant(); canCls(cls);
    const isBoss = au.role === 'boss', payBr = isBoss ? null : au.role === 'branch' ? au.branch : '';
    const c = S.read('CLASS').filter(x => x['班級名稱'] === cls)[0];
    if (!c) throw new Error('找不到班級');
    const br = S.branches(), mx = L.classMatrix(cls, c['薪資規則'] || '0', S.read('SESS'), S.read('ROSTER'), S.read('ATT'), br);
    return {
      cls, rule: isBoss ? c['薪資規則'] : '', branches: br, payBranches: isBoss ? br : payBr ? [payBr] : [], showTotal: isBoss,
      sess: mx.cols.map(x => ({
        date: x.s['日期'], no: x.s['堂次'], status: x.s['狀態'], expected: x.expected,
        n: x.held ? x.pay.n : null, absent: x.absent,
        present: x.held ? x.present : null, makeup: x.held ? x.makeup : null,
        byBranch: x.held ? Object.fromEntries(br.map(b => [b, (x.present[b] || 0) + (x.makeup[b] || 0)])) : null,
        total: x.held && isBoss ? Math.round(x.pay.total) : null,
        split: !x.held || payBr === '' ? null : payBr ? { [payBr]: x.pay.split[payBr] } : x.pay.split
      })),
      rows: mx.rows.map(sr => ({ branch: sr.r['分校'], name: sr.r['學生姓名'], ident: sr.r['身分'], quit: sr.r['退班日'], marks: sr.marks }))
    };
  };

  // ═══ 管理（主管）：班級、帳號、設定 ═══
  A.adminClasses = function () {
    needBoss();
    const sess = S.read('SESS'), att = S.read('ATT');
    return S.read('CLASS').map(c => ({
      id: c._id, f: c, sessions: sess.filter(s => s['班級'] === c['班級名稱'] && s['狀態'] === '上課').length,
      stopped: sess.filter(s => s['班級'] === c['班級名稱'] && s['狀態'] === '停課').length,
      hasAtt: att.some(a => a['班級'] === c['班級名稱']),
      students: S.read('ROSTER').filter(r => r['班級'] === c['班級名稱']).length
    })).sort((a, b) => (a.f['狀態'] === '結束') - (b.f['狀態'] === '結束') || (a.f['班級名稱'] < b.f['班級名稱'] ? -1 : 1));
  };
  A.adminSaveClass = async function (id, f) {
    needBoss();
    const name = String(f['班級名稱'] || '').trim();
    if (!name) throw new Error('請填班級名稱');
    if (/[|｜]/.test(name)) throw new Error('班級名稱不能有「|」');
    const dup = S.read('CLASS').filter(c => c['班級名稱'] === name && c._id !== id);
    if (dup.length) throw new Error('已經有同名的班級');
    const old = id ? S.read('CLASS').filter(c => c._id === id)[0] : null;
    if (old && old['班級名稱'] !== name && (S.read('ROSTER').some(r => r['班級'] === old['班級名稱']) || S.read('ATT').some(a => a['班級'] === old['班級名稱'])))
      throw new Error('這個班已經有名單或點名紀錄，不能改名（可新增一個班）');
    if (!/^[一二三四五六日]$/.test(f['星期'])) throw new Error('請選星期');
    const start = L.normDateStr(f['開課日']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error('請填開課日');
    if (L.WEEK.charAt(L.weekdayOf(start)) !== f['星期']) throw new Error('開課日 ' + start + ' 不是星期' + f['星期']);
    const n = Math.round(Number(f['預計堂數']));
    if (!(n > 0 && n <= 200)) throw new Error('預計堂數要是 1～200');
    L.parseRule(f['薪資規則']); // 規則寫錯會在這裡丟出錯誤
    const fields = { '班級名稱': name, '星期': f['星期'], '時段': String(f['時段'] || ''), '開課日': start, '預計堂數': n,
                     '停課日期': String(f['停課日期'] || ''), '講師': String(f['講師'] || ''), '狀態': f['狀態'] === '結束' ? '結束' : '進行中', '備註': String(f['備註'] || '') };
    if (!old) fields.sessions = [];
    return S.W.saveClass(id, fields, String(f['薪資規則']).trim());
  };
  A.adminGenSessions = async function (id) {
    needBoss();
    const c = S.read('CLASS').filter(x => x._id === id)[0];
    if (!c) throw new Error('找不到班級');
    const mine = S.read('SESS').filter(s => s['班級'] === c['班級名稱']);
    const plan = L.planSessions(c, mine);
    await S.W.setSessions(c['班級名稱'], plan);
    return { total: plan.filter(s => s['狀態'] === '上課').length, added: plan.length - mine.length };
  };
  A.adminDeleteClass = async function (id) {
    needBoss();
    const c = S.read('CLASS').filter(x => x._id === id)[0];
    if (!c) throw new Error('找不到班級');
    if (S.read('ATT').some(a => a['班級'] === c['班級名稱']) || S.read('ROSTER').some(r => r['班級'] === c['班級名稱']))
      throw new Error('這個班已經有名單或點名紀錄，不能刪除；請改成「結束」');
    await S.W.deleteClass(id); return true;
  };

  A.adminUsers = function () {
    needBoss();
    return S.read('ACC').sort((a, b) => (b['啟用'] === true) - (a['啟用'] === true) || ((a['姓名'] || '') < (b['姓名'] || '') ? -1 : 1));
  };
  const cleanUser = f => {
    const role = ['boss', 'branch', 'teacher', 'assistant'].indexOf(f.role) >= 0 ? f.role : 'teacher';
    const branch = role === 'branch' ? String(f.branch || '') : '';
    if (role === 'branch' && S.branches().indexOf(branch) < 0) throw new Error('分校行政要選分校');
    const name = String(f.name || '').trim(); if (!name) throw new Error('請填姓名');
    return { '姓名': name, '角色': role, '分校': branch, '可點班級': (f.classes || []).map(L.norm_).filter(String), '啟用': f.active !== false };
  };
  A.adminCreateUser = async function (f, B) {
    needBoss();
    const data = cleanUser(f);
    const email = checkEmail(f.email);
    const pw = checkPassword(f.password);
    if (S.read('ACC').some(u => u.email === email)) throw new Error('這個 Email 已經在帳號清單裡');
    const uid = await B.auth.createUser(email, pw);
    Object.assign(data, { email, '建立時間': now() });
    await S.W.setUser(uid, data);
    return uid;
  };
  A.adminUpdateUser = async function (uid, f) {
    needBoss();
    if (uid === au.uid && (f.role !== 'boss' || f.active === false)) throw new Error('不能把自己降級或停用');
    await S.W.setUser(uid, cleanUser(f)); return true;
  };

  A.adminSaveSettings = async function (f) {
    needBoss();
    const br = String(f['分校'] || '').split(/[,，、\s]+/).map(s => s.trim()).filter(String);
    if (!br.length) throw new Error('至少要一個分校');
    const num = (v, d, lo, hi) => { const n = Math.round(Number(v)); return n >= lo && n <= hi ? n : d; };
    const since = L.normDateStr(f['缺課追蹤起始日'] || '');
    await S.W.saveSettings({ '分校': br, '補課期限天數': num(f['補課期限天數'], 14, 1, 365), '續費提醒堂數': num(f['續費提醒堂數'], 6, 0, 100),
                             '預設續費堂數': num(f['預設續費堂數'], 12, 1, 200), '缺課追蹤起始日': /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : '',
                             '網頁標題': String(f['網頁標題'] || '團班點名').slice(0, 40) });
    return true;
  };

  A._ctx = { au, S, isStaff, allowed, brOk };
  return A;
}
