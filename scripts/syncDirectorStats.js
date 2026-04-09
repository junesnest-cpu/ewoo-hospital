/**
 * EMR → Firebase 경영현황 동기화
 * - 월별 입원/외래 매출 합산 (Widam + Widamb 등 복합 조회)
 * - 일자별 병상가동률 (오늘까지만)
 *
 * 실행: node scripts/syncDirectorStats.js [year]
 *   예: node scripts/syncDirectorStats.js 2026
 *
 * 테이블 탐색: node scripts/syncDirectorStats.js --explore
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
  requestTimeout: 60000,
};

const TOTAL_BEDS = 78;

// ── 테이블 탐색 모드 ──
async function explore(pool) {
  console.log('🔍 EMR 데이터베이스 테이블 탐색\n');

  // 매출/수납/청구 관련 테이블 찾기
  const tables = await pool.request().query(`
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
  `);
  console.log('📋 전체 테이블 목록:');
  tables.recordset.forEach(t => console.log(`  ${t.TABLE_NAME}`));

  // 뷰 목록
  const views = await pool.request().query(`
    SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS ORDER BY TABLE_NAME
  `);
  console.log('\n📋 전체 뷰 목록:');
  views.recordset.forEach(t => console.log(`  ${t.TABLE_NAME}`));

  // 매출 관련 키워드 검색
  const keywords = ['sunam','suip','maech','chub','jung','suap','meds','bill','rev','income','month'];
  console.log('\n🔍 매출/수납/청구 관련 테이블:');
  for (const kw of keywords) {
    const r = await pool.request().query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_NAME LIKE '%${kw}%' ORDER BY TABLE_NAME
    `);
    if (r.recordset.length > 0) {
      r.recordset.forEach(t => console.log(`  [${kw}] ${t.TABLE_NAME}`));
    }
  }

  // Widam 컬럼 확인
  console.log('\n📋 Widam 컬럼:');
  const widamCols = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'Widam' ORDER BY ORDINAL_POSITION
  `);
  widamCols.recordset.forEach(c => console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE})`));

  // Widamb 컬럼 확인
  console.log('\n📋 Widamb 컬럼:');
  try {
    const widambCols = await pool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'Widamb' ORDER BY ORDINAL_POSITION
    `);
    widambCols.recordset.forEach(c => console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE})`));
  } catch (e) { console.log('  (Widamb 없음)'); }

  // Widam 샘플 (1월 합계 확인)
  console.log('\n📋 Widam 2025년 1월 합계:');
  const sample = await pool.request().query(`
    SELECT idam_bigub, COUNT(*) AS cnt, SUM(idam_amt) AS total
    FROM Widam WHERE LEFT(idam_date, 6) = '202501'
    GROUP BY idam_bigub ORDER BY idam_bigub
  `);
  sample.recordset.forEach(r => console.log(`  bigub=${r.idam_bigub}: ${r.cnt}건, ${Math.round(r.total).toLocaleString()}원`));

  // amt 컬럼이 있는 테이블 찾기
  console.log('\n🔍 amt 컬럼 보유 테이블:');
  const amtTables = await pool.request().query(`
    SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE COLUMN_NAME LIKE '%amt%' OR COLUMN_NAME LIKE '%금%' OR COLUMN_NAME LIKE '%price%'
    ORDER BY TABLE_NAME, COLUMN_NAME
  `);
  amtTables.recordset.forEach(r => console.log(`  ${r.TABLE_NAME}.${r.COLUMN_NAME}`));
}

// ── 매출 쿼리 (여러 접근 시도) ──
async function queryRevenue(pool, year, type) {
  const yearStart = `${year}0101`;
  const yearEnd   = `${year + 1}0101`;
  const label = type === 'in' ? '입원' : '외래';

  // ── 전략 1: Widam/Wodam + Widamb/Wodamb 합산 (처방 + 행위) ──
  if (type === 'in') {
    try {
      // 먼저 Widamb에 amt 컬럼이 있는지 확인
      let hasWidamb = false;
      try {
        await pool.request().query(`SELECT TOP 1 idamb_amt FROM Widamb`);
        hasWidamb = true;
      } catch (e) { /* Widamb에 amt 컬럼 없음 */ }

      let query;
      if (hasWidamb) {
        query = `
          SELECT ym,
            SUM(CASE WHEN bigub = 0 THEN amt ELSE 0 END) AS covered,
            SUM(CASE WHEN bigub = 1 THEN amt ELSE 0 END) AS nonCovered,
            SUM(amt) AS total
          FROM (
            SELECT LEFT(idam_date, 6) AS ym, idam_bigub AS bigub, idam_amt AS amt
            FROM Widam WHERE idam_date >= '${yearStart}' AND idam_date < '${yearEnd}'
            UNION ALL
            SELECT LEFT(idamb_date, 6) AS ym, idamb_bigub AS bigub, idamb_amt AS amt
            FROM Widamb WHERE idamb_date >= '${yearStart}' AND idamb_date < '${yearEnd}'
          ) t
          GROUP BY ym ORDER BY ym
        `;
      } else {
        query = `
          SELECT LEFT(idam_date, 6) AS ym,
            SUM(CASE WHEN idam_bigub = 0 THEN idam_amt ELSE 0 END) AS covered,
            SUM(CASE WHEN idam_bigub = 1 THEN idam_amt ELSE 0 END) AS nonCovered,
            SUM(idam_amt) AS total
          FROM Widam
          WHERE idam_date >= '${yearStart}' AND idam_date < '${yearEnd}'
          GROUP BY LEFT(idam_date, 6) ORDER BY ym
        `;
      }

      const result = await pool.request().query(query);
      console.log(`  ${label}: ${hasWidamb ? 'Widam+Widamb' : 'Widam'} 사용`);
      return result.recordset;
    } catch (e) {
      console.log(`  ${label} Widam 쿼리 실패: ${e.message}`);
      return [];
    }
  }

  // 외래
  const attempts = [
    { table: 'Wodam', prefix: 'odam', tableB: 'Wodamb', prefixB: 'odamb' },
    { table: 'Wjdam', prefix: 'jdam', tableB: 'Wjdamb', prefixB: 'jdamb' },
  ];

  for (const att of attempts) {
    try {
      let hasB = false;
      try {
        await pool.request().query(`SELECT TOP 1 ${att.prefixB}_amt FROM ${att.tableB}`);
        hasB = true;
      } catch (e) { /* tableB 없거나 amt 없음 */ }

      let query;
      if (hasB) {
        query = `
          SELECT ym,
            SUM(CASE WHEN bigub = 0 THEN amt ELSE 0 END) AS covered,
            SUM(CASE WHEN bigub = 1 THEN amt ELSE 0 END) AS nonCovered,
            SUM(amt) AS total
          FROM (
            SELECT LEFT(${att.prefix}_date, 6) AS ym, ${att.prefix}_bigub AS bigub, ${att.prefix}_amt AS amt
            FROM ${att.table} WHERE ${att.prefix}_date >= '${yearStart}' AND ${att.prefix}_date < '${yearEnd}'
            UNION ALL
            SELECT LEFT(${att.prefixB}_date, 6) AS ym, ${att.prefixB}_bigub AS bigub, ${att.prefixB}_amt AS amt
            FROM ${att.tableB} WHERE ${att.prefixB}_date >= '${yearStart}' AND ${att.prefixB}_date < '${yearEnd}'
          ) t
          GROUP BY ym ORDER BY ym
        `;
      } else {
        query = `
          SELECT LEFT(${att.prefix}_date, 6) AS ym,
            SUM(CASE WHEN ${att.prefix}_bigub = 0 THEN ${att.prefix}_amt ELSE 0 END) AS covered,
            SUM(CASE WHEN ${att.prefix}_bigub = 1 THEN ${att.prefix}_amt ELSE 0 END) AS nonCovered,
            SUM(${att.prefix}_amt) AS total
          FROM ${att.table}
          WHERE ${att.prefix}_date >= '${yearStart}' AND ${att.prefix}_date < '${yearEnd}'
          GROUP BY LEFT(${att.prefix}_date, 6) ORDER BY ym
        `;
      }

      const result = await pool.request().query(query);
      console.log(`  ${label}: ${hasB ? att.table+'+'+att.tableB : att.table} 사용`);
      return result.recordset;
    } catch (e) {
      console.log(`  ${att.table} 시도 실패: ${e.message}`);
    }
  }
  console.log(`  → ${label} 매출 데이터 없음`);
  return [];
}

