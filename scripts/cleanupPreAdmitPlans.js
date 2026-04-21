/**
 * treatmentPlansV2 에서 admissionKey 이전 날짜 항목 정리
 *
 * 배경: 2026-04-21 patient-keyed 마이그레이션 시 기존 slotKey 경로의 전체 월별 데이터를
 *       현재 입원환자의 admissionKey 아래로 그대로 복사함. 이로 인해 입원일 이전
 *       날짜에 이전 점유자의 잔존 치료 항목이 섞여 있음.
 *
 * 예: 조은주3(202호 입원 4/21) 의 treatmentPlansV2/{pid}/2026-04-21/2026-04/19,20 에
 *     4/21 이전 점유자의 치료 항목이 남아 UI·금액 계산에 영향.
 *
 * 실행:
 *   node scripts/cleanupPreAdmitPlans.js            # dry-run (기본)
 *   node scripts/cleanupPreAdmitPlans.js --apply    # 실제 삭제
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

function parseAdmissionKey(aKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(aKey);
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}

function parseEntryDate(monthKey, dayStr) {
  const mm = /^(\d{4})-(\d{2})$/.exec(monthKey);
  const d = parseInt(dayStr);
  if (!mm || !d) return null;
  return new Date(parseInt(mm[1]), parseInt(mm[2]) - 1, d);
}

async function main() {
  console.log('🔍 treatmentPlansV2 로드 중...');
  const plansSnap = await db.ref('treatmentPlansV2').once('value');
  const plans = plansSnap.val() || {};

  const toDelete = [];
  let totalEntries = 0;
  const affectedPatients = new Set();

  for (const [pid, byAdmission] of Object.entries(plans)) {
    for (const [aKey, byMonth] of Object.entries(byAdmission || {})) {
      const admitDate = parseAdmissionKey(aKey);
      if (!admitDate) continue;

      for (const [monthKey, byDay] of Object.entries(byMonth || {})) {
        for (const [dayStr, items] of Object.entries(byDay || {})) {
          const entryDate = parseEntryDate(monthKey, dayStr);
          if (!entryDate) continue;
          totalEntries++;

          if (entryDate < admitDate) {
            const itemCount = Array.isArray(items)
              ? items.length
              : (items && typeof items === 'object' ? Object.keys(items).length : 0);
            toDelete.push({
              path: `treatmentPlansV2/${pid}/${aKey}/${monthKey}/${dayStr}`,
              pid, aKey, monthKey, dayStr,
              entryYMD: `${monthKey}-${String(dayStr).padStart(2, '0')}`,
              itemCount,
            });
            affectedPatients.add(pid);
          }
        }
      }
    }
  }

  const totalItems = toDelete.reduce((s, d) => s + d.itemCount, 0);

  console.log('\n' + '═'.repeat(60));
  console.log('📋 정리 대상 분석');
  console.log('═'.repeat(60));
  console.log(`  총 날짜 항목 스캔:      ${totalEntries}건`);
  console.log(`  입원일 이전 날짜:       ${toDelete.length}건`);
  console.log(`  → 포함된 치료 항목:     ${totalItems}건`);
  console.log(`  → 영향받는 환자 수:     ${affectedPatients.size}명`);

  // 샘플 10건 출력
  if (toDelete.length > 0) {
    console.log('\n📌 삭제 대상 샘플 (최대 15건):');
    toDelete.slice(0, 15).forEach(d => {
      console.log(`  ${d.pid.slice(0, 10)}… aKey=${d.aKey} · ${d.entryYMD} (${d.itemCount}건)`);
    });
    if (toDelete.length > 15) {
      console.log(`  … 외 ${toDelete.length - 15}건`);
    }
  }

  if (!APPLY) {
    console.log('\n🟢 DRY RUN — 변경사항 없음. --apply 로 실제 삭제.');
    process.exit(0);
  }

  if (toDelete.length === 0) {
    console.log('\n✅ 정리할 항목 없음.');
    process.exit(0);
  }

  console.log('\n🔴 APPLY 모드 — 삭제 시작...');

  // Firebase 한 번에 multi-path update (null = 삭제)
  // 500건씩 배치
  const BATCH = 500;
  let written = 0;
  for (let i = 0; i < toDelete.length; i += BATCH) {
    const chunk = toDelete.slice(i, i + BATCH);
    const updates = {};
    for (const d of chunk) updates[d.path] = null;
    await db.ref('/').update(updates);
    written += chunk.length;
    console.log(`  ✍️  ${written}/${toDelete.length} 삭제`);
  }

  // 리포트 저장
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await db.ref(`migrationReports/preAdmitCleanup_${ts}`).set({
    timestamp: new Date().toISOString(),
    totalEntriesScanned: totalEntries,
    deletedDates: toDelete.length,
    deletedItems: totalItems,
    affectedPatients: affectedPatients.size,
  });

  console.log(`\n📝 리포트: migrationReports/preAdmitCleanup_${ts}`);
  console.log('\n✅ 정리 완료.');
  process.exit(0);
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
