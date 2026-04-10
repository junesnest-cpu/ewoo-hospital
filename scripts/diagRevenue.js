/**
 * 급여총액 진단 — 2026년 1~4월 EMR 데이터 확인
 * 기대값: 1월 78,656,090 / 2월 77,732,540 / 3월 98,857,520 / 4월 34,812,840
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
  requestTimeout: 120000,
};

const EXPECTED = { '202601': 78656090, '202602': 77732540, '202603': 98857520, '202604': 34812840 };
const chk = (v, ym) => EXPECTED[ym] && Number(v) === EXPECTED[ym] ? ' ✅' : '';

async function main() {
  const pool = await sql.connect(sqlConfig);

  console.log('═'.repeat(60));
  console.log('  급여총액 진단 (2026년 1~4월)');
  console.log('═'.repeat(60));

  const months = ['202601','202602','202603','202604'];

  // 1. Wisums 월별
  console.log('\n[1] Wisums (입원 합산) 월별');
  for (const ym of months) {
    const r = await pool.request().query(`
      SELECT
        SUM(CAST(isums_chamt AS bigint)) AS ch,
        SUM(CAST(isums_iramt AS bigint)) AS ir,
        SUM(CAST(isums_biamt AS bigint)) AS bi,
        SUM(CAST(isums_mtamt AS bigint)) AS mt,
        SUM(CAST(isums_bohd_amt AS bigint)) AS bohd,
        SUM(CAST(isums_aidamt AS bigint)) AS aid
      FROM Wisums WHERE LEFT(isums_date, 6) = '${ym}'
    `);
    const s = r.recordset[0];
    const ch = Number(s.ch), ir = Number(s.ir), bi = Number(s.bi),
          mt = Number(s.mt), bohd = Number(s.bohd), aid = Number(s.aid);
    console.log(`  ${ym}: 기대=${EXPECTED[ym]?.toLocaleString()}`);
    console.log(`    chamt(청구)=${ch.toLocaleString()}${chk(ch,ym)}  iramt=${ir.toLocaleString()}${chk(ir,ym)}  biamt=${bi.toLocaleString()}${chk(bi,ym)}`);
    console.log(`    mtamt=${mt.toLocaleString()}${chk(mt,ym)}  bohd=${bohd.toLocaleString()}${chk(bohd,ym)}  aid=${aid.toLocaleString()}${chk(aid,ym)}`);
    console.log(`    bohd+ir=${(bohd+ir).toLocaleString()}${chk(bohd+ir,ym)}  ch-bi=${(ch-bi).toLocaleString()}${chk(ch-bi,ym)}`);
    console.log(`    bohd+mt=${(bohd+mt).toLocaleString()}${chk(bohd+mt,ym)}  bohd+aid=${(bohd+aid).toLocaleString()}${chk(bohd+aid,ym)}`);
  }

  // 2. Wiadd 월별
  console.log('\n[2] Wiadd (입원 수가) 월별');
  for (const ym of months) {
    const r = await pool.request().query(`
      SELECT
        SUM(CAST(iadd_amt AS bigint)) AS amt,
        SUM(CAST(iadd_i_allamt AS bigint)) AS i_all,
        SUM(CAST(iadd_ii_allamt AS bigint)) AS ii_all,
        SUM(CAST(iadd_i_iramt AS bigint)) AS i_ir,
        SUM(CAST(iadd_i_selamt AS bigint)) AS i_sel,
        SUM(CAST(iadd_i_mtamt AS bigint)) AS i_mt
      FROM Wiadd WHERE LEFT(iadd_date, 6) = '${ym}'
    `);
    const a = r.recordset[0];
    const amt = Number(a.amt), i_all = Number(a.i_all), ii_all = Number(a.ii_all),
          i_ir = Number(a.i_ir), i_sel = Number(a.i_sel), i_mt = Number(a.i_mt);
    console.log(`  ${ym}: 기대=${EXPECTED[ym]?.toLocaleString()}`);
    console.log(`    amt=${amt.toLocaleString()}${chk(amt,ym)}  i_all=${i_all.toLocaleString()}${chk(i_all,ym)}  ii_all=${ii_all.toLocaleString()}${chk(ii_all,ym)}`);
    console.log(`    i_ir=${i_ir.toLocaleString()}${chk(i_ir,ym)}  i_sel=${i_sel.toLocaleString()}${chk(i_sel,ym)}  i_mt=${i_mt.toLocaleString()}${chk(i_mt,ym)}`);
    console.log(`    amt-i_sel=${(amt-i_sel).toLocaleString()}${chk(amt-i_sel,ym)}  i_all-i_sel=${(i_all-i_sel).toLocaleString()}${chk(i_all-i_sel,ym)}`);
  }

  // 3. Wiadds 월별
  console.log('\n[3] Wiadds (입원 가산 합산) 월별');
  for (const ym of months) {
    try {
      const r = await pool.request().query(`
        SELECT
          SUM(CAST(iadds_i_allamt AS bigint)) AS i_all,
          SUM(CAST(iadds_ii_allamt AS bigint)) AS ii_all,
          SUM(CAST(iadds_i_iramt AS bigint)) AS i_ir,
          SUM(CAST(iadds_i_selamt AS bigint)) AS i_sel,
          SUM(CAST(iadds_i_mtamt AS bigint)) AS i_mt,
          SUM(CAST(iadds_i_etcamt AS bigint)) AS i_etc
        FROM Wiadds WHERE LEFT(iadds_date, 6) = '${ym}'
      `);
      const a = r.recordset[0];
      const i_all = Number(a.i_all), i_sel = Number(a.i_sel), i_ir = Number(a.i_ir);
      console.log(`  ${ym}: 기대=${EXPECTED[ym]?.toLocaleString()}`);
      console.log(`    i_all=${i_all.toLocaleString()}${chk(i_all,ym)}  i_sel=${i_sel.toLocaleString()}${chk(i_sel,ym)}`);
      console.log(`    i_all-i_sel=${(i_all-i_sel).toLocaleString()}${chk(i_all-i_sel,ym)}`);
      console.log(`    i_ir=${i_ir.toLocaleString()}${chk(i_ir,ym)}  i_mt=${Number(a.i_mt).toLocaleString()}${chk(Number(a.i_mt),ym)}`);
    } catch(e) { console.log(`  ${ym}: 실패 ${e.message}`); }
  }

  // 4. 핵심 검증: Wiadd.i_mtamt + Woadd.i_mtamt = 급여총액?
  console.log('\n[4] Wiadd.i_mt + Woadd.i_mt = 급여총액?');
  for (const ym of months) {
    const inR = await pool.request().query(`
      SELECT SUM(CAST(iadd_i_mtamt AS bigint)) AS i_mt
      FROM Wiadd WHERE LEFT(iadd_date, 6) = '${ym}'
    `);
    let outMt = 0;
    try {
      const outR = await pool.request().query(`
        SELECT SUM(CAST(oadd_i_mtamt AS bigint)) AS i_mt
        FROM Woadd WHERE LEFT(oadd_date, 6) = '${ym}'
      `);
      outMt = Number(outR.recordset[0]?.i_mt || 0);
    } catch(e) {
      // oadd_i_mtamt 없으면 컬럼 확인
      const cols = await pool.request().query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'Woadd' AND COLUMN_NAME LIKE '%mt%'
      `);
      console.log(`  Woadd mt 컬럼: ${cols.recordset.map(c=>c.COLUMN_NAME).join(', ')}`);
    }
    const inMt = Number(inR.recordset[0]?.i_mt || 0);
    const total = inMt + outMt;
    console.log(`  ${ym}: 입원=${inMt.toLocaleString()} + 외래=${outMt.toLocaleString()} = ${total.toLocaleString()}${chk(total,ym)}`);
  }

  // 5. Wiadd / Woadd 전체 컬럼 확인
  console.log('\n[5] Wiadd / Woadd 컬럼 확인');
  try {
    const inCols = await pool.request().query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Wiadd' ORDER BY ORDINAL_POSITION`);
    console.log('  Wiadd:', inCols.recordset.map(c=>c.COLUMN_NAME).join(', '));
    const outCols = await pool.request().query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='Woadd' ORDER BY ORDINAL_POSITION`);
    console.log('  Woadd:', outCols.recordset.map(c=>c.COLUMN_NAME).join(', '));
  } catch(e) { console.log('  실패:', e.message); }

  // 6. Wiadds + Woadds의 i_mtamt
  console.log('\n[6] Wiadds.i_mt + Woadds.i_mt');
  for (const ym of months) {
    const inR = await pool.request().query(`
      SELECT SUM(CAST(iadds_i_mtamt AS bigint)) AS i_mt FROM Wiadds WHERE LEFT(iadds_date, 6) = '${ym}'
    `);
    let outMt = 0;
    try {
      const outR = await pool.request().query(`
        SELECT SUM(CAST(oadds_i_mtamt AS bigint)) AS i_mt FROM Woadds WHERE LEFT(oadds_date, 6) = '${ym}'
      `);
      outMt = Number(outR.recordset[0]?.i_mt||0);
    } catch(e) { outMt = 0; }
    const inMt = Number(inR.recordset[0]?.i_mt||0);
    console.log(`  ${ym}: ${inMt.toLocaleString()} + ${outMt.toLocaleString()} = ${(inMt+outMt).toLocaleString()}${chk(inMt+outMt,ym)}`);
  }

  // 7. Wiadd.i_mt + Woadd.i_mt + Wiadd.i_all + Woadd.i_all
  console.log('\n[7] i_mt + i_all 합산');
  for (const ym of months) {
    const inR = await pool.request().query(`
      SELECT SUM(CAST(iadd_i_mtamt AS bigint)) AS i_mt, SUM(CAST(iadd_i_allamt AS bigint)) AS i_all
      FROM Wiadd WHERE LEFT(iadd_date, 6) = '${ym}'
    `);
    const outR = await pool.request().query(`
      SELECT SUM(CAST(oadd_i_mtamt AS bigint)) AS i_mt, SUM(CAST(oadd_i_allamt AS bigint)) AS i_all
      FROM Woadd WHERE LEFT(oadd_date, 6) = '${ym}'
    `);
    const total = Number(inR.recordset[0]?.i_mt||0) + Number(outR.recordset[0]?.i_mt||0)
                + Number(inR.recordset[0]?.i_all||0) + Number(outR.recordset[0]?.i_all||0);
    console.log(`  ${ym}: ${total.toLocaleString()}${chk(total,ym)}`);
  }

  // 8. Wiadd + Woadd 전체 금액 필드 합산 (ii_mt, under 포함)
  console.log('\n[8] Wiadd+Woadd 전체 금액 필드 합산');
  for (const ym of months) {
    const inR = await pool.request().query(`
      SELECT
        SUM(CAST(iadd_i_mtamt AS bigint)) AS i_mt,
        SUM(CAST(iadd_ii_mtamt AS bigint)) AS ii_mt,
        SUM(CAST(iadd_i_allamt AS bigint)) AS i_all,
        SUM(CAST(iadd_ii_allamt AS bigint)) AS ii_all,
        SUM(CAST(iadd_i_iramt AS bigint)) AS i_ir,
        SUM(CAST(iadd_ii_iramt AS bigint)) AS ii_ir,
        SUM(CAST(iadd_under_i_mramt AS bigint)) AS u_i_mr,
        SUM(CAST(iadd_under_i_iramt AS bigint)) AS u_i_ir,
        SUM(CAST(iadd_under_ii_mramt AS bigint)) AS u_ii_mr,
        SUM(CAST(iadd_under_ii_iramt AS bigint)) AS u_ii_ir
      FROM Wiadd WHERE LEFT(iadd_date, 6) = '${ym}'
    `);
    const outR = await pool.request().query(`
      SELECT
        SUM(CAST(oadd_i_mtamt AS bigint)) AS i_mt,
        SUM(CAST(oadd_ii_mtamt AS bigint)) AS ii_mt,
        SUM(CAST(oadd_i_allamt AS bigint)) AS i_all,
        SUM(CAST(oadd_ii_allamt AS bigint)) AS ii_all,
        SUM(CAST(oadd_i_iramt AS bigint)) AS i_ir,
        SUM(CAST(oadd_ii_iramt AS bigint)) AS ii_ir,
        SUM(CAST(oadd_under_i_mramt AS bigint)) AS u_i_mr,
        SUM(CAST(oadd_under_i_iramt AS bigint)) AS u_i_ir,
        SUM(CAST(oadd_under_ii_mramt AS bigint)) AS u_ii_mr,
        SUM(CAST(oadd_under_ii_iramt AS bigint)) AS u_ii_ir
      FROM Woadd WHERE LEFT(oadd_date, 6) = '${ym}'
    `);
    const i = inR.recordset[0], o = outR.recordset[0];
    const n = v => Number(v||0);

    const imt = n(i.i_mt)+n(o.i_mt), iimt = n(i.ii_mt)+n(o.ii_mt);
    const iall = n(i.i_all)+n(o.i_all), iiall = n(i.ii_all)+n(o.ii_all);
    const iir = n(i.i_ir)+n(o.i_ir), iiir = n(i.ii_ir)+n(o.ii_ir);
    const uimr = n(i.u_i_mr)+n(o.u_i_mr), uiir = n(i.u_i_ir)+n(o.u_i_ir);
    const uiimr = n(i.u_ii_mr)+n(o.u_ii_mr), uiiir = n(i.u_ii_ir)+n(o.u_ii_ir);

    console.log(`  ${ym}: 기대=${EXPECTED[ym]?.toLocaleString()}`);
    console.log(`    i_mt=${imt.toLocaleString()} ii_mt=${iimt.toLocaleString()} i_all=${iall.toLocaleString()} ii_all=${iiall.toLocaleString()}`);
    console.log(`    i_ir=${iir.toLocaleString()} ii_ir=${iiir.toLocaleString()}`);
    console.log(`    under: i_mr=${uimr.toLocaleString()} i_ir=${uiir.toLocaleString()} ii_mr=${uiimr.toLocaleString()} ii_ir=${uiiir.toLocaleString()}`);

    // 다양한 조합 시도
    const combos = [
      ['i_mt+ii_mt', imt+iimt],
      ['i_mt+ii_mt+i_all+ii_all', imt+iimt+iall+iiall],
      ['i_mt+i_all+u_i_mr+u_i_ir', imt+iall+uimr+uiir],
      ['i_mt+ii_mt+i_all+u_i_mr', imt+iimt+iall+uimr],
      ['i_mt+i_ir', imt+iir],
    ];
    for (const [label, val] of combos) {
      console.log(`    ${label.padEnd(35)} = ${val.toLocaleString()}${chk(val,ym)}`);
    }
  }

  console.log('\n' + '═'.repeat(60));
  await sql.close();
  process.exit(0);
}

main().catch(err => { console.error('ERR:', err.message); sql.close().catch(()=>{}); process.exit(1); });
