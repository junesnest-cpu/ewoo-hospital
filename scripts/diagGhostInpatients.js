/**
 * slot.current 52명 중 실제로는 퇴원했을 가능성이 있는 유령 환자 찾기
 *
 * 판단 기준:
 * 1) monthlyBoards에 오늘(또는 최근) 퇴원 기록이 있는데 slot.current에 남아있음
 * 2) consultation.status === '입원완료' 인데 slot.current에 남아있음
 * 3) 동명 슬롯 중복 (이미 206-5 김명선3 확인됨)
 * 4) discharge 날짜 < 오늘
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

const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
const normName = (n) => (n || '').replace(/^신\)\s*/, '').replace(/\s/g, '').trim().toLowerCase();

function parseDate(str) {
  if (!str || str === '미정') return null;
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(+iso[1], +iso[2]-1, +iso[3]);
  const m = str.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return new Date(new Date().getFullYear(), +m[1]-1, +m[2]);
  return null;
}

async function main() {
  const [slotsSnap, consulSnap, mbSnap] = await Promise.all([
    db.ref('slots').once('value'),
    db.ref('consultations').once('value'),
    db.ref(`monthlyBoards/${TODAY.slice(0,7)}`).once('value'),
  ]);
  const slots = slotsSnap.val() || {};
  const consultations = consulSnap.val() || {};
  const mb = mbSnap.val() || {};

  console.log(`오늘: ${TODAY}\n`);

  // 최근 7일 퇴원자 이름 세트
  const recentDischarged = new Map(); // nameN → [{date, room}]
  Object.entries(mb).forEach(([dateStr, day]) => {
    if (dateStr > TODAY) return;
    const daysDiff = (new Date(TODAY) - new Date(dateStr)) / 86400000;
    if (daysDiff > 7) return;
    (day.discharges || []).forEach(d => {
      const nn = normName(d.name);
      if (!nn) return;
      if (!recentDischarged.has(nn)) recentDischarged.set(nn, []);
      recentDischarged.get(nn).push({ date: dateStr, room: d.room, note: d.note });
    });
  });

  // slot.current 전체 수집
  const currents = [];
  for (const [slotKey, slot] of Object.entries(slots)) {
    if (slot?.current?.name) {
      currents.push({ slotKey, ...slot.current });
    }
  }
  console.log(`slot.current 총: ${currents.length}명\n`);

  // 유령 후보 판정
  const ghosts = [];
  for (const cur of currents) {
    const nn = normName(cur.name);
    const flags = [];
    // 1) 최근 monthlyBoards 퇴원자와 이름 일치
    if (recentDischarged.has(nn)) {
      const recs = recentDischarged.get(nn);
      flags.push(`MB_DISCHARGED(${recs.map(r=>r.date).join(',')})`);
    }
    // 2) consultation 상태 확인
    const relConsul = Object.entries(consultations).filter(([id, c]) => c && normName(c.name) === nn);
    for (const [cid, c] of relConsul) {
      if (c.status === '입원완료') flags.push(`CONSUL_COMPLETED(${cid})`);
    }
    // 3) discharge 날짜 < 오늘
    if (cur.discharge && cur.discharge !== '미정') {
      const d = parseDate(cur.discharge);
      if (d && `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` < TODAY) {
        flags.push(`PAST_DISCHARGE(${cur.discharge})`);
      }
    }
    // 4) patientId 없음
    if (!cur.patientId) flags.push('NO_PID');
    // 5) 동명 중복
    const sameName = currents.filter(c => normName(c.name) === nn);
    if (sameName.length > 1) flags.push(`DUP(${sameName.map(c=>c.slotKey).join(',')})`);

    if (flags.length > 0) ghosts.push({ ...cur, flags });
  }

  console.log('═'.repeat(70));
  console.log('🔍 유령/의심 candidates');
  console.log('═'.repeat(70));
  ghosts.forEach(g => {
    console.log(`  ${g.slotKey.padEnd(7)} ${String(g.name).padEnd(10)} admit=${g.admitDate||'-'} dis=${g.discharge||'미정'} pid=${g.patientId||'-'}`);
    g.flags.forEach(f => console.log(`     └ ${f}`));
  });

  // monthlyBoards 오늘 퇴원 기록
  console.log('\n═'.repeat(70));
  console.log(`📋 monthlyBoards ${TODAY} discharges`);
  console.log('═'.repeat(70));
  const today = mb[TODAY] || {};
  const todayDischarges = today.discharges || [];
  if (todayDischarges.length === 0) {
    console.log('  (오늘 퇴원 기록 없음)');
  } else {
    todayDischarges.forEach(d => console.log(`  ${d.name} (${d.room})`));
  }

  // 오늘 입원 기록
  console.log(`\n📋 monthlyBoards ${TODAY} admissions`);
  const todayAdms = today.admissions || [];
  if (todayAdms.length === 0) {
    console.log('  (오늘 입원 기록 없음)');
  } else {
    todayAdms.forEach(d => console.log(`  ${d.name} (${d.room})`));
  }

  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
