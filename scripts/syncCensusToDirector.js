/**
 * monthlyCensus → directorStats/occupancy 동기화
 * monthly.js가 저장한 재원 데이터를 경영현황에 반영
 *
 * 사용법: node scripts/syncCensusToDirector.js [YYYY] [MM]
 *   기본: 현재 월
 */
require('dotenv').config({ path: '.env.local' });
const admin = require('firebase-admin');
const pk = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: pk,
    }),
    databaseURL: 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
  });
}
const db = admin.database();
const TOTAL_BEDS = 78;

(async () => {
  const args = process.argv.slice(2);
  const now = new Date();
  const year = parseInt(args[0]) || now.getFullYear();
  const month = parseInt(args[1]) || (now.getMonth() + 1);
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const ymShort = `${year}${String(month).padStart(2, '0')}`;

  console.log(`📊 monthlyCensus → directorStats 동기화 (${ym})`);

  const snap = await db.ref(`monthlyCensus/${ym}`).get();
  const census = snap.val();
  if (!census) {
    console.log('❌ monthlyCensus 데이터 없음 — 월간예정표를 먼저 열어주세요');
    process.exit(1);
  }

  const daily = {};
  let totalOcc = 0, dayCount = 0;
  for (const [dt, occupied] of Object.entries(census)) {
    daily[dt] = { occupied, total: TOTAL_BEDS, rate: Math.round((occupied / TOTAL_BEDS) * 1000) / 10 };
    totalOcc += occupied;
    dayCount++;
  }

  await db.ref(`directorStats/${year}/occupancy/${ymShort}`).set(daily);
  const avg = dayCount > 0 ? Math.round((totalOcc / dayCount / TOTAL_BEDS) * 1000) / 10 : 0;
  console.log(`✅ ${dayCount}일 반영 완료 — 평균 가동률 ${avg}%`);

  // 오늘/내일 확인
  const todayKey = `${ymShort}${String(now.getDate()).padStart(2, '0')}`;
  const tomorrowKey = `${ymShort}${String(now.getDate() + 1).padStart(2, '0')}`;
  if (daily[todayKey]) console.log(`  오늘(${todayKey}): ${daily[todayKey].occupied}명`);
  if (daily[tomorrowKey]) console.log(`  내일(${tomorrowKey}): ${daily[tomorrowKey].occupied}명`);

  process.exit(0);
})();
