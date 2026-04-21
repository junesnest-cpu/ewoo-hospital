/**
 * 치료계획 스키마 마이그레이션 — slotKey → patientId + admissionKey
 * ============================================================================
 * 2026-04-21 원샷 컷오버용 스크립트.
 *
 * 사용:
 *   node scripts/migratePlansToPatient.js --dry     # 드라이런 (기본, 쓰기 없음)
 *   node scripts/migratePlansToPatient.js --apply   # 실제 쓰기
 *   node scripts/migratePlansToPatient.js --apply --backup-ts=2026-04-21_1800
 *
 * 원본 경로는 건드리지 않음. 신 경로(treatmentPlansV2, weeklyPlansV2,
 * admissionPlansV2)에 사본 작성. 필요 시 --backup-ts로 루트에 스냅샷 백업.
 *
 * 매핑 전략:
 *   slots/{slotKey}/current.patientId + current.admitDate 가 모두 있는 경우만 매핑.
 *   patientId 없으면 patientByChartNo 인덱스로 보완.
 *   둘 중 하나라도 없으면 _orphan 리포트에 기록 (읽기/쓰기 계속 가능).
 * ============================================================================
 */
require('dotenv').config({ path: '.env.local' });
const admin = require('firebase-admin');

const argv = process.argv.slice(2);
const APPLY      = argv.includes('--apply');
const DRY        = !APPLY;
const BACKUP_TS  = (argv.find(a => a.startsWith('--backup-ts=')) || '').split('=')[1] || null;

const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
if (!privateKey || !process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL) {
  console.error('❌ .env.local 필요: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  }),
  databaseURL: 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
});
const db = admin.database();

