/* 團班點名系統 — 純計算邏輯（從 Apps Script 版移植，規則完全相同） */
var Utilities; // 瀏覽器沒有；normDateStr 會自動改用本地格式
var M = { V: 'V', MAKEUP: '△', TRIAL: '☆', ABSENT: '缺' };
var PAID = ['V', '△', '☆'];
var WEEK = '日一二三四五六'; // 與 Date.getDay() 對齊
var TZ = 'Asia/Taipei';

// ═════════════════════ 純邏輯（不碰試算表，可單獨測試） ═════════════════════

/** 薪資規則解析。語法：以逗號分隔多段，每段「人數範圍:金額」，範圍可省略。
 *  範圍：「11-20」「21+」「5」；金額：「4000」「1050*0.5」「每人200」「每人1050*0.4」
 *  例：「每人1050*0.5」「4000」「21+:3000, 11-20:2400, 6-10:每人200, 1-5:1000」 */
function parseRule(rule) {
  var segs = ruleSegs_(rule);
  return function (n) {
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (n >= s.lo && n <= s.hi) return s.perHead ? n * s.val : s.val;
    }
    return 0;
  };
}
/** 純按人頭計薪（例：每人1050*0.4）→ 回傳每人金額；固定、級距制 → null */
function perHeadRate(rule) {
  var segs = ruleSegs_(rule);
  return segs.length === 1 && segs[0].perHead && segs[0].lo === -Infinity && segs[0].hi === Infinity ? segs[0].val : null;
}
function ruleSegs_(rule) {
  var text = String(rule == null ? '' : rule).replace(/[，、；;]/g, ',').replace(/：/g, ':').replace(/\s+/g, '');
  if (!text) throw new Error('薪資規則是空的');
  var segs = text.split(',').filter(String).map(function (seg) {
    var range = null, amt = seg, idx = seg.indexOf(':');
    if (idx >= 0) { range = seg.slice(0, idx); amt = seg.slice(idx + 1); }
    var lo = -Infinity, hi = Infinity, m;
    if (range !== null) {
      if ((m = range.match(/^(\d+)\+$/))) { lo = +m[1]; }
      else if ((m = range.match(/^(\d+)-(\d+)$/))) { lo = +m[1]; hi = +m[2]; }
      else if ((m = range.match(/^(\d+)$/))) { lo = hi = +m[1]; }
      else throw new Error('看不懂人數範圍「' + range + '」（規則：' + rule + '）');
    }
    var perHead = /^每人/.test(amt);
    if (perHead) amt = amt.replace(/^每人/, '');
    if (!/^\d+(\.\d+)?(\*\d+(\.\d+)?)*$/.test(amt)) throw new Error('看不懂金額「' + amt + '」（規則：' + rule + '）');
    var val = amt.split('*').reduce(function (a, b) { return a * Number(b); }, 1);
    return { lo: lo, hi: hi, perHead: perHead, val: val };
  });
  return segs;
}

/** 依各分校計薪人數算出講師薪資與分校分攤（比例分攤，四捨五入後差額歸最後一個分校） */
function calcPay(rule, counts, branches) {
  var n = 0; branches.forEach(function (b) { n += counts[b] || 0; });
  var total = n > 0 ? parseRule(rule)(n) : 0;
  var raw = {}, split = {}, acc = 0;
  branches.forEach(function (b, i) {
    raw[b] = n > 0 ? total * (counts[b] || 0) / n : 0;
    if (i < branches.length - 1) { split[b] = Math.round(raw[b]); acc += split[b]; }
    else split[b] = Math.round(total) - acc;
  });
  return { n: n, total: total, raw: raw, split: split };
}

/** 名單某列在某日期是否在班 / 是否為正式生 */
function onRoll(r, date) {
  return (!r['加入日'] || r['加入日'] <= date) && (!r['退班日'] || r['退班日'] > date);
}
function formalOn(r, date) {
  if (!onRoll(r, date) || r['身分'] !== '正式') return false;
  var from = r['正式起日'] || r['加入日'];
  return !from || from <= date;
}

