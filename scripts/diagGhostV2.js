/**
 * 정밀 유령 탐지 (2차)
 * - slot.current.discharge 날짜가 오늘보다 과거인 경우만 (명백한 퇴원 누락)
 * - 동명 중복 slot
 * - patientId 없음
 * - 최근 24h 이내 변경된 consultation.status='입원완료' + 여전히 slot.current에 남음
 *
 * 또한 최근 logs를 시간순으로 출력
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
function toYMD(d) { return d ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : null; }

async function main() {
  const [slotsSnap, logsSnap, mbSnap] = await Promise.all([
    db.ref('slots').once('value'),
    db.ref('logs').once('value'),
    db.ref(`monthlyBoards/${TODAY.slice(0,7)}`).once('value'),
  ]);
  const slots = slotsSnap.val() || {};
  const logs = logsSnap.val();
  const mb = mbSnap.val() || {};

  console.log(`📅 오늘: ${TODAY}\n`);

  // 1) slot.current 수집
  const currents = [];
  for (const [slotKey, slot] of Object.entries(slots)) {
    if (slot?.current?.name) currents.push({ slotKey, ...slot.current });
  }
  console.log(`slot.current 총: ${currents.length}명`);

  // 2) 명백한 유령
  const ghosts = [];
  const nameMap = new Map();
  currents.forEach(c => {
    const nn = normName(c.name);
    if (!nameMap.has(nn)) nameMap.set(nn, []);
    nameMap.get(nn).push(c);
  });

  for (const cur of currents) {
    const nn = normName(cur.name);
    const reasons = [];
    // A) patientId 없음
    if (!cur.patientId) reasons.push('NO_PATIENT_ID');
    // B) 동명 중복
    if (nameMap.get(nn).length > 1) {
      reasons.push(`DUP_SLOT(${nameMap.get(nn).map(c => c.slotKey).join(',')})`);
    }
    // C) discharge 날짜가 이미 과거 (오늘 포함 X)
    const d = parseDate(cur.discharge);
    if (d) {
      const dYmd = toYMD(d);
      if (dYmd < TODAY) reasons.push(`DISCHARGE_PAST(${cur.discharge} → ${dYmd})`);
    }
    if (reasons.length > 0) ghosts.push({ ...cur, reasons });
  }

  console.log('\n═'.repeat(64));
  console.log('🚨 명백한 유령 후보 (정밀 조건)');
  console.log('═'.repeat(64));
  if (ghosts.length === 0) {
    console.log('  (없음)');
  } else {
    ghosts.forEach(g => {
      console.log(`  ${g.slotKey.padEnd(7)} ${String(g.name).padEnd(10)} admit=${g.admitDate||'-'} dis=${g.discharge||'미정'} pid=${g.patientId||'-'}`);
      g.reasons.forEach(r => console.log(`     └ ${r}`));
    });
  }

  // 3) 최근 로그 (상위 40개, 시간순)
  console.log('\n═'.repeat(64));
  console.log('📜 최근 logs (최대 40건)');
  console.log('═'.repeat(64));
  const arr = Array.isArray(logs) ? logs : (logs ? Object.values(logs) : []);
  const sorted = arr.filter(l => l && l.ts).sort((a,b) => (b.ts||'').localeCompare(a.ts||''));
  sorted.slice(0, 40).forEach(l => {
    const ts = (l.ts || '').slice(0, 19).replace('T', ' ');
    const t = l.type || '-';
    const a = l.action || '';
    const msg = l.msg || l.message || JSON.stringify(l).slice(0, 120);
    console.log(`  [${ts}] ${t.padEnd(6)} ${a.padEnd(10)} ${msg}`);
  });

  // 4) 오늘 monthlyBoards
  console.log('\n═'.repeat(64));
  console.log(`📋 monthlyBoards ${TODAY}`);
  console.log('═'.repeat(64));
  const today = mb[TODAY] || {};
  console.log('  admissions:', (today.admissions || []).map(a => `${a.name}(${a.room})`).join(', ') || '없음');
  console.log('  discharges:', (today.discharges || []).map(d => `${d.name}(${d.room})`).join(', ') || '없음');

  // 5) 어제 monthlyBoards
  const y = new Date(TODAY); y.setDate(y.getDate() - 1);
  const yStr = toYMD(y);
  const yd = mb[yStr] || {};
  console.log(`\n📋 monthlyBoards ${yStr}`);
  console.log('  admissions:', (yd.admissions || []).map(a => `${a.name}(${a.room})`).join(', ') || '없음');
  console.log('  discharges:', (yd.discharges || []).map(d => `${d.name}(${d.room})`).join(', ') || '없음');

  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