// admissionKey: admitDate를 YYYY-MM-DD로 정규화
function admissionKey(admitDate) {
  if (!admitDate) return null;
  const s = String(admitDate).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const md = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (md) {
    const y = new Date().getFullYear();
    return `${y}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
  }
  return null;
}

function normalizeChartNo(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  return d.padStart(10, '0');
}

(async () => {
  console.log('━'.repeat(70));
  console.log(`🔄 치료계획 마이그레이션 — slotKey → patientId+admissionKey`);
  console.log(`   모드: ${APPLY ? '🔴 APPLY (실제 쓰기)' : '🟢 DRY RUN (쓰기 없음)'}`);
  if (BACKUP_TS) console.log(`   백업 타임스탬프: _backup_${BACKUP_TS}`);
  console.log('━'.repeat(70));

  const [slotsSnap, tpSnap, wpSnap, apSnap, chartIdxSnap] = await Promise.all([
    db.ref('slots').once('value'),
    db.ref('treatmentPlans').once('value'),
    db.ref('weeklyPlans').once('value'),
    db.ref('admissionPlans').once('value'),
    db.ref('patientByChartNo').once('value'),
  ]);
  const slots     = slotsSnap.val()    || {};
  const tp        = tpSnap.val()       || {};
  const wp        = wpSnap.val()       || {};
  const ap        = apSnap.val()       || {};
  const chartIdx  = chartIdxSnap.val() || {};

  console.log(`📊 현재 데이터:`);
  console.log(`   slots: ${Object.keys(slots).length}`);
  console.log(`   treatmentPlans slotKeys: ${Object.keys(tp).length}`);
  console.log(`   weeklyPlans slotKeys: ${Object.keys(wp).length}`);
  console.log(`   admissionPlans slotKeys: ${Object.keys(ap).length}`);

  const report = { migrated: [], orphaned: [], conflicts: [] };
  const updates = {};
  const seenKeys = {}; // 이미 대상 경로에 쓴 게 있으면 충돌 체크

  // 1) 현재 입원환자 기준 매핑
  for (const [slotKey, slot] of Object.entries(slots)) {
    const cur = slot?.current;
    if (!cur?.name) continue; // 빈 병상

    let pid  = cur.patientId || null;
    if (!pid && cur.chartNo) {
      const norm = normalizeChartNo(cur.chartNo);
      if (norm && chartIdx[norm]) pid = chartIdx[norm];
    }

    const aKey = admissionKey(cur.admitDate);

    // plan 데이터 유무 확인
    const hasTp = !!tp[slotKey];
    const hasWp = !!wp[slotKey];
    const hasAp = !!ap[slotKey];
    if (!hasTp && !hasWp && !hasAp) continue; // 복사할 것 없음

    if (!pid || !aKey) {
      report.orphaned.push({
        slotKey,
        name:    cur.name,
        chartNo: cur.chartNo || null,
        reason:  !pid ? 'no-patientId' : 'no-admitDate',
        counts:  { tp: hasTp, wp: hasWp, ap: hasAp },
      });
      continue;
    }

    const targetBase = `${pid}/${aKey}`;
    // 같은 patient+admission에 다른 slotKey 데이터가 이미 쓰인 경우 충돌
    if (seenKeys[targetBase]) {
      report.conflicts.push({
        slotKey,
        name: cur.name,
        previous: seenKeys[targetBase],
        target: targetBase,
      });
      continue;
    }
    seenKeys[targetBase] = slotKey;

    if (hasTp) updates[`treatmentPlansV2/${pid}/${aKey}`]  = tp[slotKey];
    if (hasWp) updates[`weeklyPlansV2/${pid}/${aKey}`]     = wp[slotKey];
    if (hasAp) updates[`admissionPlansV2/${pid}/${aKey}`]  = ap[slotKey];

    report.migrated.push({
      slotKey, name: cur.name, pid, aKey,
      tp: hasTp, wp: hasWp, ap: hasAp,
    });
  }

  // 2) 백업 스냅샷 (옵션)
  if (BACKUP_TS) {
    updates[`_backup_${BACKUP_TS}/treatmentPlans`] = tp;
    updates[`_backup_${BACKUP_TS}/weeklyPlans`]    = wp;
    updates[`_backup_${BACKUP_TS}/admissionPlans`] = ap;
  }

  // 3) 리포트 출력
  console.log('\n━'.repeat(70));
  console.log(`📋 결과 리포트`);
  console.log('━'.repeat(70));
  console.log(`  ✅ 매핑 성공: ${report.migrated.length}건`);
  console.log(`  ⚠️  orphan   : ${report.orphaned.length}건 (patientId 또는 admitDate 없음)`);
  console.log(`  ❌ 충돌     : ${report.conflicts.length}건 (동일 patient+admission에 복수 slot)`);

  if (report.orphaned.length > 0) {
    console.log('\n  Orphan 상세:');
    report.orphaned.forEach(o => {
      console.log(`    - ${o.slotKey} ${o.name} (${o.reason}) chartNo=${o.chartNo||'-'} data=${JSON.stringify(o.counts)}`);
    });
  }
  if (report.conflicts.length > 0) {
    console.log('\n  충돌 상세:');
    report.conflicts.forEach(c => {
      console.log(`    - ${c.slotKey} ${c.name} → ${c.target} (이미 ${c.previous}에서 씀)`);
    });
  }

  const total = report.migrated.length + report.orphaned.length + report.conflicts.length;
  const rate  = total ? (report.migrated.length / total * 100).toFixed(1) : '100.0';
  console.log(`\n  📈 매핑률: ${rate}% (${report.migrated.length}/${total})`);

  // 4) 적용
  if (DRY) {
    console.log('\n🟢 DRY RUN — 변경사항 없음. --apply 로 실제 실행.');
    process.exit(0);
  }

  console.log('\n🔴 APPLY 모드 — 쓰기 시작...');
  // 큰 update는 분할 (Firebase 경로당 쓰기 제한 대비)
  const entries = Object.entries(updates);
  const BATCH = 500;
  for (let i = 0; i < entries.length; i += BATCH) {
    const chunk = Object.fromEntries(entries.slice(i, i + BATCH));
    await db.ref('/').update(chunk);
    console.log(`  ✍️  ${Math.min(i + BATCH, entries.length)}/${entries.length} 쓰기 완료`);
  }

  // 5) 리포트를 DB에도 저장 (감사용)
  const reportPath = `migrationReports/plans_${BACKUP_TS || Date.now()}`;
  await db.ref(reportPath).set({
    ts: new Date().toISOString(),
    migrated: report.migrated.length,
    orphaned: report.orphaned,
    conflicts: report.conflicts,
  });
  console.log(`\n📝 리포트 저장: ${reportPath}`);

  console.log('\n✅ 마이그레이션 완료.');
  process.exit(0);
})().catch(e => {
  console.error('❌ 실패:', e);
  process.exit(1);
});
