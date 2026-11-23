/* 下載 Excel（.xlsx）：月結、點名總表、全部資料備份。需要頁面先載入 SheetJS（window.XLSX） */
import { nowTPE } from './logic.js';

const md = d => d ? d.slice(5).replace('-', '/') : '';
const sheetName = s => String(s).replace(/[\\\/\?\*\[\]:]/g, '_').slice(0, 31);
function addSheet(wb, name, rows, widths) {
  const ws = window.XLSX.utils.aoa_to_sheet(rows);
  if (widths) ws['!cols'] = widths.map(w => ({ wch: w }));
  let n = sheetName(name), i = 2;
  while (wb.SheetNames.indexOf(n) >= 0) n = sheetName(name).slice(0, 28) + '_' + (i++);
  window.XLSX.utils.book_append_sheet(wb, ws, n);
}
function save(wb, filename) {
  const data = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const url = URL.createObjectURL(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}
function need() { if (!window.XLSX) throw new Error('Excel 元件還沒載入，請稍後再試'); }

/** 月結（版面同試算表版「月結_yyyy-MM」）；res = api.monthlyData(month) */
export function monthlyRows(res, month) {
  const br = res.allBranches || res.branches, money = res.branches, T = res.showTotal;
  const rows = [], nb = o => br.map(b => (o && o[b]) || 0);
  rows.push([month.replace('-', ' 年 ') + ' 月 講師月結（影片補課統計至 ' + md(res.cutoff) + '）']);
  rows.push([]);
  rows.push(['班級', '講師', '堂數', '總人數', '其中前月補課'].concat(T ? ['講師薪資'] : [], br.map(b => b + '人數'), money.map(b => b + '負擔')));
  res.rows.forEach(x => rows.push([x.cls, x.teacher, x.sessions, x.n, x.prev].concat(T ? [Math.round(x.total)] : [], nb(x.nb), money.map(b => x.split[b]))));
  rows.push(['合計', '', res.grand.sessions, res.grand.n, res.grand.prev].concat(T ? [Math.round(res.grand.total)] : [], nb(res.grand.nb), money.map(b => res.grand.split[b])));
  let last = null;
  res.rows.forEach(x => {
    if (x.teacher !== last) { rows.push([]); rows.push(['講師：' + (x.teacher || '（未填）')]); last = x.teacher; }
    rows.push([]); rows.push([x.cls]);
    rows.push(['日期', '應到', '實到', '影片補課', '備註'].concat(T ? ['講師薪資'] : [], br.map(b => b + '人數')));
    rows.push(['前月補課', '', '', x.prev, x.prevList.map(p => p.name + md(p.absent)).join('、') + (x.prev && !x.perHead ? '（非按人頭，不加回）' : '')]
      .concat(T ? [x.prev ? Math.round(x.prevList.reduce((a, p) => a + (p.amount || 0), 0)) : ''] : [], nb(x.prevB)));
    x.detail.forEach(d => rows.push([md(d.date), d.expected, d.present, d.same, d.notes].concat(T ? [Math.round(d.total)] : [], nb(d.byBranch))));
    rows.push(['總人數', '', x.present, x.same + x.prev, x.n].concat(T ? [Math.round(x.total)] : [], nb(x.nb)));
    if (T) rows.push(['薪資規則', x.rule]);
  });
  rows.push([]); rows.push(['備註事項']);
  rows.push(['1. 影片補課統計至 ' + md(res.cutoff) + ' 前（含）完成補課者']);
  rows.push(['2. 尚未完成補課名單']);
  let k = 0;
  res.rows.forEach(x => { if (x.unfinished.length) rows.push(['(' + (++k) + ') ' + x.cls + '－' + x.unfinished.map(u => md(u.date) + u.names.join('、')).join('；')]); });
  if (!k) rows.push(['（無）']);
  rows.push([]); rows.push(['產生時間 ' + nowTPE()]);
  return rows;
}
export function downloadMonthly(res, month) {
  need();
  const wb = window.XLSX.utils.book_new();
  addSheet(wb, '月結_' + month, monthlyRows(res, month), [22, 10, 8, 8, 30, 10, 9, 9, 9, 9]);
  save(wb, '團班月結_' + month + '.xlsx');
}

/** 點名總表（版面同原本的 Excel 點名表）；m = api.apiMatrix(cls) */
export function matrixRows(m) {
  const rows = [], br = m.branches;
  rows.push(['堂次', ''].concat(m.sess.map(s => s.status === '停課' ? '停課' : s.no)));
  rows.push(['日期', ''].concat(m.sess.map(s => md(s.date))));
  rows.push(['分校', '學生姓名＼應到'].concat(m.sess.map(s => s.status === '上課' ? s.expected : '')));
  m.rows.forEach(r => rows.push([r.branch, r.name + (r.quit ? '（退' + md(r.quit) + '）' : r.ident === '試聽' ? '（試聽）' : '')].concat(r.marks)));
  rows.push([]);
  br.forEach(b => {
    rows.push([b, '實到人數'].concat(m.sess.map(s => s.present ? s.present[b] || 0 : '')));
    rows.push([b, '補課人數'].concat(m.sess.map(s => s.makeup ? s.makeup[b] || 0 : '')));
  });
  rows.push(['總人數', ''].concat(m.sess.map(s => s.n == null ? '' : s.n)));
  (m.payBranches || []).forEach(b => rows.push([b + '校薪資負擔', ''].concat(m.sess.map(s => s.split ? s.split[b] : ''))));
  if (m.showTotal) rows.push(['講師總薪資', ''].concat(m.sess.map(s => s.total == null ? '' : s.total)));
  rows.push([]);
  if (m.rule) rows.push(['薪資規則', m.rule]);
  rows.push(['記錄方式', 'V 到課｜△ 影片補課｜☆ 試聽生｜缺 缺課未補']);
  rows.push(['產生時間', nowTPE()]);
  return rows;
}
export function downloadMatrix(list) {
  need();
  const wb = window.XLSX.utils.book_new();
  list.forEach(m => addSheet(wb, m.cls, matrixRows(m), [8, 16].concat(m.sess.map(() => 6))));
  save(wb, (list.length === 1 ? '點名總表_' + list[0].cls : '點名總表_全部班級') + '.xlsx');
}

/** 全部資料備份（主管） */
export function downloadBackup(S) {
  need();
  const wb = window.XLSX.utils.book_new();
  const tab = (name, head, recs) => addSheet(wb, name, [head].concat(recs.map(r => head.map(h => r[h] == null ? '' : Array.isArray(r[h]) ? r[h].join(',') : r[h]))));
  tab('班級設定', ['班級名稱', '星期', '時段', '開課日', '預計堂數', '停課日期', '薪資規則', '講師', '狀態', '備註'], S.read('CLASS'));
  tab('堂次', ['班級', '堂次', '日期', '狀態', '備註'], S.read('SESS'));
  tab('名單', ['班級', '分校', '學生姓名', '身分', '加入日', '正式起日', '退班日', '家長聯絡', '備註', '續費開單日'], S.read('ROSTER'));
  tab('點名紀錄', ['班級', '日期', '分校', '學生姓名', '狀態', '補課日期', '點名人', '更新時間'], S.read('ATT').sort((a, b) => a['日期'] < b['日期'] ? -1 : a['日期'] > b['日期'] ? 1 : 0));
  tab('繳費紀錄', ['班級', '分校', '學生姓名', '堂數', '金額', '登記日', '登記人', '備註'], S.read('PAY'));
  tab('帳號', ['姓名', 'email', '角色', '分校', '可點班級', '啟用'], S.read('ACC'));
  save(wb, '團班點名備份_' + nowTPE().slice(0, 10) + '.xlsx');
}
