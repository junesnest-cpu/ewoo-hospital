/**
 * Wodam 컬럼 확인 + 치료항목 UNION 쿼리 테스트
 */
require('dotenv').config({ path: '.env.local' });
const sql = require('mssql');
const sqlConfig = {
  user: process.env.EMR_DB_USER, password: process.env.EMR_DB_PASSWORD,
  database: 'BrWonmu', server: '192.168.0.253', port: 1433,
  options: { encrypt: false, trustServerCertificate: true }, requestTimeout: 30000,
};

async function main() {
  const pool = await sql.connect(sqlConfig);

  // 1. Wodam 전체 컬럼
  console.log('[Wodam 컬럼]');
  const cols = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'Wodam' ORDER BY ORDINAL_POSITION
  `);
  cols.recordset.forEach(c => console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE})`));

  // 2. Wodam 샘플 (2025년 1월)
  console.log('\n[Wodam 2025-01 샘플]');
  try {
    const s = await pool.request().query(`SELECT TOP 3 * FROM Wodam WHERE LEFT(odam_date, 6) = '202501'`);
    if (s.recordset.length > 0) console.log(JSON.stringify(s.recordset[0], null, 2).slice(0, 600));
    else console.log('  데이터 없음');
  } catch(e) { console.log(`  실패: ${e.message}`); }

  // 3. UNION 쿼리 테스트
  console.log('\n[UNION 테스트 — 2025-01]');
  try {
    const r = await pool.request().query(`
      SELECT code, SUM(cnt) AS cnt FROM (
        SELECT RTRIM(idam_momn) AS code, COUNT(*) AS cnt
        FROM Widam WHERE LEFT(idam_date, 6) = '202501'
        GROUP BY RTRIM(idam_momn)
        UNION ALL
        SELECT RTRIM(odam_momn) AS code, COUNT(*) AS cnt
        FROM Wodam WHERE LEFT(odam_date, 6) = '202501'
        GROUP BY RTRIM(odam_momn)
      ) t GROUP BY code ORDER BY cnt DESC
    `);
    console.log(`  총 ${r.recordset.length}개 코드`);
    r.recordset.slice(0, 10).forEach(r => console.log(`  ${r.code}: ${r.cnt}건`));
  } catch(e) {
    console.log(`  UNION 실패: ${e.message}`);
    // odam_momn이 없으면 다른 컬럼명 시도
    console.log('\n  → odam_momn 없을 수 있음. momn 관련 컬럼 검색:');
    const mc = cols.recordset.filter(c => c.COLUMN_NAME.includes('momn') || c.COLUMN_NAME.includes('momm') || c.COLUMN_NAME.includes('code'));
    mc.forEach(c => console.log(`    ${c.COLUMN_NAME} (${c.DATA_TYPE})`));
  }

  // 4. Wodam에서 단독 집계
  console.log('\n[Wodam 단독 — 치료항목 코드 존재 확인]');
  try {
    const r = await pool.request().query(`
      SELECT TOP 10 RTRIM(odam_momn) AS code, COUNT(*) AS cnt
      FROM Wodam WHERE LEFT(odam_date, 6) = '202501'
      GROUP BY RTRIM(odam_momn) ORDER BY cnt DESC
    `);
    r.recordset.forEach(r => console.log(`  ${r.code}: ${r.cnt}건`));
  } catch(e) {
    console.log(`  odam_momn 실패: ${e.message}`);
    // momm 시도
    try {
      const r2 = await pool.request().query(`
        SELECT TOP 10 RTRIM(odam_momm) AS code, COUNT(*) AS cnt
        FROM Wodam WHERE LEFT(odam_date, 6) = '202501'
        GROUP BY RTRIM(odam_momm) ORDER BY cnt DESC
      `);
      console.log('  → odam_momm으로 성공:');
      r2.recordset.forEach(r => console.log(`    ${r.code}: ${r.cnt}건`));
    } catch(e2) { console.log(`  odam_momm도 실패: ${e2.message}`); }
  }

  await sql.close();
  process.exit(0);
}
main().catch(err => { console.error('❌', err.message); sql.close().catch(()=>{}); process.exit(1); });