/** 應到人數 = 當天在班的正式生（與原表第 3 列相同定義） */
function expectedCount(roster, cls, date) {
  return roster.filter(function (r) { return r['班級'] === cls && formalOn(r, date); }).length;
}

/** 日期工具（字串 yyyy-MM-dd） */
function addDays(ds, n) {
  var p = ds.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return d.toISOString().slice(0, 10);
}
function weekdayOf(ds) { var p = ds.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay(); }

/** 產生／補齊堂次。existing：該班現有堂次；回傳完整（排序、重新編號）的堂次清單 */
function planSessions(cls, existing) {
  var start = cls['開課日'], want = Number(cls['預計堂數']) || 0;
  if (!start) throw new Error('「' + cls['班級名稱'] + '」沒有開課日');
  var wd = WEEK.indexOf(String(cls['星期']).replace(/^(週|星期)/, ''));
  if (wd < 0) throw new Error('「' + cls['班級名稱'] + '」的星期請填 一～日');
  if (weekdayOf(start) !== wd) throw new Error('「' + cls['班級名稱'] + '」開課日 ' + start + ' 不是星期' + cls['星期']);
  var stops = String(cls['停課日期'] || '').split(/[,，、\s]+/).filter(String).map(normDateStr);
  var map = {};
  existing.forEach(function (s) { map[s['日期']] = { '日期': s['日期'], '狀態': s['狀態'] || '上課', '備註': s['備註'] || '' }; });
  stops.forEach(function (d) {
    if (map[d]) map[d]['狀態'] = '停課';
    else map[d] = { '日期': d, '狀態': '停課', '備註': '' };
  });
  var count = function () { return Object.keys(map).filter(function (k) { return map[k]['狀態'] === '上課'; }).length; };
  // 補堂一律接在「現有最後一堂」之後，避免把已調走的原日期又補回來
  var lastExisting = existing.map(function (s) { return s['日期']; }).sort().pop() || '';
  var d = start, guard = 0;
  while (d <= lastExisting) d = addDays(d, 7);
  while (count() < want && guard++ < 400) {
    if (!map[d]) map[d] = { '日期': d, '狀態': '上課', '備註': '' };
    d = addDays(d, 7);
  }
  var no = 0;
  return Object.keys(map).sort().map(function (k) {
    var s = map[k];
    return { '班級': cls['班級名稱'], '堂次': s['狀態'] === '上課' ? ++no : '', '日期': k, '狀態': s['狀態'], '備註': s['備註'] };
  });
}

/** 依日期排序並重新編堂次 */
function renumber(list) {
  var no = 0;
  return list.slice().sort(function (a, b) { return a['日期'] < b['日期'] ? -1 : 1; }).map(function (s) {
    var o = {}; for (var k in s) if (k !== '_row') o[k] = s[k];
    o['堂次'] = o['狀態'] === '上課' ? ++no : '';
    return o;
  });
}

