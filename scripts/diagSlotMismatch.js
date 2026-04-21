/**
 * slots 현재 입원(current) vs 마이그레이션 기준 51명 비교 진단
 *
 * 병실현황에 표시되는 환자와 EMR 입원 환자 수가 맞지 않을 때 원인 파악용.
 * - patientId 또는 admitDate 누락된 "불완전" current
 * - EMR 동기화 없이 수기 입력된 경우
 * - 퇴원 처리 누락으로 남아있는 경우
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

async function main() {
  console.log('🔍 slots + patients 로드 중...\n');
  const [slotsSnap, patientsSnap] = await Promise.all([
    db.ref('slots').once('value'),
    db.ref('patients').once('value'),
  ]);
  const slots = slotsSnap.val() || {};
  const patients = patientsSnap.val() || {};

  const withCurrent = [];
  const withPatientIdAndAdmit = [];
  const noPatientId = [];
  const noAdmitDate = [];
  const patientIdNotInMaster = [];
  const names = new Map(); // name → [slotKey]

  for (const [slotKey, slot] of Object.entries(slots)) {
    const cur = slot?.current;
    if (!cur?.name) continue;

    withCurrent.push({
      slotKey,
      name: cur.name,
      patientId: cur.patientId || null,
      admitDate: cur.admitDate || null,
      chartNo: cur.chartNo || null,
      discharge: cur.discharge || null,
    });

    const nn = (cur.name || '').replace(/^신\)\s*/, '').trim();
    if (!names.has(nn)) names.set(nn, []);
    names.get(nn).push(slotKey);

    if (!cur.patientId) noPatientId.push({ slotKey, name: cur.name });
    if (!cur.admitDate) noAdmitDate.push({ slotKey, name: cur.name });
    if (cur.patientId && cur.admitDate) {
      withPatientIdAndAdmit.push({ slotKey, name: cur.name, patientId: cur.patientId, admitDate: cur.admitDate });
      // patients 마스터에 실제로 존재하는지
      const allPids = new Set();
      for (const p of Object.values(patients)) {
        if (p?.internalId) allPids.add(p.internalId);
      }
      if (!allPids.has(cur.patientId)) {
        patientIdNotInMaster.push({ slotKey, name: cur.name, patientId: cur.patientId });
      }
    }
  }

  console.log('═'.repeat(64));
  console.log('📊 slots.current 집계');
  console.log('═'.repeat(64));
  console.log(`  현재 환자가 있는 슬롯:              ${withCurrent.length}개`);
  console.log(`  patientId + admitDate 모두 있음:    ${withPatientIdAndAdmit.length}개`);
  console.log(`  patientId 없음:                     ${noPatientId.length}개`);
  console.log(`  admitDate 없음:                     ${noAdmitDate.length}개`);
  console.log(`  patientId가 patients 마스터에 없음: ${patientIdNotInMaster.length}개`);

  // 같은 이름이 여러 슬롯에 있는 경우 (중복/이동 누락)
  const dupNames = [...names.entries()].filter(([, ks]) => ks.length > 1);
  console.log(`  같은 이름 중복 슬롯:                ${dupNames.length}건`);

  if (noPatientId.length > 0) {
    console.log('\n⚠ patientId 없는 current (환자-키 스키마에서 V2 저장 불가):');
    noPatientId.forEach(r => console.log(`  ${r.slotKey} · ${r.name}`));
  }

  if (noAdmitDate.length > 0) {
    console.log('\n⚠ admitDate 없는 current:');
    noAdmitDate.forEach(r => console.log(`  ${r.slotKey} · ${r.name}`));
  }

  if (patientIdNotInMaster.length > 0) {
    console.log('\n⚠ patientId가 patients 마스터에 없음 (유령 ID):');
    patientIdNotInMaster.forEach(r => console.log(`  ${r.slotKey} · ${r.name} (pid=${r.patientId})`));
  }

  if (dupNames.length > 0) {
    console.log('\n⚠ 같은 이름 중복:');
    dupNames.forEach(([n, ks]) => console.log(`  ${n} → ${ks.join(', ')}`));
  }

  console.log('\n═'.repeat(64));
  console.log('📋 전체 current 환자 목록 (슬롯순)');
  console.log('═'.repeat(64));
  withCurrent.sort((a, b) => a.slotKey.localeCompare(b.slotKey));
  withCurrent.forEach((r, i) => {
    const flags = [];
    if (!r.patientId) flags.push('NO_PID');
    if (!r.admitDate) flags.push('NO_ADMIT');
    const flagStr = flags.length ? ` [${flags.join(',')}]` : '';
    console.log(`  ${String(i+1).padStart(2)} ${r.slotKey.padEnd(8)} ${r.name.padEnd(10)} admit=${r.admitDate || '-'} pid=${r.patientId || '-'}${flagStr}`);
  });

  process.exit(0);
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
