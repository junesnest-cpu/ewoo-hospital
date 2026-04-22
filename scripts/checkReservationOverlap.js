/**
 * 현재 입원 + 같은 slot 의 예약이 중복 표시되는 문제 진단
 * 601-3 김은정4, 503-4 박문자2 및 모든 slot 에 대해 동일 환자 current + reservation 쌍 탐지
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

// syncEMR 이 쓰는 느슨한 정규화 (trim + lowercase)
function laxNorm(n) {
  return (n || '').trim().toLowerCase();
}
// 엄격한 정규화 (신) 접두어 + whitespace 제거)
function strictNorm(n) {
  return (n || '').replace(/^신\)\s*/, '').replace(/\s/g, '').trim().toLowerCase();
}

async function main() {
  const [slotsSnap, consulSnap] = await Promise.all([
    db.ref('slots').once('value'),
    db.ref('consultations').once('value'),
  ]);
  const slots = slotsSnap.val() || {};
  const consultations = consulSnap.val() || {};

  // 1) 특정 slot 상세
  for (const sk of ['601-3', '503-4']) {
    console.log(`\n═ ${sk} 전체 상태 ═`);
    console.log(JSON.stringify(slots[sk], null, 2));
  }

  // 2) 전체 slot 에서 current 와 같은 slot 의 reservation 이 동일 환자인지 검사
  console.log('\n═ 전체 slot 중복(current + reservation 같은 환자) 탐지 ═');
  const issues = [];
  for (const [slotKey, slot] of Object.entries(slots)) {
    const cur = slot?.current;
    const res = slot?.reservations || [];
    if (!cur?.name || res.length === 0) continue;
    const cName = cur.name;
    const cLax  = laxNorm(cName);
    const cStr  = strictNorm(cName);
    const cChart = cur.chartNo || '';
    const cPid   = cur.patientId || '';

    res.forEach((r, i) => {
      if (!r?.name) return;
      const rLax = laxNorm(r.name);
      const rStr = strictNorm(r.name);
      const laxMatch    = cLax && rLax && cLax === rLax;
      const strictMatch = cStr && rStr && cStr === rStr;
      const chartMatch  = cChart && r.chartNo && cChart === r.chartNo;
      const pidMatch    = cPid && r.patientId && cPid === r.patientId;
      const anyMatch = laxMatch || strictMatch || chartMatch || pidMatch;
      if (!anyMatch) return;

      issues.push({
        slotKey, idx: i,
        curName: cName, resName: r.name,
        curChart: cChart, resChart: r.chartNo || '',
        curPid: cPid, resPid: r.patientId || '',
        curAdmit: cur.admitDate || '', resAdmit: r.admitDate || '',
        laxMatch, strictMatch, chartMatch, pidMatch,
        consultationId: r.consultationId || '',
      });
    });
  }

  if (issues.length === 0) {
    console.log('  (중복 없음)');
  } else {
    issues.forEach(x => {
      console.log(`\n  [${x.slotKey}] current="${x.curName}" vs reservation[${x.idx}]="${x.resName}"`);
      console.log(`     cur:  chart=${x.curChart} pid=${x.curPid} admit=${x.curAdmit}`);
      console.log(`     res:  chart=${x.resChart} pid=${x.resPid} admit=${x.resAdmit} consultationId=${x.consultationId}`);
      const flags = [];
      if (x.laxMatch)    flags.push('LAX_NAME');
      if (x.strictMatch) flags.push('STRICT_NAME');
      if (x.chartMatch)  flags.push('CHART');
      if (x.pidMatch)    flags.push('PID');
      console.log(`     매칭 경로: ${flags.join(',')}`);
      if (!x.laxMatch && (x.strictMatch || x.chartMatch || x.pidMatch)) {
        console.log(`     ⚠ syncEMR 의 laxNorm 만으로는 매칭 실패 → 예약 자동 제거 안 됨!`);
      }
    });
  }

  // 3) 해당 consultation 확인
  if (issues.length > 0) {
    console.log('\n═ 관련 consultation ═');
    for (const x of issues) {
      if (!x.consultationId) continue;
      const c = consultations[x.consultationId];
      if (!c) continue;
      console.log(`  ${x.consultationId}: name="${c.name}" status="${c.status}" chart=${c.chartNo||''} pid=${c.patientId||''} admit=${c.admitDate||''} reservedSlot=${c.reservedSlot||''}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