/** 某班的點名矩陣資料（總表與網頁共用） */
function classMatrix(clsName, rule, sessions, roster, att, branches) {
  var sess = sessions.filter(function (s) { return s['班級'] === clsName; })
    .sort(function (a, b) { return a['日期'] < b['日期'] ? -1 : 1; });
  var studs = roster.filter(function (r) { return r['班級'] === clsName; });
  studs.sort(function (a, b) { return branches.indexOf(a['分校']) - branches.indexOf(b['分校']); });
  var mark = {};
  att.forEach(function (a) { if (a['班級'] === clsName) mark[a['日期'] + '|' + a['分校'] + '|' + a['學生姓名']] = a['狀態']; });
  var cols = sess.map(function (s) {
    var counts = {}, present = {}, makeup = {}, absent = 0, recorded = 0;
    branches.forEach(function (b) { counts[b] = 0; present[b] = 0; makeup[b] = 0; });
    studs.forEach(function (r) {
      var v = mark[s['日期'] + '|' + r['分校'] + '|' + r['學生姓名']];
      if (!v) return;
      recorded++;
      if (v === 'V' || v === '☆') present[r['分校']] = (present[r['分校']] || 0) + 1;
      if (v === '△') makeup[r['分校']] = (makeup[r['分校']] || 0) + 1;
      if (v === '缺') absent++;
      if (PAID.indexOf(v) >= 0) counts[r['分校']] = (counts[r['分校']] || 0) + 1;
    });
    var held = s['狀態'] === '上課' && recorded > 0;
    var pay = held ? calcPay(rule, counts, branches) : null;
    return { s: s, expected: expectedCount(roster, clsName, s['日期']), present: present, makeup: makeup,
             absent: absent, recorded: recorded, held: held, pay: pay };
  });
  var rows = studs.map(function (r) {
    return { r: r, marks: sess.map(function (s) { return mark[s['日期'] + '|' + r['分校'] + '|' + r['學生姓名']] || ''; }) };
  });
  return { sess: sess, cols: cols, rows: rows };
}

/** 月結：month = 'yyyy-MM' */
/** 月份工具 */
function nextMonth(m) { var y = +m.slice(0, 4), mo = +m.slice(5, 7) + 1; if (mo > 12) { y++; mo = 1; } return y + '-' + ('0' + mo).slice(-2); }
function lastDayOf(m) { return addDays(nextMonth(m) + '-01', -1); }
/** 補課結算月份：從缺課那個月開始，第一個「補課日期 ≤ 該月補課統計截止日」的月份。
 *  截止日預設是月底，可在月結頁設定（例如 9 月統計到 10/01）。沒有補課日期的舊資料算在原月份。 */
function settleMonth(sessionMonth, on, cutoffs) {
  if (!on) return sessionMonth;
  var m = sessionMonth;
  for (var i = 0; i < 60; i++) {
    if (on <= ((cutoffs && cutoffs[m]) || lastDayOf(m))) return m;
    m = nextMonth(m);
  }
  return m;
}

/** 月結（版面比照講師計算人數表）：
 *  ・每堂：應到、實到（V+☆）、影片補課（在本月統計截止前補完的）、備註（試上／入班／退班）。
 *  ・前月補課：以前月份的缺課、在本月才補完的，另列人數與「姓名 缺課日期」。
 *    按人頭計薪的班加回每人金額（由該生分校負擔）；固定、級距制只列出、不加回。
 *  ・尚未完成補課名單：本月缺課、到截止日還沒補的。 */
