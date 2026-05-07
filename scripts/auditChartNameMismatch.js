/**
 * chartNo 가 부여된 consultations 중 baseName 이 환자마스터와 다른 의심 연결 검출
 *
 * 배경 (2026-05-07 정수현↔박명순4 사건):
 *   syncEMR Phase 2.5 가 phone 일치만으로 baseName 검증 없이 매칭하던 시기에
 *   chartNo·patientId·name 이 통째로 다른 환자 정보로 덮어써진 케이스 발견.
 *   본 audit 는 동일 패턴이 다른 환자에서 잔존하는지 정기 점검.
 *
 * 검출 조건:
 *   c.chartNo 가 있고 patients/{c.chartNo}.name 이 존재하며
 *   baseName(c.name) ≠ baseName(patients[c.chartNo].name) 인 consultation.
 *
 * 출력: 의심 건수, 각 건의 con vs pat 비교, severity (high if 2+ mismatch).
 *
 * 자동 수정 안 함 — 점검 후 수동 repair 또는 syncEMR Phase 2.5 baseName 가드의
 * suspect 자동 unlink 로 자가 치유.
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

const baseName = (n) => (n || '').replace(/^신\)\s*/, '').replace(/\d+$/, '').replace(/\s/g, '').trim();
const digitsOnly = (s) => String(s || '').replace(/\D/g, '');

(async () => {
  const [conSnap, patSnap] = await Promise.all([
    db.ref('consultations').once('value'),
    db.ref('patients').once('value'),
  ]);
  const cons = conSnap.val() || {};
  const pats = patSnap.val() || {};

  const mismatches = [];
  for (const [conId, c] of Object.entries(cons)) {
    if (!c?.chartNo || !c.name) continue;
    if (c.status === '취소') continue;
    const pat = pats[c.chartNo];
    if (!pat?.name) continue; // chartNo 가 patients 에 없으면 별개 issue
    const cBase = baseName(c.name);
    const pBase = baseName(pat.name);
    if (!cBase || !pBase) continue;
    if (cBase === pBase) continue;

    // 추가 신호: phone / birthYear 도 다른지 확인 → severity
    const conPhones = [digitsOnly(c.phone), digitsOnly(c.phone2)].filter(p => p.length >= 10);
    const patPhone = digitsOnly(pat.phone);
    const phoneMismatch = patPhone && conPhones.length > 0 && !conPhones.includes(patPhone);
    const conYear = c.birthYear || (c.birthDate || '').slice(0, 4);
    const patYear = (pat.birthDate || '').slice(0, 4);
    const yearMismatch = conYear && patYear && conYear !== patYear;

    let severity = 'medium';
    if (phoneMismatch && yearMismatch) severity = 'high';
    else if (phoneMismatch || yearMismatch) severity = 'high'; // baseName 다른 시점에서 이미 강한 신호

    mismatches.push({
      conId,
      conName: c.name,
      patName: pat.name,
      chartNo: c.chartNo,
      severity,
      phoneMismatch,
      yearMismatch,
      conPhone: c.phone || c.phone2 || '-',
      patPhone: pat.phone || '-',
      conYear: conYear || '-',
      patYear: patYear || '-',
      createdAt: c.createdAt || '-',
      status: c.status || '-',
      reservedSlot: c.reservedSlot || '-',
      patientId: c.patientId || '-',
    });
  }

  console.log(`═════ chartNo↔name baseName mismatch 의심 매칭 ═════`);
  console.log(`  총 ${mismatches.length}건 (high=${mismatches.filter(m => m.severity === 'high').length}, medium=${mismatches.filter(m => m.severity === 'medium').length})`);
  if (mismatches.length === 0) {
    console.log(`\n✅ 의심 매칭 없음.`);
    process.exit(0);
  }

  // severity 우선, conId 보조 정렬
  mismatches.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    return a.conId.localeCompare(b.conId);
  });

  for (const m of mismatches) {
    console.log(`\n  [${m.severity}]  ${m.conId}`);
    console.log(`     con.name="${m.conName}"  vs  pat.name="${m.patName}"  (chartNo=${m.chartNo}, patientId=${m.patientId})`);
    console.log(`     phone con=${m.conPhone}  pat=${m.patPhone}${m.phoneMismatch ? '  ⚠ 다름' : ''}`);
    console.log(`     year  con=${m.conYear}   pat=${m.patYear}${m.yearMismatch ? '  ⚠ 다름' : ''}`);
    console.log(`     status=${m.status}  reservedSlot=${m.reservedSlot}  createdAt=${m.createdAt}`);
  }

  console.log(`\n조치 권장:`);
  console.log(`  1) syncEMR.js Phase 2.5 의 baseName 가드가 다음 sync 사이클에 자동 unlink — 1~2 회 cron 후 재점검`);
  console.log(`  2) 자동 unlink 후에도 의심 매칭이 잔존하면 수동 repair: 각 건마다 inspect/repair 스크립트 작성`);
  console.log(`  3) chartNo 가 정확하다면 c.name 정정 (사용자가 동명이인 disambiguator 누락 입력 시)`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
