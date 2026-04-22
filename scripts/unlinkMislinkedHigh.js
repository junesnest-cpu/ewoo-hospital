/**
 * HIGH 의심 2건 오연결 해제
 *   - import_0501 김은정 (2025-07-28 상담) : chart 0000006720 와 잘못 묶임
 *   - import_0616 윤정희 (2025-08-26 대장암 상담) : chart 0000006723 와 잘못 묶임
 *
 * 조치:
 *   - chartNo, patientId 제거
 *   - name 에 붙어있는 '4' 등 EMR suffix 원복 (김은정4 → 김은정)
 *   - isNewPatient = true (재매칭 시 신규로 취급)
 *   - status 는 '상담중' 복원 (이전에 잘못 '입원완료' 처리됨)
 *   - reservedSlot 는 null 유지 (auto-restore 차단)
 *
 * 상담 기록 내용(메모·전화·생년 등) 은 보존 → 추후 정확한 환자 재등록 시 수동 재매칭 가능.
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

const TARGETS = [
  { id: 'import_0501', baseName: '김은정', badChart: '0000006720' },
  { id: 'import_0616', baseName: '윤정희', badChart: '0000006723' },
];

(async () => {
  for (const t of TARGETS) {
    const ref = db.ref(`consultations/${t.id}`);
    const snap = await ref.once('value');
    const c = snap.val();
    if (!c) { console.log(`⚠ ${t.id} 없음`); continue; }
    if (c.chartNo !== t.badChart) {
      console.log(`⚠ ${t.id} chartNo=${c.chartNo} (예상=${t.badChart}) — 이미 다른 값. 스킵`);
      continue;
    }
    const updates = {
      chartNo:      null,
      patientId:    null,
      isNewPatient: true,
      status:       '상담중',
      reservedSlot: null,
    };
    if (c.name && c.name !== t.baseName) {
      updates.name = t.baseName;
    }
    console.log(`\n→ ${t.id} 정리 (${c.name || ''} → ${t.baseName})`);
    console.log(`   before: chart=${c.chartNo} pid=${c.patientId} status=${c.status} name=${c.name}`);
    console.log(`   after:  chart=null pid=null status=상담중 name=${updates.name || c.name}`);
    await ref.update(updates);
    console.log(`   ✅ 완료`);
  }
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