function monthlyPayroll(month, classes, sessions, roster, att, branches, cutoffs) {
  var cutoff = (cutoffs && cutoffs[month]) || lastDayOf(month);
  var out = [], prevAll = [], grand = { total: 0, sessions: 0, n: 0, prev: 0, raw: {}, nb: {}, prevB: {} };
  branches.forEach(function (b) { grand.raw[b] = 0; grand.nb[b] = 0; grand.prevB[b] = 0; });
  classes.forEach(function (c) {
    var name = c['班級名稱'], rule = c['薪資規則'], rate = perHeadRate(rule);
    var held = {}, ros = roster.filter(function (r) { return r['班級'] === name; });
    att.forEach(function (a) { if (a['班級'] === name) (held[a['日期']] = held[a['日期']] || []).push(a); });
    var row = { cls: name, teacher: c['講師'] || '', rule: rule, perHead: rate !== null, rate: rate,
                sessions: 0, present: 0, same: 0, prev: 0, n: 0, total: 0, raw: {}, detail: [], prevList: [], unfinished: [],
                nb: {}, prevB: {} }; // nb = 各分校計薪人數（實到＋影片補課＋前月補課）
    branches.forEach(function (b) { row.raw[b] = 0; row.nb[b] = 0; row.prevB[b] = 0; });
    sessions.filter(function (s) { return s['班級'] === name && s['狀態'] === '上課' && held[s['日期']]; })
      .sort(function (a, b) { return a['日期'] < b['日期'] ? -1 : 1; })
      .forEach(function (s) {
        var d = s['日期'], sm = d.slice(0, 7), counts = {}, present = 0, same = 0, notes = [], miss = [];
        branches.forEach(function (b) { counts[b] = 0; });
        held[d].forEach(function (a) {
          var st = a['狀態'], stl = st === '△' ? settleMonth(sm, a['補課日期'], cutoffs) : null;
          if (st === 'V' || st === '☆' || (st === '△' && stl === sm)) {
            counts[a['分校']] = (counts[a['分校']] || 0) + 1;
            if (st === '△') same++; else present++;
            if (st === '☆') notes.push(a['學生姓名'] + '試上');
          }
          if (sm === month && (st === '缺' || (st === '△' && stl > sm))) miss.push(a['學生姓名']);
          if (st === '△' && stl === month && sm !== month) { // 前月補課
            var amt = rate !== null ? rate : 0;
            var sp = {}; branches.forEach(function (b) { sp[b] = b === a['分校'] ? amt : 0; });
            var item = { cls: name, name: a['學生姓名'], branch: a['分校'], absent: d, no: s['堂次'], on: a['補課日期'], perHead: rate !== null, amount: amt, split: sp };
            row.prevList.push(item); prevAll.push(item);
            row.prev++; row.total += amt; row.raw[a['分校']] = (row.raw[a['分校']] || 0) + amt;
            row.prevB[a['分校']] = (row.prevB[a['分校']] || 0) + 1; row.nb[a['分校']] = (row.nb[a['分校']] || 0) + 1;
          }
        });
        if (sm !== month) return;
        ros.forEach(function (r) {
          if (r['身分'] === '正式' && (r['正式起日'] || r['加入日']) === d) notes.push(r['學生姓名'] + '入班');
          if (r['退班日'] === d) notes.push(r['學生姓名'] + '退班');
        });
        var pay = calcPay(rule, counts, branches);
        row.sessions++; row.present += present; row.same += same; row.total += pay.total;
        var byB = {};
        branches.forEach(function (b) { row.raw[b] += pay.raw[b]; row.nb[b] += counts[b] || 0; byB[b] = counts[b] || 0; });
        row.detail.push({ date: d, no: s['堂次'], expected: expectedCount(roster, name, d), present: present, same: same,
                          byBranch: byB, notes: notes.join('、'), total: pay.total, split: pay.split });
        if (miss.length) row.unfinished.push({ date: d, names: miss });
      });
    if (!row.detail.length && !row.prevList.length) return;
    row.n = row.present + row.same + row.prev;
    row.split = roundSplit(row.total, row.raw, branches);
    grand.total += row.total; grand.sessions += row.sessions; grand.n += row.n; grand.prev += row.prev;
    branches.forEach(function (b) { grand.raw[b] += row.raw[b]; grand.nb[b] += row.nb[b] || 0; grand.prevB[b] += row.prevB[b] || 0; });
    out.push(row);
  });
  out.sort(function (a, b) { return (a.teacher || '~') < (b.teacher || '~') ? -1 : (a.teacher || '~') > (b.teacher || '~') ? 1 : 0; });
  grand.split = roundSplit(grand.total, grand.raw, branches);
  return { month: month, cutoff: cutoff, rows: out, grand: grand, prev: prevAll };
}
function roundSplit(total, raw, branches) {
  var split = {}, acc = 0;
  branches.forEach(function (b, i) {
    if (i < branches.length - 1) { split[b] = Math.round(raw[b]); acc += split[b]; }
    else split[b] = Math.round(total) - acc;
  });
  return split;
}

