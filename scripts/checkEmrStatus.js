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
  { name: '박민경', chart: '0000006913' },
  { name: '문경옥', chart: '0000006892' },
];

function norm(n) { return (n || '').replace(/^신\)\s*/, '').replace(/\s/g, '').trim(); }

async function main() {
  console.log('═ monthlyBoards 최근 2개월에서 박민경·문경옥 입퇴원 기록 검색 ═\n');
  const months = ['2026-04', '2026-03', '2026-02'];
  for (const m of months) {
    const snap = await db.ref(`monthlyBoards/${m}`).once('value');
    const board = snap.val() || {};
    for (const [day, rec] of Object.entries(board)) {
      for (const t of TARGETS) {
        ['admissions','discharges'].forEach(field => {
          (rec?.[field] || []).forEach(e => {
            if (e?.name && norm(e.name) === norm(t.name)) {
              console.log(`  ${day} [${field}] ${e.name} — room=${e.room || '-'} chart=${e.chartNo || '-'} note=${e.note || '-'}`);
            }
          });
        });
      }
    }
  }

  console.log('\n═ patients 마스터의 최근 입원/외래 정보 ═\n');
  for (const t of TARGETS) {
    const snap = await db.ref(`patientByChartNo/${t.chart}`).once('value');
    const internalId = snap.val();
    if (!internalId) { console.log(`  ${t.name}: patientByChartNo 없음`); continue; }
    const pSnap = await db.ref(`patients/${t.chart}`).once('value');
    const p = pSnap.val() || {};
    console.log(`  ${t.name} (${internalId}): chartNo=${p.chartNo} admitDate=${p.admitDate || '-'} dischargeDate=${p.dischargeDate || '-'} lastVisitDate=${p.lastVisitDate || '-'} diagnosis=${p.diagnosis || '-'}`);
  }

  // sync.log 는 RPi에만 있지만, Firebase logs 에 "퇴원 처리" 기록이 있는지
  console.log('\n═ logs 에서 박민경·문경옥 언급 ═\n');
  const logsSnap = await db.ref('logs').once('value');
  const logs = logsSnap.val();
  const arr = Array.isArray(logs) ? logs : (logs ? Object.values(logs) : []);
  arr.forEach(l => {
    if (!l) return;
    const text = JSON.stringify(l);
    if (TARGETS.some(t => text.includes(t.name))) {
      console.log(`  [${l.ts?.slice(0,19)||'-'}] ${l.msg || l.action || ''} ${text.slice(0, 200)}`);
    }
  });
  process.exit(0);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
