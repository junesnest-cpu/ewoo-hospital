/**
 * 정수현 ↔ 박명순4 데이터 혼선 진단 (2026-05-07)
 *   증상: 4/14 홈페이지 상담 → 5/7 입원한 정수현 의 정보가
 *         상담일지·환자목록에서 모두 박명순4 로 표시됨.
 *
 * 가설:
 *   1) Phase 2.5 (syncEMR.js line 1301) 의 consultation.name 덮어쓰기 —
 *      phone/birthDate/birthYear 매칭이 박명순4 환자마스터로 잘못 매핑되어
 *      정수현 상담의 name 필드가 통째로 박명순4 로 변경됨.
 *   2) Phase 1 phoneMap 중복배제 (line 528-538) — 같은 phone 의
 *      두 chartNo 중 정수현이 skipSet 에 들어가 patients/{} 미작성.
 *
 * 점검 대상:
 *   - consultations: baseName(정수현|박명순) 모두 덤프 + suspect 표시
 *   - patients: baseName(정수현|박명순) 모두 덤프
 *   - patientByChartNo / patientByPhone: 두 사람 chartNo·phone 인덱스 상태
 *   - slots: 두 사람 current/reservations 점유 상태
 *   - emrSyncLog/consultationLinking/suspects: 자동 sync 가 의심한 건들
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
const TARGETS = ['정수현', '박명순'];

(async () => {
  const [conSnap, patSnap, byChartSnap, byPhoneSnap, slotSnap, suspSnap] = await Promise.all([
    db.ref('consultations').once('value'),
    db.ref('patients').once('value'),
    db.ref('patientByChartNo').once('value'),
    db.ref('patientByPhone').once('value'),
    db.ref('slots').once('value'),
    db.ref('emrSyncLog/consultationLinking/suspects').once('value'),
  ]);
  const cons = conSnap.val() || {};
  const pats = patSnap.val() || {};
  const byChart = byChartSnap.val() || {};
  const byPhone = byPhoneSnap.val() || {};
  const slots = slotSnap.val() || {};
  const susps = suspSnap.val() || {};

  console.log('═════ consultations 중 baseName ∈ {정수현, 박명순} ═════');
  const conMatched = [];
  for (const [id, c] of Object.entries(cons)) {
    if (!c) continue;
    if (!TARGETS.includes(baseName(c.name))) continue;
    conMatched.push({ id, ...c });
  }
  conMatched.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  conMatched.forEach(c => {
    const flag = baseName(c.name) === '박명순'
      && (c.createdAt || '').startsWith('2026-04')
      && (digitsOnly(c.phone).length >= 10) ? '  ⚠ 4월 created + 박명순 = 정수현 후보?' : '';
    console.log(`  ${c.id}${flag}`);
    console.log(`     name="${c.name}"  status="${c.status || '-'}"  isNewPatient=${c.isNewPatient}`);
    console.log(`     createdAt=${c.createdAt || '-'}  updatedAt=${c.updatedAt || '-'}`);
    console.log(`     admitDate=${c.admitDate || '-'}  dischargeDate=${c.dischargeDate || '-'}  reservedSlot=${c.reservedSlot || '-'}`);
    console.log(`     phone=${c.phone || '-'}  phone2=${c.phone2 || '-'}`);
    console.log(`     birthYear=${c.birthYear || '-'}  birthDate=${c.birthDate || '-'}  gender=${c.gender || '-'}`);
    console.log(`     chartNo=${c.chartNo || '-'}  patientId=${c.patientId || '-'}`);
    console.log(`     diagnosis=${c.diagnosis || '-'}  hospital=${c.hospital || '-'}`);
    console.log(`     source=${c.source || '-'}  origin=${c.origin || '-'}  channel=${c.channel || '-'}`);
  });

  console.log('\n═════ patients 중 baseName ∈ {정수현, 박명순} ═════');
  for (const [k, p] of Object.entries(pats)) {
    if (!p?.name) continue;
    if (!TARGETS.includes(baseName(p.name))) continue;
    console.log(`  patients/${k}`);
    console.log(`     name="${p.name}"  internalId=${p.internalId || '-'}  chartNo=${p.chartNo || '-'}`);
    console.log(`     phone=${p.phone || '-'}  birthDate=${p.birthDate || '-'}  gender=${p.gender || '-'}`);
    console.log(`     diagCode=${p.diagCode || '-'}  diagName=${p.diagName || '-'}`);
    console.log(`     currentAdmitDate=${p.currentAdmitDate || '-'}  syncedAt=${p.syncedAt || '-'}`);
  }

  console.log('\n═════ patientByPhone 인덱스 — 정수현/박명순 phone 후보 ═════');
  // 후보 phone 수집: 위에서 찾은 consultations/patients 의 phone 모두
  const phoneCands = new Set();
  for (const c of conMatched) {
    const p1 = digitsOnly(c.phone), p2 = digitsOnly(c.phone2);
    if (p1.length >= 10) phoneCands.add(p1);
    if (p2.length >= 10) phoneCands.add(p2);
  }
  for (const p of Object.values(pats)) {
    if (!p?.name) continue;
    if (!TARGETS.includes(baseName(p.name))) continue;
    const d = digitsOnly(p.phone);
    if (d.length >= 10) phoneCands.add(d);
  }
  for (const ph of phoneCands) {
    const iid = byPhone[ph];
    if (!iid) {
      console.log(`  ${ph} → (인덱스 없음)`);
      continue;
    }
    // internalId 로 patients 역추적
    const owner = Object.values(pats).find(p => p?.internalId === iid);
    console.log(`  ${ph} → ${iid}  (= ${owner?.name || '?'} chartNo=${owner?.chartNo || '-'})`);
  }

  console.log('\n═════ patientByChartNo 인덱스 — 두 사람 chartNo 후보 ═════');
  const chartCands = new Set();
  for (const c of conMatched) if (c.chartNo) chartCands.add(c.chartNo);
  for (const p of Object.values(pats)) {
    if (!p?.name) continue;
    if (!TARGETS.includes(baseName(p.name))) continue;
    if (p.chartNo) chartCands.add(p.chartNo);
  }
  for (const ch of chartCands) {
    const iid = byChart[ch];
    const direct = pats[ch];
    console.log(`  ${ch} → byChartNo=${iid || '-'}  patients/${ch}.name="${direct?.name || '-'}"`);
  }

  console.log('\n═════ slots 점유 (current / reservations) ═════');
  for (const [sk, slot] of Object.entries(slots)) {
    if (!slot) continue;
    const cur = slot.current;
    if (cur && TARGETS.includes(baseName(cur.name))) {
      console.log(`  [current] ${sk}  name="${cur.name}"  chartNo=${cur.chartNo || '-'}  patientId=${cur.patientId || '-'}  admit=${cur.admitDate || '-'}  cid=${cur.consultationId || '-'}`);
    }
    const res = slot.reservations || [];
    res.forEach((r, i) => {
      if (r && TARGETS.includes(baseName(r.name))) {
        console.log(`  [res#${i}]  ${sk}  name="${r.name}"  admit=${r.admitDate || '-'}  cid=${r.consultationId || '-'}`);
      }
    });
  }

  console.log('\n═════ emrSyncLog/consultationLinking/suspects 중 conMatched id ═════');
  let suspectHit = 0;
  for (const c of conMatched) {
    const s = susps[c.id];
    if (s) {
      console.log(`  ${c.id}  severity=${s.severity}  conName="${s.conName}" patName="${s.patName}"  issues=${JSON.stringify(s.issues)}`);
      suspectHit++;
    }
  }
  if (suspectHit === 0) console.log('  (해당 id 의 suspect 기록 없음 — 자동 sync 가 매칭을 confident 로 판단했거나, 매칭 안 한 케이스)');

  console.log('\n═════ logs (정수현/박명순 관련 키워드 포함) ═════');
  const logsSnap = await db.ref('logs').once('value');
  const logs = logsSnap.val() || {};
  const logArr = Array.isArray(logs) ? logs.filter(Boolean) : Object.values(logs).filter(Boolean);
  // ts 내림차순
  logArr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  let logHits = 0;
  for (const L of logArr) {
    const blob = JSON.stringify(L);
    if (/정수현|박명순4|0000007092|P08175|01077884424/.test(blob)) {
      const t = L.ts ? new Date(L.ts).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-';
      console.log(`  [${t}] ${L.user || '?'} → ${L.action || '?'}  ${L.detail || ''}`);
      if (L.before) console.log(`     before: ${JSON.stringify(L.before).slice(0, 300)}`);
      if (L.after)  console.log(`     after:  ${JSON.stringify(L.after).slice(0, 300)}`);
      logHits++;
      if (logHits >= 30) { console.log('     ... (이하 생략)'); break; }
    }
  }
  if (logHits === 0) console.log('  (관련 로그 없음 — logs 200건 한도라 4/14~5/7 사이 변경 이력은 만료됐을 가능성)');

  console.log('\n═════ slots/204-1, slots/304-1, slots/205-4 전체 상태 ═════');
  for (const sk of ['204-1', '304-1', '205-4']) {
    const s = slots[sk];
    if (!s) { console.log(`  ${sk}: (없음)`); continue; }
    console.log(`  ${sk}.current = ${JSON.stringify(s.current || null)}`);
    console.log(`  ${sk}.reservations = ${JSON.stringify(s.reservations || [])}`);
  }

  console.log('\n═════ 결론 도우미 ═════');
  const jeongCons = conMatched.filter(c => baseName(c.name) === '정수현');
  const parkCons  = conMatched.filter(c => baseName(c.name) === '박명순');
  console.log(`  정수현 consultations: ${jeongCons.length}건`);
  console.log(`  박명순 consultations: ${parkCons.length}건`);
  const aprilPark = parkCons.filter(c => (c.createdAt || '').startsWith('2026-04') || (c.createdAt || '').startsWith('2026-05'));
  console.log(`  → 그 중 4~5월 createdAt 박명순*: ${aprilPark.length}건  (이게 1건 이상이면 정수현 상담이 이름 덮어써진 후보)`);

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
