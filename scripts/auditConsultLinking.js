/**
 * 상담일지 ↔ EMR chart 연결 현황 진단
 *
 * 측정 지표:
 *   - 전체 consultations 수
 *   - chartNo 보유률, patientId 보유률
 *   - 식별 시그널(phone, phone2, birthYear, birthDate, chartNo) 보유율
 *   - 미연결 원인 분류:
 *       NO_SIGNAL        : 이름·날짜 외 식별자 전무 (매칭 불가)
 *       PHONE_ONLY_MISS  : 전화번호 있지만 patientByPhone 에 없음 (EMR에 해당 번호 없음)
 *       BIRTH_ONLY_MISS  : 생년만 있고 이름base 매칭 실패
 *       CANDIDATE_PENDING: 시그널 여럿 있지만 매칭이 덜 타이트해 보류
 *   - 역방향 불일치:
 *       chartNo 다른데 같은 이름·전화 → 중복/잘못 연결 의심
 *       같은 chartNo 에 여러 consultation 연결됨 (정상일 수도, 오연결일 수도)
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

function digitsOnly(s) { return (s || '').replace(/\D/g, ''); }
function normPhone(s) { return digitsOnly(s); }
function baseName(n) {
  return (n || '').replace(/^신\)\s*/, '').replace(/\d+$/, '').replace(/\s/g, '').trim().toLowerCase();
}

