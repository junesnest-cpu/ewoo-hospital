/**
 * 강영희 1/5 상담 복구
 *   - slotOverrides fallback 버그(2026-04-24 이전)로 Jan 5 상담의
 *     reservedSlot/admitDate/dischargeDate 가 Apr 24 예약 값으로 덮어써짐.
 *   - 이 스크립트는 강영희 상담 전체를 나열하고, 과거(2026-01 createdAt)
 *     상담을 status=입원완료 + reservedSlot=null 로 확정.
 *   - admitDate 는 사용자가 수동으로 확인·수정하도록 dry-run 으로만 출력.
 *
 * 사용:
 *   node scripts/repairKangYounghee.js            # dry-run (조회만)
 *   node scripts/repairKangYounghee.js --apply    # 실제 적용 (백업 포함)
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
const NAME = '강영희';
const baseName = (n) => (n || '').replace(/^신\)\s*/, '').replace(/\d+$/, '').replace(/\s/g, '').trim();

(async () => {
  const [conSnap, slotSnap] = await Promise.all([
    db.ref('consultations').once('value'),
    db.ref('slots').once('value'),
  ]);
  const cons = conSnap.val() || {};
  const slots = slotSnap.val() || {};

  console.log(`═ consultations 중 baseName=${NAME} ═`);
  const matched = [];
  for (const [id, c] of Object.entries(cons)) {
    if (!c || baseName(c.name) !== NAME) continue;
    matched.push({ id, ...c });
  }
  matched.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  if (matched.length === 0) {
    console.log('  (매칭 없음)'); process.exit(0);
  }
  matched.forEach(c => {
    console.log(`  ${c.id}`);
    console.log(`     name="${c.name}" status="${c.status || ''}" admitDate=${c.admitDate || '-'} dischargeDate=${c.dischargeDate || '-'}`);
    console.log(`     chartNo=${c.chartNo || '-'} patientId=${c.patientId || '-'} reservedSlot=${c.reservedSlot || '-'}`);
    console.log(`     createdAt=${c.createdAt || '-'}`);
  });

  console.log(`\n═ slots 중 ${NAME} (current / reservations) ═`);
  for (const [sk, slot] of Object.entries(slots)) {
    if (!slot) continue;
    const cur = slot.current;
    if (cur && baseName(cur.name) === NAME) {
      console.log(`  [current] ${sk} admit=${cur.admitDate || '-'} discharge=${cur.discharge || '-'} cid=${cur.consultationId || '-'}`);
    }
    (slot.reservations || []).forEach((r, i) => {
      if (r && baseName(r.name) === NAME) {
        console.log(`  [res#${i}]  ${sk} admit=${r.admitDate || '-'} discharge=${r.discharge || '-'} cid=${r.consultationId || '-'}`);
      }
    });
  }

  // 복구 대상: createdAt이 2026-01로 시작하는 상담 (Jan 5 상담)
  const jan = matched.filter(c => (c.createdAt || '').startsWith('2026-01'));
  console.log(`\n═ 복구 대상 (createdAt 2026-01): ${jan.length}건 ═`);
  if (jan.length === 0) {
    console.log('  (대상 없음)');
    process.exit(0);
  }

  const patch = {};
  const backupKey = `_backup_${new Date().toISOString().replace(/[:.]/g, '-')}/consultations`;
  for (const c of jan) {
    const target = {
      status: '입원완료',
      reservedSlot: null,
    };
    console.log(`  [${c.id}] 패치: status=입원완료, reservedSlot=null`);
    console.log(`    (기존: status="${c.status}" reservedSlot=${c.reservedSlot} admitDate=${c.admitDate} dischargeDate=${c.dischargeDate})`);
    console.log(`    ⚠ admitDate/dischargeDate 는 수동 확인 필요 — 스크립트가 자동 변경 안 함`);
    patch[`consultations/${c.id}/status`] = target.status;
    patch[`consultations/${c.id}/reservedSlot`] = target.reservedSlot;
    // 백업
    patch[`${backupKey}/${c.id}`] = { ...c };
    delete patch[`${backupKey}/${c.id}`].id;
  }

  if (!APPLY) {
    console.log('\n--dry-run 모드 — 실제 적용은 --apply 플래그 추가');
    process.exit(0);
  }
  await db.ref('/').update(patch);
  console.log(`\n✅ 복구 완료 (백업: ${backupKey})`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