/** 缺課未補清單 */
function pendingMakeups(att, roster, today, limitDays, since) {
  since = normDateStr(since) || '';
  return att.filter(function (a) { return a['狀態'] === '缺' && a['日期'] <= today && a['日期'] >= since; })
    .map(function (a) {
      var days = Math.round((Date.parse(today) - Date.parse(a['日期'])) / 864e5);
      return { cls: a['班級'], date: a['日期'], branch: a['分校'], name: a['學生姓名'], days: days, overdue: days > limitDays };
    })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.name < b.name ? -1 : 1; });
}

/** 續費：每位學生在每個班的已繳／已上／剩餘堂數。
 *  已上 = 該班「上課」且日期 ≤ 今天、學生當天為正式生的堂數（缺課照扣，試聽不扣）。
 *  lastDate = 已繳堂數用完的那一堂日期（依已排堂次推算）。 */
function balances(roster, sessions, payments, today) {
  var paid = {}, has = {};
  payments.forEach(function (p) {
    var k = p['班級'] + '|' + p['分校'] + '|' + p['學生姓名'];
    paid[k] = (paid[k] || 0) + (Number(p['堂數']) || 0); has[k] = true;
  });
  var byCls = {};
  sessions.forEach(function (s) {
    if (s['狀態'] !== '上課') return;
    (byCls[s['班級']] = byCls[s['班級']] || []).push(s['日期']);
  });
  Object.keys(byCls).forEach(function (c) { byCls[c].sort(); });
  return roster.map(function (r) {
    var k = r['班級'] + '|' + r['分校'] + '|' + r['學生姓名'];
    var from = r['正式起日'] || r['加入日'] || '';
    var counted = (byCls[r['班級']] || []).filter(function (d) {
      return r['身分'] === '正式' && d >= from && (!r['退班日'] || d < r['退班日']);
    });
    var used = counted.filter(function (d) { return d <= today; }).length;
    var p = paid[k] || 0;
    return { cls: r['班級'], branch: r['分校'], name: r['學生姓名'], ident: r['身分'], quit: r['退班日'] || '',
             active: onRoll(r, today), hasPay: !!has[k], paid: p, used: used, remain: p - used,
             lastDate: p > 0 ? (counted[p - 1] || '') : '', billedOn: r['續費開單日'] || '' };
  });
}
/** 需要續費的名單（在班正式生、已設定堂數、剩餘 ≤ 門檻） */
function renewalsDue(bal, threshold) {
  return bal.filter(function (b) { return b.active && b.ident === '正式' && !b.quit && b.hasPay && b.remain <= threshold; })
    .sort(function (a, b) { return a.remain - b.remain || (a.cls < b.cls ? -1 : 1); });
}

/** 已過日期但還沒點名的堂次 */
function unrecordedSessions(sessions, att, today) {
  var has = {};
  att.forEach(function (a) { has[a['班級'] + '|' + a['日期']] = true; });
  return sessions.filter(function (s) { return s['狀態'] === '上課' && s['日期'] < today && !has[s['班級'] + '|' + s['日期']]; })
    .map(function (s) { return { cls: s['班級'], date: s['日期'], no: s['堂次'] }; });
}

function normDateStr(v) {
  if (v === '' || v == null) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return (typeof Utilities !== 'undefined') ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : v.toISOString().slice(0, 10);
  }
  var m = String(v).trim().match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (!m) return String(v).trim();
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}


function norm_(v) {
  return String(v == null ? '' : v)
    .replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[\s\u3000]+/g, '');
}
function splitCls_(v) { return String(v || '').split(/[,，、;；\n]+/).map(norm_).filter(String); }

/** 台北時間的今天／現在 */
export function todayTPE() { return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date()); }
export function nowTPE() {
  var p = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  return p.replace(',', '').slice(0, 16);
}

export { M, PAID, WEEK, TZ, parseRule, perHeadRate, calcPay, onRoll, formalOn, expectedCount, addDays, weekdayOf,
  planSessions, renumber, classMatrix, nextMonth, lastDayOf, settleMonth, monthlyPayroll, roundSplit,
  pendingMakeups, balances, renewalsDue, unrecordedSessions, normDateStr, norm_, splitCls_ };
