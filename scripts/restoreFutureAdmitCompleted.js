/**
 * Phase 2.6 이름 폴백 버그 피해 복구:
 *   "미래 입원예정인데 status='입원완료'" 인 상담을 '예약완료' 로 되돌린다.
 *
 * 기준:
 *   - status === '입원완료'
 *   - admitDate 가 오늘 이후 (미래)
 *   - mergedInto 없음
 *
 * 복원:
 *   - status = '예약완료'
 *   - reservedSlot 는 보존 (이미 null 이 된 경우만 안전망 경로, 그런 건은 별도 조치 필요)
 *
 * 기록:
 *   - _backup_YYYY-MM-DDTHH-mm/futureAdmitCompleted/<id> 에 원본 저장
 *
 * 사용법:
 *   node scripts/restoreFutureAdmitCompleted.js         # dry-run
 *   node scripts/restoreFutureAdmitCompleted.js --apply # 실제 반영
 */
require('dotenv').config({ path: '.env.local' });
const admin = require('firebase-admin');
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  }),
  databaseURL: 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
});
const db = admin.database();

const APPLY = process.argv.includes('--apply');
const today = new Date(); today.setHours(0, 0, 0, 0);
const parseDate = (s) => {
  if (!s) return null;
  const t = String(s).trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) { const d = new Date(+iso[1], +iso[2]-1, +iso[3]); d.setHours(0,0,0,0); return d; }
  const md = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (md) { const d = new Date(today.getFullYear(), +md[1]-1, +md[2]); d.setHours(0,0,0,0); return d; }
  return null;
};

(async () => {
  console.log(APPLY ? '🚀 APPLY 모드' : '👀 DRY-RUN — --apply 로 실제 반영');
  const conSnap = await db.ref('consultations').once('value');
  const cons = conSnap.val() || {};

  const targets = [];
  for (const [id, c] of Object.entries(cons)) {
    if (!c || c.mergedInto) continue;
    if (c.status !== '입원완료') continue;
    const ad = parseDate(c.admitDate);
    if (!ad || ad <= today) continue;
    targets.push({ id, c });
  }
  console.log(`대상: ${targets.length}건\n`);
  targets.forEach(({ id, c }) => {
    console.log(`  ${id}  "${c.name}"  admit=${c.admitDate}  reservedSlot=${c.reservedSlot || '-'}  chart=${c.chartNo || '-'}`);
  });

  if (!APPLY) { console.log('\n(DRY-RUN)'); process.exit(0); }

  // 백업
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const backupPath = `_backup_${ts}/futureAdmitCompleted`;
  const backupObj = {};
  targets.forEach(({ id, c }) => { backupObj[id] = c; });
  await db.ref(backupPath).set(backupObj);
  console.log(`\n💾 백업: ${backupPath}`);

  const updates = {};
  targets.forEach(({ id }) => {
    updates[`consultations/${id}/status`] = '예약완료';
  });
  const entries = Object.entries(updates);
  for (let i = 0; i < entries.length; i += 500) {
    await db.ref('/').update(Object.fromEntries(entries.slice(i, i + 500)));
  }
  console.log(`✅ 복원 완료: ${targets.length}건`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
