/* 啟動：選後端 → 登入 → 讀帳號 → 載入資料 → 交給畫面 */
import { firebaseConfig, OWNER_UIDS } from './config.js';
import { createStore, COL } from './store.js';
import { createApi } from './api.js';
import * as X from './export.js';
import { todayTPE, nowTPE, norm_ } from './logic.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
let B, S = null;

async function pickBackend() {
  if (DEMO) {
    const { createMemoryBackend } = await import('./backend-memory.js');
    const { demoSeed } = await import('./demo.js');
    return createMemoryBackend(demoSeed());
  }
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    window.UI.fatal('尚未設定 Firebase', '請先依照 README 把 Firebase 設定貼到 js/config.js。<br>想先看看長什麼樣子，可以開啟 <a href="?demo">示範模式</a>。');
    return null;
  }
  const { createFirebaseBackend } = await import('./backend-firebase.js');
  return createFirebaseBackend(firebaseConfig);
}

function readOnce(col, id) {
  return new Promise((ok, bad) => { let un = null; un = B.db.listenDoc(col, id, d => { ok(d); setTimeout(() => un && un(), 0); }, bad); });
}

async function onUser(u) {
  if (S) { S.stop(); S = null; }
  if (!u) { window.UI.showLogin(DEMO); return; }
  window.UI.loading('讀取帳號…');
  try {
    let prof = await readOnce(COL.USER, u.uid);
    const isOwner = OWNER_UIDS.filter(String).indexOf(u.uid) >= 0;
    if (!prof && isOwner) {
      prof = { '姓名': '主管', email: u.email, '角色': 'boss', '分校': '', '可點班級': [], '啟用': true, '建立時間': nowTPE() };
      await B.db.set(COL.USER, u.uid, prof);
    }
    if (isOwner && prof) prof = Object.assign({}, prof, { '角色': 'boss', '啟用': true });
    if (!prof || prof['啟用'] !== true) {
      const filled = OWNER_UIDS.filter(String);
      window.UI.fatal('帳號尚未啟用', '你的帳號（' + u.email + '）還沒有被主管加入，或已經停用，請洽主管。' +
        '<br><br><span style="font-size:13px">如果你是系統擁有者：你的使用者 UID 是<br><code style="user-select:all;word-break:break-all">' + u.uid + '</code><br>' +
        (filled.length ? '目前 js/config.js 裡填的是 <code style="word-break:break-all">' + filled.join('、') + '</code>，兩者不一樣。' : '目前 js/config.js 的 OWNER_UIDS 還是空的。') +
        '<br>請把上面這串 UID 貼到 js/config.js 的 OWNER_UIDS 和 firestore.rules，重新上傳、發布規則後再登入。</span>', true);
      return;
    }
    const me = { uid: u.uid, email: u.email, name: prof['姓名'] || u.email, role: prof['角色'] || 'teacher', branch: prof['分校'] || '',
                 classes: (prof['可點班級'] || []).map(norm_).filter(String) };
    window.UI.loading('載入資料…');
    S = createStore(B, me);
    await S.start();
    window.API = createApi(S);
    window.STORE = S; window.BACKEND = B; window.XPORT = X;
    window.UI.boot();
  } catch (e) {
    console.error(e);
    window.UI.fatal('載入失敗', (e && e.message || String(e)) + '<br>若是「沒有權限」，請確認 Firestore 安全規則已發布、帳號已啟用。', true);
  }
}

(async function () {
  B = await pickBackend();
  if (!B) return;
  window.BACKEND = B;
  window.UI.setBackend(B, DEMO);
  B.auth.onChange(onUser);
})();