// ── 입원일수 쿼리 ──
async function queryBedDays(pool, year) {
  const yearStart = `${year}0101`;
  const yearEnd   = `${year + 1}0101`;
  try {
    const result = await pool.request().query(`
      SELECT LEFT(dt, 6) AS ym, COUNT(*) AS bedDays
      FROM (
        SELECT d.dt
        FROM (
          SELECT '${year}' + RIGHT('0'+CAST(m AS VARCHAR),2) + RIGHT('0'+CAST(d AS VARCHAR),2) AS dt
          FROM (SELECT DISTINCT n AS m FROM (SELECT TOP 12 ROW_NUMBER() OVER(ORDER BY(SELECT NULL)) AS n FROM sys.objects) x) months
          CROSS JOIN (SELECT TOP 31 ROW_NUMBER() OVER(ORDER BY(SELECT NULL)) AS d FROM sys.objects) days
          WHERE ISDATE('${year}' + RIGHT('0'+CAST(m AS VARCHAR),2) + RIGHT('0'+CAST(d AS VARCHAR),2)) = 1
        ) d
        CROSS JOIN SILVER_PATIENT_INFO p
        WHERE p.INDAT <= d.dt
          AND (p.OUTDAT >= d.dt OR p.OUTDAT IS NULL OR p.OUTDAT = '')
          AND p.INSUCLS NOT IN ('50')
          AND d.dt >= '${yearStart}' AND d.dt < '${yearEnd}'
      ) sub
      GROUP BY LEFT(dt, 6)
      ORDER BY ym
    `);
    return result.recordset;
  } catch (e) {
    console.log(`  입원일수 쿼리 실패: ${e.message}`);
    return [];
  }
}