async function main() {
  const [conSnap, patSnap, byPhoneSnap, byChartSnap] = await Promise.all([
    db.ref('consultations').once('value'),
    db.ref('patients').once('value'),
    db.ref('patientByPhone').once('value'),
    db.ref('patientByChartNo').once('value'),
  ]);
  const cons = conSnap.val() || {};
  const pats = patSnap.val() || {};
  const byPhone = byPhoneSnap.val() || {};
  const byChart = byChartSnap.val() || {};

  const consList = Object.entries(cons).map(([id, c]) => ({ id, ...c }));
  const n = consList.length;
  console.log(`\n전체 consultations: ${n}건\n`);

  // patients 를 chartNo/phone/birthYear 인덱스
  const patByChart = new Map();
  const patByPhone = new Map();
  const patByBirthBase = new Map(); // `${birthYear}|${baseName}` → [pat]
  for (const [chartNo, p] of Object.entries(pats)) {
    if (!p) continue;
    patByChart.set(chartNo, p);
    const phn = normPhone(p.phone);
    if (phn) patByPhone.set(phn, p);
    const birth = p.birthDate || '';
    const by = birth.slice(0, 4);
    const bn = baseName(p.name);
    if (by && bn) {
      const key = `${by}|${bn}`;
      if (!patByBirthBase.has(key)) patByBirthBase.set(key, []);
      patByBirthBase.get(key).push(p);
    }
  }

  // 카운터
  const has = { chart: 0, pid: 0, phone: 0, phone2: 0, birthYear: 0, birthDate: 0 };
  const status = { linked: 0, partial: 0, unlinked: 0 };
  const failReason = { NO_SIGNAL: 0, PHONE_MISS: 0, BIRTH_ONLY: 0, NAME_DUP_UNRESOLVED: 0, WRONG_PID_NO_CHART: 0 };
  const cancelled = [];
  const potentialMatches = []; // 지금 로직으론 못 잡지만 매칭 가능해 보이는 건

  for (const c of consList) {
    if (c.status === '취소') { cancelled.push(c); continue; }
    if (c.chartNo) has.chart++;
    if (c.patientId) has.pid++;
    if (c.phone) has.phone++;
    if (c.phone2) has.phone2++;
    if (c.birthYear) has.birthYear++;
    if (c.birthDate) has.birthDate++;

    const hasAny = !!c.chartNo;
    if (hasAny) status.linked++;
    else if (c.patientId) status.partial++;
    else status.unlinked++;

    // 미연결 분류
    if (!c.chartNo) {
      const phn  = normPhone(c.phone);
      const phn2 = normPhone(c.phone2);
      const hasPhone = !!(phn || phn2);
      if (!hasPhone && !c.birthYear) {
        failReason.NO_SIGNAL++;
      } else if (hasPhone) {
        const found = patByPhone.has(phn) ? patByPhone.get(phn)
                    : patByPhone.has(phn2) ? patByPhone.get(phn2) : null;
        if (!found) failReason.PHONE_MISS++;
        else {
          // 매칭 가능한데 연결 안 돼있음 — Phase 2.5 가 아직 안 돌았거나, 이름 mismatch skip
          potentialMatches.push({ cid: c.id, cName: c.name, pName: found.name, pChart: found.chartNo, reason: 'phone_match_exists' });
        }
      } else if (c.birthYear) {
        const key = `${c.birthYear}|${baseName(c.name)}`;
        const cands = patByBirthBase.get(key) || [];
        if (cands.length === 0) failReason.BIRTH_ONLY++;
        else if (cands.length === 1) {
          potentialMatches.push({ cid: c.id, cName: c.name, pName: cands[0].name, pChart: cands[0].chartNo, reason: 'birth+base_unique' });
        } else {
          failReason.NAME_DUP_UNRESOLVED++;
        }
      }
    } else {
      // chartNo 있는데 patientId 없거나, chartNo 와 patients master 데이터 불일치 검증
      const patByThisChart = patByChart.get(c.chartNo);
      if (!patByThisChart) failReason.WRONG_PID_NO_CHART++;
    }
  }

  console.log('─'.repeat(60));
  console.log('📊 연결 상태');
  console.log('─'.repeat(60));
  console.log(`  ✅ chartNo 연결 완료:   ${status.linked}건 (${(100*status.linked/n).toFixed(1)}%)`);
  console.log(`  🟡 patientId 만 있음:   ${status.partial}건 (chartNo 없음)`);
  console.log(`  ❌ 미연결:              ${status.unlinked + status.partial}건`);
  console.log(`     (취소 제외: ${cancelled.length}건 별도)`);

  console.log('\n─'.repeat(60));
  console.log('📋 식별 시그널 보유율');
  console.log('─'.repeat(60));
  const pct = (x) => `${x}건 (${(100*x/n).toFixed(1)}%)`;
  console.log(`  chartNo:   ${pct(has.chart)}`);
  console.log(`  patientId: ${pct(has.pid)}`);
  console.log(`  phone:     ${pct(has.phone)}`);
  console.log(`  phone2:    ${pct(has.phone2)}`);
  console.log(`  birthYear: ${pct(has.birthYear)}`);
  console.log(`  birthDate: ${pct(has.birthDate)}`);

  console.log('\n─'.repeat(60));
  console.log('🔍 미연결 원인 분류 (취소 제외)');
  console.log('─'.repeat(60));
  console.log(`  NO_SIGNAL (식별자 없음):              ${failReason.NO_SIGNAL}건`);
  console.log(`  PHONE_MISS (전화 있는데 EMR 매칭 X): ${failReason.PHONE_MISS}건`);
  console.log(`  BIRTH_ONLY (생년·이름base 매칭 X):    ${failReason.BIRTH_ONLY}건`);
  console.log(`  NAME_DUP_UNRESOLVED (동명이인 충돌): ${failReason.NAME_DUP_UNRESOLVED}건`);
  console.log(`  WRONG_CHART (chartNo 무효):           ${failReason.WRONG_PID_NO_CHART}건`);

  console.log('\n─'.repeat(60));
  console.log(`🟢 매칭 가능해 보이는 미연결: ${potentialMatches.length}건 (Phase 2.5 가 놓친 후보)`);
  console.log('─'.repeat(60));
  potentialMatches.slice(0, 30).forEach(m => {
    console.log(`  [${m.cid}] "${m.cName}" → EMR "${m.pName}" (chart=${m.pChart}) — ${m.reason}`);
  });
  if (potentialMatches.length > 30) console.log(`  ...외 ${potentialMatches.length - 30}건`);

  // 중복·오연결 의심
  const byChartMap = new Map();
  for (const c of consList) {
    if (c.status === '취소') continue;
    if (c.chartNo) {
      if (!byChartMap.has(c.chartNo)) byChartMap.set(c.chartNo, []);
      byChartMap.get(c.chartNo).push(c);
    }
  }
  const dupChart = [...byChartMap.entries()].filter(([, arr]) => arr.length > 1);
  console.log('\n─'.repeat(60));
  console.log(`🧩 같은 chartNo 에 여러 consultation 연결: ${dupChart.length}건`);
  console.log('─'.repeat(60));
  dupChart.slice(0, 20).forEach(([chart, arr]) => {
    console.log(`  chart=${chart} : ${arr.length}건`);
    arr.forEach(c => console.log(`     - [${c.id}] name="${c.name}" status="${c.status||''}" admit=${c.admitDate||'-'} reservedSlot=${c.reservedSlot||'-'}`));
  });

  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
