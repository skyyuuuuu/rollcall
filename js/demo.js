/* 示範資料（虛構的班級與學生），只在網址加上 ?demo 時使用 */
import { planSessions, addDays, todayTPE, weekdayOf, WEEK } from './logic.js';
import { idOf } from './store.js';

export const DEMO_ACCOUNTS = [
  { label: '主管', email: 'boss@demo.tw', pw: 'demo1234' },
  { label: '分校行政（光武）', email: 'gw@demo.tw', pw: 'demo1234' },
  { label: '老師', email: 'teacher@demo.tw', pw: 'demo1234' },
  { label: '助教', email: 'ta@demo.tw', pw: 'demo1234' }
];

export function demoSeed() {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const today = todayTPE();
  const lastWd = (wd, weeksBack) => { let d = today; while (weekdayOf(d) !== wd) d = addDays(d, -1); return addDays(d, -7 * weeksBack); };
  const defs = [
    { name: '國一數學班(一)', wd: 1, time: '1630-1900', rule: '每人1050*0.4', teacher: '王老師', n: 16, back: 9 },
    { name: '私中國文班(二)', wd: 2, time: '1830-2100', rule: '4000', teacher: '陳老師', n: 20, back: 7 },
    { name: '國一英文班(五)', wd: 5, time: '1630-1900', rule: '11+:2000, 4-10:每人200, 0-3:0', teacher: '林老師', n: 16, back: 6 }
  ];
  const fam = '陳林黃張李王吳劉蔡楊許鄭謝郭洪曾周';
  const giv = ['宥廷', '品妍', '承恩', '語彤', '柏睿', '芷晴', '宇翔', '昕妤', '冠廷', '詠晴', '睿哲', '思妤', '子謙', '佳穎', '彥廷', '心妍'];
  const data = { settings: {}, classes: {}, classPay: {}, roster: {}, attendance: {}, payments: {}, users: {} };
  data.settings.main = { '分校': ['光武', '科園'], '補課期限天數': 14, '缺課追蹤起始日': '', '續費提醒堂數': 6, '預設續費堂數': 12, '網頁標題': '團班點名（示範）', '補課統計至': {} };
  let pid = 0;
  defs.forEach((d, ci) => {
    const start = lastWd(d.wd, d.back);
    const cls = { '班級名稱': d.name, '星期': WEEK.charAt(d.wd), '時段': d.time, '開課日': start, '預計堂數': d.n, '停課日期': '', '講師': d.teacher, '狀態': '進行中', '備註': '' };
    const sess = planSessions(cls, []).map(s => ({ '日期': s['日期'], '堂次': s['堂次'], '狀態': s['狀態'], '備註': '' }));
    cls.sessions = sess;
    const id = 'c' + (ci + 1);
    data.classes[id] = cls; data.classPay[id] = { '薪資規則': d.rule };
    const studs = [];
    const count = 9 + ci * 2;
    for (let i = 0; i < count; i++) {
      const name = fam.charAt((i * 5 + ci * 3) % fam.length) + giv[(i * 7 + ci) % giv.length];
      const br = i % 4 === 3 ? '科園' : '光武';
      const trial = i === count - 1;
      const join = i === count - 2 ? sess[3]['日期'] : start;
      const r = { '班級': d.name, '分校': br, '學生姓名': name, '身分': trial ? '試聽' : '正式', '加入日': trial ? sess[sess.length > 6 ? 5 : 1]['日期'] : join,
                  '正式起日': trial ? '' : join, '退班日': '', '家長聯絡': '09xx-xxx-' + String(100 + i).slice(-3), '備註': '', '續費開單日': '' };
      data.roster[idOf(d.name, br, name)] = r; studs.push(r);
    }
    const past = sess.filter(s => s['日期'] < today);
    past.slice(0, Math.max(0, past.length - 1)).forEach(s => {   // 最近一堂故意不點，示範「未點名提醒」
      const marks = {};
      studs.forEach(r => {
        if (r['加入日'] > s['日期']) return;
        const isTrial = r['身分'] === '試聽';
        if (isTrial && s['日期'] > r['加入日']) return;
        const x = rnd(); let st = isTrial ? '☆' : x < 0.88 ? 'V' : '缺', mk = '';
        if (st === '缺' && rnd() < 0.5) { st = '△'; mk = addDays(s['日期'], 3) < today ? addDays(s['日期'], 3) : today; }
        marks[r['分校'] + '|' + r['學生姓名']] = { '狀態': st, '補課日期': mk, '點名人': d.teacher, '更新時間': s['日期'] + ' 20:00' };
      });
      data.attendance[idOf(d.name, s['日期'])] = { '班級': d.name, '日期': s['日期'], marks };
    });
    if (ci === 0) studs.filter(r => r['身分'] === '正式').forEach(r => {
      data.payments['p' + (++pid)] = { '班級': d.name, '分校': r['分校'], '學生姓名': r['學生姓名'], '堂數': 12, '金額': 9000, '登記日': start, '登記人': '主管', '備註': '期初' };
    });
  });
  const users = [
    { uid: 'demo-boss', email: 'boss@demo.tw', pw: 'demo1234', d: { '姓名': '示範主管', '角色': 'boss', '分校': '', '可點班級': [], '啟用': true } },
    { uid: 'demo-gw', email: 'gw@demo.tw', pw: 'demo1234', d: { '姓名': '光武行政', '角色': 'branch', '分校': '光武', '可點班級': [], '啟用': true } },
    { uid: 'demo-t', email: 'teacher@demo.tw', pw: 'demo1234', d: { '姓名': '王老師', '角色': 'teacher', '分校': '', '可點班級': ['國一數學班(一)'], '啟用': true } },
    { uid: 'demo-ta', email: 'ta@demo.tw', pw: 'demo1234', d: { '姓名': '小助教', '角色': 'assistant', '分校': '', '可點班級': [], '啟用': true } }
  ];
  users.forEach(u => { data.users[u.uid] = Object.assign({ email: u.email }, u.d); });
  return { users: users.map(u => ({ uid: u.uid, email: u.email, pw: u.pw })), data };
}