async function main() {
  if (process.argv[2] === '--explore') {
    const pool = await sql.connect(sqlConfig);
    await explore(pool);
    await sql.close();
    process.exit(0);
  }

  const year = parseInt(process.argv[2]) || new Date().getFullYear();
  console.log(`📊 경영현황 동기화 시작 (${year}년)`);

  const pool = await sql.connect(sqlConfig);
  const updates = {};

  // ── 1. 월별 입원 매출 ──
  console.log('\n[입원 매출]');
  const inRows = await queryRevenue(pool, year, 'in');
  const inpatient = {};
  for (const r of inRows) {
    inpatient[r.ym] = { covered: r.covered, nonCovered: r.nonCovered, total: r.total };
    console.log(`  ${r.ym}: 급여 ${Math.round(r.covered/10000)}만 / 비급여 ${Math.round(r.nonCovered/10000)}만 / 합계 ${Math.round(r.total/10000)}만`);
  }
  updates[`directorStats/${year}/revenue/inpatient`] = inpatient;

  // ── 2. 월별 외래 매출 ──
  console.log('\n[외래 매출]');
  const outRows = await queryRevenue(pool, year, 'out');
  const outpatient = {};
  for (const r of outRows) {
    outpatient[r.ym] = { covered: r.covered, nonCovered: r.nonCovered, total: r.total };
    console.log(`  ${r.ym}: 급여 ${Math.round(r.covered/10000)}만 / 비급여 ${Math.round(r.nonCovered/10000)}만 / 합계 ${Math.round(r.total/10000)}만`);
  }
  updates[`directorStats/${year}/revenue/outpatient`] = Object.keys(outpatient).length > 0 ? outpatient : null;

  // ── 3. 입원일수 ──
  console.log('\n[입원일수]');
  const bedDayRows = await queryBedDays(pool, year);
  const bedDays = {};
  for (const r of bedDayRows) {
    bedDays[r.ym] = r.bedDays;
    console.log(`  ${r.ym}: ${r.bedDays}일`);
  }
  updates[`directorStats/${year}/revenue/bedDays`] = Object.keys(bedDays).length > 0 ? bedDays : null;

  // ── 4. 일자별 병상가동률 (오늘까지만) ──
  console.log('\n[병상 가동률]');
  const today = new Date();
  const todayStr = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
  const lastMonth = year === today.getFullYear() ? today.getMonth() + 1 : 12;

  for (let m = 1; m <= lastMonth; m++) {
    const ym = `${year}${String(m).padStart(2, '0')}`;
    const daysInMonth = new Date(year, m, 0).getDate();
    // 이번 달이면 오늘까지만, 아니면 전체
    const lastDay = (year === today.getFullYear() && m === today.getMonth() + 1)
      ? today.getDate() : daysInMonth;

    try {
      const result = await pool.request().query(`
        SELECT d.dt, COUNT(p.CHARTNO) AS occupied
        FROM (
          SELECT '${ym}' + RIGHT('0' + CAST(n AS VARCHAR), 2) AS dt
          FROM (SELECT TOP ${lastDay} ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
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
      console.log(`  ${m}월: 평균 가동률 ${avgRate}% (${result.recordset.length}일, ~${lastDay}일)`);
    } catch (e) {
      console.log(`  ${m}월 가동률 조회 실패: ${e.message}`);
    }
  }

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
