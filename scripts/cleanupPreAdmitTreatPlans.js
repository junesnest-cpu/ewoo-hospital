/**
 * treatmentPlansV2 pre-admit leak 청소
 *   2026-04-21 마이그레이션이 같은 slot 의 누적 데이터(과거 환자들 plan)를
 *   현재 환자 {pid}/{aKey} 아래로 그대로 복사하여 admit 이전 달에 잔존.
 *
 *   각 (pid, aKey) 별로 admit 월(YYYY-MM) 미만 month 노드를 제거.
 *   원본은 _backup_cleanupPreAdmitTreatPlans_<ts>/treatmentPlansV2/{pid}/{aKey}/{mk}
 *   에 보관.
 *
 *   --apply 없으면 dry-run.
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

(async () => {
  const tpSnap = await db.ref('treatmentPlansV2').once('value');
  const tp = tpSnap.val() || {};

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = `_backup_cleanupPreAdmitTreatPlans_${ts}`;

  const updates = {};        // path → null  (or value for backup)
  const stats = {
    pidsAffected: new Set(),
    admitsAffected: 0,
    monthsRemoved: 0,
    daysRemoved: 0,
    itemsRemoved: 0,
  };

  for (const [pid, byAdmit] of Object.entries(tp)) {
    if (!byAdmit || typeof byAdmit !== 'object') continue;
    for (const [aKey, byMonth] of Object.entries(byAdmit)) {
      if (!byMonth || typeof byMonth !== 'object') continue;
      const admitYM = aKey.slice(0, 7); // "YYYY-MM"
      const leakedMks = Object.keys(byMonth).filter(mk => mk < admitYM);
      if (leakedMks.length === 0) continue;
      stats.pidsAffected.add(pid);
      stats.admitsAffected++;
      for (const mk of leakedMks) {
        const m = byMonth[mk] || {};
        const dayCount = Object.keys(m).length;
        let itemCount = 0;
        for (const items of Object.values(m)) {
          const arr = Array.isArray(items) ? items : items ? Object.values(items) : [];
          itemCount += arr.length;
        }
        stats.monthsRemoved++;
        stats.daysRemoved += dayCount;
        stats.itemsRemoved += itemCount;
        // 백업 + 삭제
        updates[`${backupRoot}/treatmentPlansV2/${pid}/${aKey}/${mk}`] = m;
        updates[`treatmentPlansV2/${pid}/${aKey}/${mk}`] = null;
      }
    }
  }

  console.log('═ treatmentPlansV2 pre-admit cleanup ═');
  console.log(`  대상 patient: ${stats.pidsAffected.size}`);
  console.log(`  대상 admission: ${stats.admitsAffected}`);
  console.log(`  제거 month: ${stats.monthsRemoved}`);
  console.log(`  제거 day:   ${stats.daysRemoved}`);
  console.log(`  제거 item:  ${stats.itemsRemoved}`);

  if (!APPLY) {
    console.log('\n[dry-run] --apply 없이 실행 — 변경 없음.');
    process.exit(0);
  }

  if (Object.keys(updates).length === 0) {
    console.log('\n변경할 게 없음.');
    process.exit(0);
  }

  console.log(`\n백업 경로: /${backupRoot}/treatmentPlansV2/...`);
  const entries = Object.entries(updates);
  for (let i = 0; i < entries.length; i += 500) {
    await db.ref('/').update(Object.fromEntries(entries.slice(i, i + 500)));
    console.log(`  ${Math.min(i + 500, entries.length)}/${entries.length} 적용`);
  }
  console.log('완료.');
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
