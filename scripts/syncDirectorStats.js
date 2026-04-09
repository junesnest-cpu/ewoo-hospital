/**
 * EMR → Firebase 경영현황 동기화
 * - 월별 입원/외래 매출 합산
 * - 일자별 병상가동률
 *
 * 실행: node scripts/syncDirectorStats.js [year]
 *   예: node scripts/syncDirectorStats.js 2026
 */
require('dotenv').config({ path: '.env.local' });
const sql   = require('mssql');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
    databaseURL: 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
  });
}
const db = admin.database();

const sqlConfig = {
  user:     process.env.EMR_DB_USER,
  password: process.env.EMR_DB_PASSWORD,
  database: 'BrWonmu',
  server:   '192.168.0.253',
  port:     1433,
  options: { encrypt: false, trustServerCertificate: true },
  requestTimeout: 30000,
};

const TOTAL_BEDS = 78;

async function main() {
  const year = parseInt(process.argv[2]) || new Date().getFullYear();
  console.log(`📊 경영현황 동기화 시작 (${year}년)`);

  const pool = await sql.connect(sqlConfig);
  const updates = {};

  // ── 1. 월별 입원 매출 ──
  console.log('\n[입원 매출]');
  const yearStart = `${year}0101`;
  const yearEnd   = `${year + 1}0101`;

  const inResult = await pool.request().query(`
    SELECT
      LEFT(idam_date, 6) AS ym,
      SUM(CASE WHEN idam_bigub = 0 THEN idam_amt ELSE 0 END) AS covered,
      SUM(CASE WHEN idam_bigub = 1 THEN idam_amt ELSE 0 END) AS nonCovered,
      SUM(idam_amt) AS total
    FROM Widam
    WHERE idam_date >= '${yearStart}' AND idam_date < '${yearEnd}'
    GROUP BY LEFT(idam_date, 6)
    ORDER BY ym
  `);

  const inpatient = {};
  for (const r of inResult.recordset) {
    inpatient[r.ym] = { covered: r.covered, nonCovered: r.nonCovered, total: r.total };
    console.log(`  ${r.ym}: 급여 ${Math.round(r.covered/10000)}만 / 비급여 ${Math.round(r.nonCovered/10000)}만 / 합계 ${Math.round(r.total/10000)}만`);
  }
  updates[`directorStats/${year}/revenue/inpatient`] = inpatient;

  // ── 2. 월별 외래 매출 (Wodam 또는 Wjdam 시도) ──
  console.log('\n[외래 매출]');
  let outpatient = {};
  let outFound = false;

  // Wodam 시도
  try {
    const opResult = await pool.request().query(`
      SELECT
        LEFT(odam_date, 6) AS ym,
        SUM(CASE WHEN odam_bigub = 0 THEN odam_amt ELSE 0 END) AS covered,
        SUM(CASE WHEN odam_bigub = 1 THEN odam_amt ELSE 0 END) AS nonCovered,
        SUM(odam_amt) AS total
      FROM Wodam
      WHERE odam_date >= '${yearStart}' AND odam_date < '${yearEnd}'
      GROUP BY LEFT(odam_date, 6)
      ORDER BY ym
    `);
    for (const r of opResult.recordset) {
      outpatient[r.ym] = { covered: r.covered, nonCovered: r.nonCovered, total: r.total };
      console.log(`  ${r.ym}: 급여 ${Math.round(r.covered/10000)}만 / 비급여 ${Math.round(r.nonCovered/10000)}만 / 합계 ${Math.round(r.total/10000)}만`);
    }
    outFound = true;
    console.log('  (Wodam 테이블 사용)');
  } catch (e) {
    console.log(`  Wodam 없음: ${e.message}`);
  }

  // Wjdam 시도
  if (!outFound) {
    try {
      const opResult2 = await pool.request().query(`
        SELECT
          LEFT(jdam_date, 6) AS ym,
          SUM(CASE WHEN jdam_bigub = 0 THEN jdam_amt ELSE 0 END) AS covered,
          SUM(CASE WHEN jdam_bigub = 1 THEN jdam_amt ELSE 0 END) AS nonCovered,
          SUM(jdam_amt) AS total
        FROM Wjdam
        WHERE jdam_date >= '${yearStart}' AND jdam_date < '${yearEnd}'
        GROUP BY LEFT(jdam_date, 6)
        ORDER BY ym
      `);
      for (const r of opResult2.recordset) {
        outpatient[r.ym] = { covered: r.covered, nonCovered: r.nonCovered, total: r.total };
        console.log(`  ${r.ym}: 급여 ${Math.round(r.covered/10000)}만 / 비급여 ${Math.round(r.nonCovered/10000)}만`);
      }
      outFound = true;
      console.log('  (Wjdam 테이블 사용)');
    } catch (e2) {
      console.log(`  Wjdam도 없음: ${e2.message}`);
      console.log('  → 외래 매출 데이터 없음');
    }
  }
  updates[`directorStats/${year}/revenue/outpatient`] = outFound ? outpatient : null;

  // ── 3. 일자별 병상가동률 ──
  console.log('\n[병상 가동률]');
  const currentMonth = year === new Date().getFullYear() ? new Date().getMonth() + 1 : 12;

  for (let m = 1; m <= currentMonth; m++) {
    const ym = `${year}${String(m).padStart(2, '0')}`;
    const daysInMonth = new Date(year, m, 0).getDate();
    const monthEnd = `${ym}${String(daysInMonth).padStart(2, '0')}`;

    try {
      const result = await pool.request().query(`
        SELECT d.dt, COUNT(p.CHARTNO) AS occupied
        FROM (
          SELECT '${ym}' + RIGHT('0' + CAST(n AS VARCHAR), 2) AS dt
          FROM (SELECT TOP ${daysInMonth} ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
                FROM sys.objects) nums
        ) d
        LEFT JOIN SILVER_PATIENT_INFO p
          ON p.INDAT <= d.dt
          AND (p.OUTDAT >= d.dt OR p.OUTDAT IS NULL OR p.OUTDAT = '')
          AND p.INSUCLS NOT IN ('50')
        GROUP BY d.dt
        ORDER BY d.dt
      `);

      const daily = {};
      let totalOcc = 0;
      for (const r of result.recordset) {
        const rate = Math.round((r.occupied / TOTAL_BEDS) * 1000) / 10;
        daily[r.dt] = { occupied: r.occupied, total: TOTAL_BEDS, rate };
        totalOcc += r.occupied;
      }
      const avgRate = result.recordset.length > 0
        ? Math.round((totalOcc / result.recordset.length / TOTAL_BEDS) * 1000) / 10 : 0;

      updates[`directorStats/${year}/occupancy/${ym}`] = daily;
      console.log(`  ${m}월: 평균 가동률 ${avgRate}% (${result.recordset.length}일)`);
    } catch (e) {
      console.log(`  ${m}월 가동률 조회 실패: ${e.message}`);
      // Wbedm 대안 시도 (현재 상태만)
      if (m === currentMonth) {
        try {
          const bedResult = await pool.request().query(`
            SELECT COUNT(*) AS occupied FROM Wbedm
            WHERE bedm_cham IS NOT NULL AND bedm_cham != ''
          `);
          const occ = bedResult.recordset[0]?.occupied || 0;
          const today = new Date();
          const todayStr = `${year}${String(m).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
          updates[`directorStats/${year}/occupancy/${ym}/${todayStr}`] = {
            occupied: occ, total: TOTAL_BEDS,
            rate: Math.round((occ / TOTAL_BEDS) * 1000) / 10,
          };
          console.log(`  ${m}월 현재: ${occ}/${TOTAL_BEDS} (Wbedm 기준)`);
        } catch (e2) {
          console.log(`  Wbedm도 실패: ${e2.message}`);
        }
      }
    }
  }

  // 마지막 동기화 시각
  updates[`directorStats/${year}/lastSync`] = new Date().toISOString();

  // ── Firebase 반영 ──
  console.log('\n🔥 Firebase 업데이트...');
  await db.ref('/').update(updates);

  console.log('\n' + '═'.repeat(50));
  console.log('✅ 경영현황 동기화 완료');

  await sql.close();
  process.exit(0);
}

main().catch(err => {
  console.error('❌', err.message);
  sql.close().catch(() => {});
  process.exit(1);
});
