/**
 * P1 구현 시 부하 예측 — 실제 Firebase 데이터 사이즈·레코드 수 측정
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

function sizeOf(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

async function main() {
  console.log('📥 측정 중...\n');
  const t0 = Date.now();
  const [patSnap, byPhoneSnap, byChartSnap, conSnap] = await Promise.all([
    db.ref('patients').once('value'),
    db.ref('patientByPhone').once('value'),
    db.ref('patientByChartNo').once('value'),
    db.ref('consultations').once('value'),
  ]);
  const elapsed = Date.now() - t0;

  const pats = patSnap.val() || {};
  const byPhone = byPhoneSnap.val() || {};
  const byChart = byChartSnap.val() || {};
  const cons = conSnap.val() || {};

  const nPat     = Object.keys(pats).length;
  const nPhone   = Object.keys(byPhone).length;
  const nChart   = Object.keys(byChart).length;
  const nCon     = Object.keys(cons).length;

  const sPat    = sizeOf(pats);
  const sPhone  = sizeOf(byPhone);
  const sChart  = sizeOf(byChart);
  const sCon    = sizeOf(cons);

  const fmt = (b) => b < 1024 ? `${b}B`
                    : b < 1024*1024 ? `${(b/1024).toFixed(1)}KB`
                    : `${(b/1024/1024).toFixed(2)}MB`;

  console.log('─'.repeat(60));
  console.log('📊 Firebase 노드 실측');
  console.log('─'.repeat(60));
  console.log(`  patients              : ${nPat.toString().padStart(6)}건 / ${fmt(sPat).padStart(8)}`);
  console.log(`  patientByPhone        : ${nPhone.toString().padStart(6)}건 / ${fmt(sPhone).padStart(8)}`);
  console.log(`  patientByChartNo      : ${nChart.toString().padStart(6)}건 / ${fmt(sChart).padStart(8)}`);
  console.log(`  consultations         : ${nCon.toString().padStart(6)}건 / ${fmt(sCon).padStart(8)}`);
  console.log(`  4개 합계              : ${fmt(sPat+sPhone+sChart+sCon).padStart(20)}`);
  console.log(`  측정 elapsed (병렬)   : ${elapsed}ms`);

  // 개별 환자 레코드 샘플
  const sampleKey = Object.keys(pats)[0];
  if (sampleKey) {
    const sample = pats[sampleKey];
    console.log(`\n  환자 레코드 예시 (${sampleKey}): ${fmt(sizeOf(sample))}`);
    console.log(`  필드: ${Object.keys(sample || {}).join(', ')}`);
  }

  // ── P1 대안별 예상 부하 ─────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('💡 P1 대안별 cron(10분) sync 당 추가 부하');
  console.log('='.repeat(60));

  const CRON_PER_DAY = 12 * 6; // 8~20시, 매시 6번 = 72회
  const addPerRun = {
    'A. patients 전체 로드':        sPat,
    'B. by* 인덱스 2개만 로드':     sPhone + sChart,
    'C. by* + 매칭된 것만 개별 조회': sPhone + sChart + 100/*추정*/ * 500,
  };
  for (const [name, bytes] of Object.entries(addPerRun)) {
    const daily = bytes * CRON_PER_DAY;
    const monthly = daily * 30;
    console.log(`  ${name}`);
    console.log(`     +${fmt(bytes)} / run  → ${fmt(daily)} / day  → ${fmt(monthly)} / month`);
  }

  console.log('\n  현재 Phase 2.5 는 Firebase 에서 consultations 만 로드 (변동 없음).');
  console.log(`  consultations 이미 로드: ${fmt(sCon)} / run → ${fmt(sCon * CRON_PER_DAY * 30)} / month (baseline)`);

  // Firebase Blaze 요금 기준 (2026 기준 추정치)
  console.log('\n─ 참고: Firebase Realtime DB Blaze 요금 ─');
  console.log('  다운로드 무료한도: 10GB/월, 초과분 $1/GB');
  console.log('  저장소: 1GB 무료, 초과분 $5/GB/월');

  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
