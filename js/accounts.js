/* 帳號規則：Email＋密碼（Firebase Authentication 保管密碼，網頁和資料庫碰不到密碼本身） */
export function checkEmail(e) {
  e = String(e || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Email 格式不對');
  return e;
}
export function checkPassword(pw) {
  pw = String(pw || '');
  if (pw.length < 8) throw new Error('密碼至少要 8 個字元');
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) throw new Error('密碼要同時有英文和數字');
  return pw;
}
