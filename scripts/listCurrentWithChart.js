/**
 * slot.current 52명을 차트번호·이름·입원일 형식으로 출력
 * 사용자가 EMR 입원 목록(48명)과 대조해 유령 4명을 식별하기 위함
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
  const slotsSnap = await db.ref('slots').once('value');
  const slots = slotsSnap.val() || {};

  const currents = [];
  for (const [slotKey, slot] of Object.entries(slots)) {
    if (slot?.current?.name) {
      currents.push({
        slotKey,
        name: slot.current.name,
        chartNo: slot.current.chartNo || '',
        patientId: slot.current.patientId || '',
        admitDate: slot.current.admitDate || '',
        discharge: slot.current.discharge || '',
      });
    }
  }
  currents.sort((a, b) => a.slotKey.localeCompare(b.slotKey));

  console.log(`\n총 ${currents.length}명 (EMR 48명 vs 병동 ${currents.length}명 → 유령 ${currents.length-48}명 추정)\n`);
  console.log(' #   병상    차트번호         환자명        입원일          퇴원예정');
  console.log('─'.repeat(75));
  currents.forEach((c, i) => {
    const idx = String(i+1).padStart(2);
    const sk = c.slotKey.padEnd(6);
    const chart = (c.chartNo || '(없음)').padEnd(14);
    const name = String(c.name).padEnd(10);
    const adm = (c.admitDate || '-').padEnd(12);
    const dis = c.discharge || '미정';
    const flags = [];
    if (!c.chartNo) flags.push('차트번호없음');
    if (!c.patientId) flags.push('PID없음');
    const flagStr = flags.length ? `  ⚠ ${flags.join(',')}` : '';
    console.log(` ${idx}  ${sk} ${chart} ${name} ${adm} ${dis}${flagStr}`);
  });

  // 차트번호 없는 경우 (확실한 유령)
  const noChart = currents.filter(c => !c.chartNo);
  if (noChart.length > 0) {
    console.log('\n🚨 차트번호 없는 current (EMR 매칭 불가 = 유령 확정):');
    noChart.forEach(c => console.log(`  ${c.slotKey} ${c.name}`));
  }

  // 동명 이인 (혹시 한 명이 두 슬롯에)
  const nameMap = new Map();
  currents.forEach(c => {
    const k = (c.name || '').replace(/^신\)\s*/, '').trim();
    if (!nameMap.has(k)) nameMap.set(k, []);
    nameMap.get(k).push(c);
  });
  const dups = [...nameMap.entries()].filter(([, v]) => v.length > 1);
  if (dups.length > 0) {
    console.log('\n🚨 같은 이름이 2개 slot에 존재:');
    dups.forEach(([k, v]) => {
      v.forEach(c => console.log(`  ${c.slotKey} ${c.name} chart=${c.chartNo||'(없음)'} admit=${c.admitDate}`));
    });
  }

  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
