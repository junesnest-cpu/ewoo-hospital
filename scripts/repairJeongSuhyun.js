/**
 * 정수현 상담 (-OqBEQTFHwpKsAE7RKxS) 박명순4 오연결 복원 (2026-05-07)
 *
 * 증상: 4/14 홈페이지 inquiry 로 만든 정수현 상담의 chartNo·patientId·name 이
 *       박명순4 (chartNo=0000007092, internalId=P08175) 의 정보로 덮어써짐.
 *       phone/birthYear/diagnosis 등 본래 정수현 데이터는 보존됨.
 *
 * 원인: syncEMR.js Phase 2.5 phone 매칭 (line 1278-1283) 이 baseName 검증 없이
 *       phone 일치만으로 환자마스터 매칭. 어느 시점에 정수현 상담 phone 이
 *       박명순4 phone (010-9194-0053) 로 잘못 입력된 사이클이 있었던 것으로 추정.
 *       매칭 결과 line 1301 의 `updates.name = matched.name` 으로 이름까지 덮어씀.
 *
 * 조치:
 *   1) name: 박명순4 → 정수현
 *   2) chartNo: 0000007092 → 제거 (정수현의 EMR 차트번호 미정)
 *   3) patientId: P08175 → 제거
 *   4) isNewPatient: false → true (신규 환자로 복원)
 *   5) reservedSlot: 204-1 → 304-1 (실제 reservation 위치)
 *
 * 원본 백업: _backup_repairJeongSuhyun_<ts>/<id>
 *
 *   --apply 가 없으면 dry-run.
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
const TARGET_ID = '-OqBEQTFHwpKsAE7RKxS';
const RESTORED_NAME = '정수현';
const CORRECT_RESERVED_SLOT = '304-1';

(async () => {
  const snap = await db.ref(`consultations/${TARGET_ID}`).once('value');
  const c = snap.val();
  if (!c) {
    console.error(`❌ consultations/${TARGET_ID} 가 없습니다`);
    process.exit(1);
  }

  console.log('현재 상태:');
  console.log(`  name="${c.name}"  status="${c.status}"  isNewPatient=${c.isNewPatient}`);
  console.log(`  chartNo=${c.chartNo || '-'}  patientId=${c.patientId || '-'}`);
  console.log(`  phone=${c.phone || '-'}  phone2=${c.phone2 || '-'}`);
  console.log(`  birthYear=${c.birthYear || '-'}  diagnosis=${c.diagnosis || '-'}`);
  console.log(`  reservedSlot=${c.reservedSlot || '-'}  admitDate=${c.admitDate || '-'}`);

  // 304-1 reservation 의 cid 매칭 확인 — 정상 연결 보존
  const slotSnap = await db.ref(`slots/${CORRECT_RESERVED_SLOT}`).once('value');
  const slot = slotSnap.val() || {};
  const reserv = (slot.reservations || []).find(r => r?.consultationId === TARGET_ID);
  if (!reserv) {
    console.warn(`⚠ slots/${CORRECT_RESERVED_SLOT}/reservations 에 cid=${TARGET_ID} 인 entry 가 없습니다.`);
    console.warn(`   reservedSlot 정정을 보류하거나 수동 확인 필요.`);
  } else {
    console.log(`✓ slots/${CORRECT_RESERVED_SLOT} 에 정수현 reservation 존재 (cid 일치)`);
  }

  // 변경 계획
  const updates = {
    name:          RESTORED_NAME,
    chartNo:       null,
    patientId:     null,
    isNewPatient:  true,
    reservedSlot:  reserv ? CORRECT_RESERVED_SLOT : c.reservedSlot,
  };

  console.log('\n적용 예정:');
  for (const [k, v] of Object.entries(updates)) {
    console.log(`  ${k}: ${JSON.stringify(c[k] ?? null)} → ${JSON.stringify(v)}`);
  }

  if (!APPLY) {
    console.log('\n[dry-run] --apply 없이 실행 — 변경 안 함.');
    process.exit(0);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `_backup_repairJeongSuhyun_${ts}/${TARGET_ID}`;
  await db.ref(backupPath).set(c);
  console.log(`\n백업: ${backupPath}`);

  // patientByChartNo / patientByPhone 인덱스는 박명순4 본인 것이므로 건드리지 않음
  // (정수현의 chartNo·patientId·phone 는 어차피 인덱스에 등록 안 되어 있음)
  await db.ref(`consultations/${TARGET_ID}`).update({
    name:          updates.name,
    chartNo:       updates.chartNo,
    patientId:     updates.patientId,
    isNewPatient:  updates.isNewPatient,
    reservedSlot:  updates.reservedSlot,
    updatedAt:     new Date().toISOString().slice(0, 10),
  });
  console.log('적용 완료.');

  const after = (await db.ref(`consultations/${TARGET_ID}`).once('value')).val();
  console.log('\n확인:');
  console.log(`  name="${after.name}"  isNewPatient=${after.isNewPatient}`);
  console.log(`  chartNo=${after.chartNo || '-'}  patientId=${after.patientId || '-'}`);
  console.log(`  reservedSlot=${after.reservedSlot}`);

  // 의심 매칭 기록도 정리 (이미 fix 됐으니 의심 아님)
  const suspSnap = await db.ref(`emrSyncLog/consultationLinking/suspects/${TARGET_ID}`).once('value');
  if (suspSnap.exists()) {
    await db.ref(`emrSyncLog/consultationLinking/suspects/${TARGET_ID}`).remove();
    console.log(`\n  emrSyncLog/consultationLinking/suspects/${TARGET_ID} 제거`);
  }
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
