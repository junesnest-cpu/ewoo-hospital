/**
 * emrSyncLog/consultationLinking/suspects 읽어 사람이 읽기 쉽게 출력
 * 사용법: node scripts/viewConsultSuspects.js [high|medium|all]
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

(async () => {
  const filter = (process.argv[2] || 'all').toLowerCase();
  const [logSnap, susSnap] = await Promise.all([
    db.ref('emrSyncLog/consultationLinking').once('value'),
    db.ref('emrSyncLog/consultationLinking/suspects').once('value'),
  ]);
  const log = logSnap.val() || {};
  const susRaw = susSnap.val() || {};

  console.log('═'.repeat(64));
  console.log('📊 consultationLinking 최근 통계');
  console.log('═'.repeat(64));
  console.log(`  ts:           ${log.ts || '-'}`);
  console.log(`  mode:         ${log.mode || '-'}`);
  console.log(`  total:        ${log.total || 0}건`);
  console.log(`  fixed:        ${log.fixed || 0}건 (신규 매칭)`);
  console.log(`  byChart/Phone/BD/BY: ${log.byChart||0}/${log.byPhone||0}/${log.byBirthDate||0}/${log.byBirthYear||0}`);
  console.log(`  noMatch:      ${log.noMatch || 0}건`);
  console.log(`  suspectCount: ${log.suspectCount || 0}건`);
  console.log(`  masterSize:   ${log.masterSize || '-'}명 · cache=${log.cacheStatus || '-'}`);

  const entries = Object.entries(susRaw).filter(([, s]) => {
    if (filter === 'all') return true;
    return s?.severity === filter;
  });
  if (entries.length === 0) {
    console.log(`\n✅ ${filter === 'all' ? '전체' : filter} 의심 연결: 0건`);
    process.exit(0);
  }

  console.log(`\n═`.repeat(64));
  console.log(`⚠ 의심 연결 (${filter}): ${entries.length}건`);
  console.log('═'.repeat(64));

  // severity → 필드개수순 정렬
  entries.sort(([, a], [, b]) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    return Object.keys(b.issues || {}).length - Object.keys(a.issues || {}).length;
  });

  entries.forEach(([cid, s], i) => {
    console.log(`\n${i+1}. [${s.severity.toUpperCase()}] ${cid}  chart=${s.chartNo}`);
    console.log(`   상담일지: "${s.conName}"  ↔  EMR 환자마스터: "${s.patName}"`);
    for (const [field, diff] of Object.entries(s.issues || {})) {
      const conV = diff.con == null ? '(없음)' : diff.con;
      const patV = diff.pat == null ? '(없음)' : diff.pat;
      console.log(`     · ${field.padEnd(10)} con="${conV}"  pat="${patV}"`);
    }
  });

  console.log(`\n💡 조치 가이드:`);
  console.log(`  - phone 만 다름      : 환자 번호 변경 가능성. 상담일지의 phone 을 patient 기준으로 갱신 또는 무시`);
  console.log(`  - birthDate 다름      : 입력 오류 확인. 정확한 DB 가 어느 쪽인지 확인 후 보정`);
  console.log(`  - baseName 다름 (HIGH) : 같은 chartNo 에 다른 환자 연결. chartNo 를 비우고 재매칭 필요`);

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
