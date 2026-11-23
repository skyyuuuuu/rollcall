/* Firebase 後端（Auth：Email＋密碼；資料：Firestore） */
import { initializeApp, deleteApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail,
  createUserWithEmailAndPassword, updatePassword, EmailAuthProvider, reauthenticateWithCredential
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, query, where, orderBy, limit, onSnapshot, setDoc, deleteDoc, writeBatch, deleteField
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

export const DEL = Symbol('DEL');

/** 把資料裡的 DEL 換成 Firestore 的 deleteField() */
function conv(v) {
  if (v === DEL) return deleteField();
  if (Array.isArray(v)) return v.map(conv);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = conv(v[k]); return o; }
  return v;
}

const AUTH_MSG = {
  'auth/invalid-credential': 'Email 或密碼錯誤',
  'auth/wrong-password': 'Email 或密碼錯誤',
  'auth/user-not-found': 'Email 或密碼錯誤',
  'auth/invalid-email': 'Email 格式不對',
  'auth/too-many-requests': '嘗試太多次，請稍後再試',
  'auth/email-already-in-use': '這個 Email 已經有帳號了',
  'auth/weak-password': '密碼至少要 8 個字元',
  'auth/network-request-failed': '網路連線失敗',
  'auth/requires-recent-login': '請重新登入後再改密碼',
  'unavailable': '連不上伺服器，請確認網路後再試',
  'permission-denied': '沒有權限（請確認帳號已啟用、Firestore 安全規則已發布）'
};
function nice(e) { const m = AUTH_MSG[e && e.code]; if (m) { const n = new Error(m); n.code = e.code; return n; } return e; }

export function createFirebaseBackend(config) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  let db;
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch (e) { db = initializeFirestore(app, {}); }

  return {
    DEL,
    kind: 'firebase',
    auth: {
      onChange(cb) { return onAuthStateChanged(auth, u => cb(u ? { uid: u.uid, email: u.email } : null)); },
      async signIn(email, pw) { try { await signInWithEmailAndPassword(auth, email, pw); } catch (e) { throw nice(e); } },
      signOut() { return signOut(auth); },
      async reset(email) { try { await sendPasswordResetEmail(auth, email); } catch (e) { throw nice(e); } },
      /** 主管幫別人開帳號：用第二個 app 實體建立，避免把自己登出 */
      async createUser(email, pw) {
        const sec = initializeApp(config, 'sec-' + Date.now());
        try {
          const a2 = getAuth(sec);
          const cred = await createUserWithEmailAndPassword(a2, email, pw);
          const uid = cred.user.uid;
          await signOut(a2);
          return uid;
        } catch (e) { throw nice(e); } finally { await deleteApp(sec); }
      },
      async changePassword(oldPw, newPw) {
        const u = auth.currentUser;
        if (!u) throw new Error('尚未登入');
        try {
          await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, oldPw));
          await updatePassword(u, newPw);
        } catch (e) { throw nice(e); }
      }
    },
    db: {
      /** 監聽集合；filters = [[欄位, '==', 值], ...]；cb(docs: [{id, data}]) */
      listen(col, filters, cb, onErr) {
        let q = collection(db, col);
        if (filters && filters.length) q = query(q, ...filters.map(f => where(f[0], f[1], f[2])));
        return onSnapshot(q, snap => cb(snap.docs.map(d => ({ id: d.id, data: d.data() }))), e => onErr && onErr(nice(e)));
      },
      listenDoc(col, id, cb, onErr) {
        return onSnapshot(doc(db, col, id), d => cb(d.exists() ? d.data() : null), e => onErr && onErr(nice(e)));
      },
      newId(col) { return doc(collection(db, col)).id; },
      async get(col, id) { try { const d = await getDoc(doc(db, col, id)); return d.exists() ? d.data() : null; } catch (e) { throw nice(e); } },
      async set(col, id, data, merge) { try { await setDoc(doc(db, col, id), conv(data), merge ? { merge: true } : {}); } catch (e) { throw nice(e); } },
      async del(col, id) { try { await deleteDoc(doc(db, col, id)); } catch (e) { throw nice(e); } },
      /** ops: [{op:'set'|'del', col, id, data, merge}]，一次最多 500 筆 */
      /** 一次性查詢：filters 同 listen；order = [欄位, 'asc'|'desc']；max = 筆數上限 */
      async query(col, filters, order, max) {
        const parts = (filters || []).map(f => where(f[0], f[1], f[2]));
        if (order) parts.push(orderBy(order[0], order[1] || 'asc'));
        if (max) parts.push(limit(max));
        try { const snap = await getDocs(query(collection(db, col), ...parts)); return snap.docs.map(d => ({ id: d.id, data: d.data() })); }
        catch (e) { throw nice(e); }
      },
      async batch(ops) {
        for (let i = 0; i < ops.length; i += 450) {
          const b = writeBatch(db);
          ops.slice(i, i + 450).forEach(o => {
            const ref = doc(db, o.col, o.id);
            if (o.op === 'del') b.delete(ref); else b.set(ref, conv(o.data), o.merge ? { merge: true } : {});
          });
          try { await b.commit(); } catch (e) { throw nice(e); }
        }
      }
    }
  };
}
