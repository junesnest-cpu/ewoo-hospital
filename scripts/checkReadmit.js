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
  for (const sk of ['201-2', '205-5']) {
    const snap = await db.ref(`slots/${sk}`).once('value');
    const slot = snap.val() || {};
    console.log(`\n═ ${sk} ═`);
    console.log('current:', JSON.stringify(slot.current));
    console.log('reservations:', JSON.stringify(slot.reservations));
  }

  // 재원 카운트 재계산 (UI 로직 동일)
  const today = new Date(); today.setHours(0, 0, 0, 0);
  function parse(d) {
    if (!d || d === '미정') return null;
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    if (iso) return new Date(parseInt(iso[1]), parseInt(iso[2])-1, parseInt(iso[3]));
    const md = /^(\d{1,2})\/(\d{1,2})$/.exec(d);
    if (md) return new Date(today.getFullYear(), parseInt(md[1])-1, parseInt(md[2]));
    return null;
  }
  const slotsSnap = await db.ref('slots').once('value');
  const slots = slotsSnap.val() || {};
  let actual = 0;
  const excluded = [];
  for (const [sk, slot] of Object.entries(slots)) {
    if (!slot?.current?.name) continue;
    const dis = parse(slot.current.discharge);
    if (!dis || dis >= today) actual++;
    else excluded.push({ sk, name: slot.current.name, discharge: slot.current.discharge });
  }
  console.log(`\n재원 카운트: ${actual}`);
  if (excluded.length) {
    console.log('과거 퇴원일 때문에 제외된 current:');
    excluded.forEach(e => console.log(`  ${e.sk} ${e.name} discharge=${e.discharge}`));
  }
  process.exit(0);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
