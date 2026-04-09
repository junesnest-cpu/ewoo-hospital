/**
 * 병상가동률 정밀 진단 — 2026년 3월 1일 (정답 52명)
 * 초과 환자 식별 + 다양한 쿼리 조합 시도
 */
require('dotenv').config({ path: '.env.local' });
const sql = require('mssql');

const sqlConfig = {
  user: process.env.EMR_DB_USER,
  password: process.env.EMR_DB_PASSWORD,
  database: 'BrWonmu',
  server: '192.168.0.253',
  port: 1433,
  options: { encrypt: false, trustServerCertificate: true },
  requestTimeout: 60000,
};

const EXPECTED = [52,56,56,54,58,54,50,53,53,57,59,60,59,54,52,55,61,57,60,61,59,58,60,55,56,55,56,54,53,51,52];

async function main() {
  const pool = await sql.connect(sqlConfig);

  console.log('═'.repeat(60));
  console.log('  병상가동률 정밀 진단');
  console.log('═'.repeat(60));

  // ── 1. 3/1 기준: 쿼리 56명 vs 정답 52명 → 초과 4명 식별 ──
  console.log('\n[1] 3/1 재원 환자 전체 (SILVER_PATIENT_INFO):');
  const r1 = await pool.request().query(`
    SELECT p.CHARTNO, p.INDAT, p.OUTDAT, p.INSUCLS
    FROM SILVER_PATIENT_INFO p
    WHERE p.INDAT <= '20260301'
      AND (p.OUTDAT >= '20260301' OR p.OUTDAT IS NULL OR p.OUTDAT = '')
    ORDER BY p.INDAT
  `);
  console.log(`  총 ${r1.recordset.length}명`);

  // ── 2. OUTDAT = '20260301' (당일 퇴원) 환자 ──
  console.log('\n[2] 3/1 당일 퇴원자 (OUTDAT=20260301):');
  const discharged = r1.recordset.filter(r => r.OUTDAT?.trim() === '20260301');
  console.log(`  ${discharged.length}명: ${discharged.map(r => r.CHARTNO.trim()).join(', ')}`);

  // ── 3. OUTDAT > dt (퇴원일 제외) vs OUTDAT >= dt (퇴원일 포함) ──
  console.log('\n[3] 3월 전체: OUTDAT > dt (퇴원일 제외) 시도:');
  let match1 = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = `202603${String(d).padStart(2, '0')}`;
    const r = await pool.request().query(`
      SELECT COUNT(*) AS cnt FROM SILVER_PATIENT_INFO p
      WHERE p.INDAT <= '${dt}'
        AND (p.OUTDAT > '${dt}' OR p.OUTDAT IS NULL OR p.OUTDAT = '')
    `);
    const ok = r.recordset[0].cnt === EXPECTED[d-1];
    if (ok) match1++;
    if (!ok) console.log(`  3/${d}: 쿼리=${r.recordset[0].cnt} 정답=${EXPECTED[d-1]} ${ok?'✅':'❌ '+( r.recordset[0].cnt-EXPECTED[d-1])}`);
  }
  console.log(`  일치: ${match1}/31일 ${match1===31?'✅ 전체 일치!':''}`);

  // ── 4. Wiinf 기반: day_care 제외 시도 ──
  console.log('\n[4] Wiinf day_care 값 분포 (3/1 재원):');
  try {
    const r4 = await pool.request().query(`
      SELECT iinf_day_care, COUNT(*) AS cnt
      FROM Wiinf
      WHERE iinf_in_date <= '20260301'
        AND (iinf_out_date >= '20260301' OR iinf_out_date IS NULL OR iinf_out_date = '' OR iinf_out_date = '        ')
      GROUP BY iinf_day_care
    `);
    r4.recordset.forEach(r => console.log(`  day_care=${r.iinf_day_care}: ${r.cnt}명`));

    // day_care 제외
    console.log('\n  day_care != 0 제외 후:');
    const r4b = await pool.request().query(`
      SELECT COUNT(*) AS cnt FROM Wiinf
      WHERE iinf_in_date <= '20260301'
        AND (iinf_out_date >= '20260301' OR iinf_out_date IS NULL OR iinf_out_date = '' OR iinf_out_date = '        ')
        AND (iinf_day_care = 0 OR iinf_day_care IS NULL)
    `);
    console.log(`  재원수: ${r4b.recordset[0].cnt}명 ${r4b.recordset[0].cnt===52?'✅ 일치!':'❌'}`);
  } catch(e) { console.log(`  실패: ${e.message}`); }

  // ── 5. Wiinf: out_date > dt (퇴원일 제외) ──
  console.log('\n[5] Wiinf: out_date > dt (퇴원일 제외):');
  let match5 = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = `202603${String(d).padStart(2, '0')}`;
    const r = await pool.request().query(`
      SELECT COUNT(*) AS cnt FROM Wiinf
      WHERE iinf_in_date <= '${dt}'
        AND (iinf_out_date > '${dt}' OR iinf_out_date IS NULL OR iinf_out_date = '' OR iinf_out_date = '        ')
    `);
    const ok = r.recordset[0].cnt === EXPECTED[d-1];
    if (ok) match5++;
    if (!ok && d <= 5) console.log(`  3/${d}: 쿼리=${r.recordset[0].cnt} 정답=${EXPECTED[d-1]} ${ok?'✅':'❌ '+(r.recordset[0].cnt-EXPECTED[d-1])}`);
  }
  console.log(`  일치: ${match5}/31일 ${match5===31?'✅ 전체 일치!':''}`);

  // ── 6. Wiinf: out_date > dt + day_care=0 ──
  console.log('\n[6] Wiinf: out_date > dt + day_care=0:');
  let match6 = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = `202603${String(d).padStart(2, '0')}`;
    const r = await pool.request().query(`
      SELECT COUNT(*) AS cnt FROM Wiinf
      WHERE iinf_in_date <= '${dt}'
        AND (iinf_out_date > '${dt}' OR iinf_out_date IS NULL OR iinf_out_date = '' OR iinf_out_date = '        ')
        AND (iinf_day_care = 0 OR iinf_day_care IS NULL)
    `);
    const ok = r.recordset[0].cnt === EXPECTED[d-1];
    if (ok) match6++;
    if (!ok && d <= 5) console.log(`  3/${d}: 쿼리=${r.recordset[0].cnt} 정답=${EXPECTED[d-1]} ${ok?'✅':'❌ '+(r.recordset[0].cnt-EXPECTED[d-1])}`);
  }
  console.log(`  일치: ${match6}/31일 ${match6===31?'✅ 전체 일치!':''}`);

  // ── 7. SILVER: OUTDAT > dt ──
  console.log('\n[7] SILVER_PATIENT_INFO: OUTDAT > dt:');
  let match7 = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = `202603${String(d).padStart(2, '0')}`;
    const r = await pool.request().query(`
      SELECT COUNT(*) AS cnt FROM SILVER_PATIENT_INFO p
      WHERE p.INDAT <= '${dt}'
        AND (p.OUTDAT > '${dt}' OR p.OUTDAT IS NULL OR p.OUTDAT = '')
        AND p.INSUCLS NOT IN ('50','100')
    `);
    const ok = r.recordset[0].cnt === EXPECTED[d-1];
    if (ok) match7++;
    if (!ok && d <= 5) console.log(`  3/${d}: 쿼리=${r.recordset[0].cnt} 정답=${EXPECTED[d-1]} ${ok?'✅':'❌ '+(r.recordset[0].cnt-EXPECTED[d-1])}`);
  }
  console.log(`  일치: ${match7}/31일 ${match7===31?'✅ 전체 일치!':''}`);

  // ── 8. Wbhis 기반: 해당 일자에 실제 병상배정 기록 ──
  console.log('\n[8] Wbhis 기반 (병상배정 이력):');
  try {
    // bhis_date가 배정일이면, 해당일 이전 가장 최근 배정 기록을 기반으로 카운트
    const r8 = await pool.request().query(`
      SELECT COUNT(DISTINCT bhis_cham) AS cnt
      FROM Wbhis
      WHERE bhis_date <= '20260301'
    `);
    console.log(`  3/1 이전 병상배정 이력 있는 환자: ${r8.recordset[0].cnt}명`);
  } catch(e) { console.log(`  실패: ${e.message}`); }

  console.log('\n' + '═'.repeat(60));
  console.log('✅ 표시된 조합을 syncDirectorStats.js에 반영합니다.');
  console.log('═'.repeat(60));

  await sql.close();
  process.exit(0);
}

main().catch(err => {
  console.error('❌', err.message);
  sql.close().catch(() => {});
  process.exit(1);
});
