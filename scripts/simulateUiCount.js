/**
 * index.js 재원(actual) 카운트 로직을 그대로 재현해 48명 중 누가 제외되는지 판정
 *
 * index.js 규칙:
 *   actual++ if slot.current.name && (!discharge || parseDateStr(discharge) >= today)
 *
 * parseDateStr (lib/WardDataContext.js):
 *   - ISO: YYYY-MM-DD
 *   - M/D → new Date(currentYear, M-1, D)
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

function parseDateStr(str, contextYear) {
  if (!str || str === "미정") return null;
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(+iso[1], +iso[2]-1, +iso[3]);
  const m = str.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return new Date(contextYear || new Date().getFullYear(), +m[1]-1, +m[2]);
  return null;
}
function dateOnly(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }

async function main() {
  const slotsSnap = await db.ref('slots').once('value');
  const slots = slotsSnap.val() || {};

  const today = new Date(); today.setHours(0,0,0,0);
  console.log(`📅 today = ${today.toISOString().slice(0,10)}\n`);

  let actual = 0;
  const included = [];
  const excluded = [];

  for (const [slotKey, slot] of Object.entries(slots)) {
    const cur = slot?.current;
    if (!cur?.name) continue;
    const dis = parseDateStr(cur.discharge);
    if (!dis || dateOnly(dis) >= today) {
      actual++;
      included.push({ slotKey, name: cur.name, discharge: cur.discharge || '미정', parsed: dis ? dis.toISOString().slice(0,10) : '-' });
    } else {
      excluded.push({ slotKey, name: cur.name, discharge: cur.discharge, parsed: dis.toISOString().slice(0,10) });
    }
  }

  console.log(`재원(actual) 포함: ${actual}명`);
  console.log(`재원에서 제외 (discharge < today): ${excluded.length}명\n`);

  if (excluded.length > 0) {
    console.log('🔴 제외된 환자 (이미 퇴원 지난 날짜 — UI 재원에 안 잡힘):');
    excluded.forEach(e => console.log(`  ${e.slotKey.padEnd(7)} ${e.name.padEnd(10)} discharge=${e.discharge}  (파싱 ${e.parsed})`));
  }

  console.log('\n📋 포함 + 제외 전체 48명 discharge 분포:');
  [...included, ...excluded].sort((a,b)=>a.slotKey.localeCompare(b.slotKey)).forEach(e => {
    const tag = excluded.includes(e) ? '❌' : '✅';
    console.log(`  ${tag} ${e.slotKey.padEnd(7)} ${e.name.padEnd(10)} dis=${e.discharge||'미정'}`);
  });

  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
