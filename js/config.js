/* ═══ 第一次安裝時要改這個檔案（步驟見 README） ═══ */

// 1) Firebase 專案設定：Firebase 主控台 → 專案設定 → 一般 → 你的應用程式 → SDK 設定（Config），整段貼上
export const firebaseConfig = {
  apiKey: "AIzaSyABY4SW50A5ukKT06r06In8Wf2iTeHXQ3w",
  authDomain: "rollcall-89c18.firebaseapp.com",
  projectId: "rollcall-89c18",
  storageBucket: "rollcall-89c18.firebasestorage.app",
  messagingSenderId: "505542050842",
  appId: "1:505542050842:web:1421b6fd36cd69cf533da3"
};

// 2) 系統擁有者（主管）的 UID：Firebase 主控台 → Authentication → 使用者 → 複製你自己那一列的「使用者 UID」
//    擁有者永遠是主管，可以登入後再幫其他人開帳號。firestore.rules 裡也要填同樣的 UID。
export const OWNER_UIDS = [
  "iD6WQPXUTzTlKWySNVcICxm3uqD3"
];
