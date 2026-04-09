/**
 * 매출 계산 2차 진단 — 2025년 1월 기준
 * 정답: 입원 453,519,110 / 외래 11,903,460 / 공단 86,893,960 / 본부금 17,310,870
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

const EX = { inTotal: 453519110, outTotal: 11903460, inGongdan: 86893960, inBonbu: 17310870 };
const chk = (v, ex) => Number(v) === ex ? '  ✅ 일치!' : '';

async function main() {
  const pool = await sql.connect(sqlConfig);
  const ym = '202501';

  console.log('═'.repeat(60));
  console.log('  2차 매출 진단 (2025년 1월)');
  console.log(`  정답: 입원=${EX.inTotal.toLocaleString()} 외래=${EX.outTotal.toLocaleString()}`);
  console.log(`        공단=${EX.inGongdan.toLocaleString()} 본부금=${EX.inBonbu.toLocaleString()}`);
  console.log('═'.repeat(60));

  // ── 1. Wiadds (입원 가산 합산) ──
  console.log('\n[1] Wiadds (입원 가산 합산):');
  try {
    const cols = await pool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'Wiadds' ORDER BY ORDINAL_POSITION
    `);
    console.log('  컬럼:', cols.recordset.map(c => c.COLUMN_NAME).join(', '));

    const r = await pool.request().query(`
      SELECT
        SUM(CAST(iadds_i_allamt AS bigint)) AS i_all,
        SUM(CAST(iadds_ii_allamt AS bigint)) AS ii_all,
        SUM(CAST(iadds_i_allamt AS bigint) + CAST(iadds_ii_allamt AS bigint)) AS total_all,
        SUM(CAST(iadds_i_iramt AS bigint)) AS i_ir,
        SUM(CAST(iadds_ii_iramt AS bigint)) AS ii_ir,
        SUM(CAST(iadds_i_mtamt AS bigint)) AS i_mt,
        SUM(CAST(iadds_ii_mtamt AS bigint)) AS ii_mt,
        SUM(CAST(iadds_i_selamt AS bigint)) AS i_sel,
        SUM(CAST(iadds_ii_selamt AS bigint)) AS ii_sel,
        SUM(CAST(iadds_i_etcamt AS bigint)) AS i_etc,
        SUM(CAST(iadds_ii_etcamt AS bigint)) AS ii_etc
      FROM Wiadds WHERE LEFT(iadds_date, 6) = '${ym}'
    `);
    const a = r.recordset[0];
    console.log(`  i_allamt                = ${Number(a.i_all).toLocaleString()}${chk(a.i_all, EX.inTotal)}`);
    console.log(`  ii_allamt               = ${Number(a.ii_all).toLocaleString()}${chk(a.ii_all, EX.inTotal)}`);
    console.log(`  i_all + ii_all          = ${Number(a.total_all).toLocaleString()}${chk(a.total_all, EX.inTotal)}`);
    console.log(`  i_iramt                 = ${Number(a.i_ir).toLocaleString()}${chk(a.i_ir, EX.inBonbu)}`);
    console.log(`  ii_iramt                = ${Number(a.ii_ir).toLocaleString()}`);
    console.log(`  i_ir + ii_ir            = ${(Number(a.i_ir)+Number(a.ii_ir)).toLocaleString()}${chk(Number(a.i_ir)+Number(a.ii_ir), EX.inBonbu)}`);
    console.log(`  i_mtamt                 = ${Number(a.i_mt).toLocaleString()}`);
    console.log(`  ii_mtamt                = ${Number(a.ii_mt).toLocaleString()}`);
    console.log(`  i_selamt                = ${Number(a.i_sel).toLocaleString()}`);
    console.log(`  i_etcamt                = ${Number(a.i_etc).toLocaleString()}`);

    // 조합 시도
    const combos = [
      { l: 'i_all + i_sel', v: Number(a.i_all) + Number(a.i_sel) },
      { l: 'i_all + i_sel + i_etc', v: Number(a.i_all) + Number(a.i_sel) + Number(a.i_etc) },
      { l: 'i_all + ii_all + i_sel + ii_sel', v: Number(a.total_all) + Number(a.i_sel) + Number(a.ii_sel) },
    ];
    combos.forEach(c => console.log(`  ${c.l.padEnd(30)} = ${c.v.toLocaleString()}${chk(c.v, EX.inTotal)}`));
  } catch(e) { console.log(`  실패: ${e.message}`); }

  // ── 2. Wiadd (입원 가산 개별) ──
  console.log('\n[2] Wiadd (입원 가산 개별):');
  try {
    const cols = await pool.request().query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'Wiadd' ORDER BY ORDINAL_POSITION
    `);
    console.log('  컬럼:', cols.recordset.map(c => c.COLUMN_NAME).join(', '));

    const r = await pool.request().query(`
      SELECT
        SUM(CAST(iadd_amt AS bigint)) AS amt,
        SUM(CAST(iadd_i_allamt AS bigint)) AS i_all,
        SUM(CAST(iadd_ii_allamt AS bigint)) AS ii_all,
        SUM(CAST(iadd_i_allamt AS bigint) + CAST(iadd_ii_allamt AS bigint)) AS total_all,
        SUM(CAST(iadd_i_iramt AS bigint)) AS i_ir,
        SUM(CAST(iadd_i_mtamt AS bigint)) AS i_mt,
        SUM(CAST(iadd_i_selamt AS bigint)) AS i_sel
      FROM Wiadd WHERE LEFT(iadd_date, 6) = '${ym}'
    `);
    const a = r.recordset[0];
    console.log(`  iadd_amt                = ${Number(a.amt).toLocaleString()}${chk(a.amt, EX.inTotal)}`);
    console.log(`  i_allamt                = ${Number(a.i_all).toLocaleString()}${chk(a.i_all, EX.inTotal)}`);
    console.log(`  ii_allamt               = ${Number(a.ii_all).toLocaleString()}`);
    console.log(`  i_all + ii_all          = ${Number(a.total_all).toLocaleString()}${chk(a.total_all, EX.inTotal)}`);
    console.log(`  i_iramt                 = ${Number(a.i_ir).toLocaleString()}${chk(a.i_ir, EX.inBonbu)}`);
    console.log(`  i_mtamt                 = ${Number(a.i_mt).toLocaleString()}`);
    console.log(`  iadd_amt + i_sel        = ${(Number(a.amt)+Number(a.i_sel)).toLocaleString()}${chk(Number(a.amt)+Number(a.i_sel), EX.inTotal)}`);
  } catch(e) { console.log(`  실패: ${e.message}`); }

  // ── 3. Wisums (입원 합산) 월별 ──
  console.log('\n[3] Wisums 월별 합계:');
  try {
    const r = await pool.request().query(`
      SELECT
        SUM(CAST(isums_mtamt AS bigint)) AS mt,
        SUM(CAST(isums_chamt AS bigint)) AS ch,
        SUM(CAST(isums_iramt AS bigint)) AS ir,
        SUM(CAST(isums_biamt AS bigint)) AS bi,
        SUM(CAST(isums_bohd_amt AS bigint)) AS bohd,
        SUM(CAST(isums_aidamt AS bigint)) AS aid,
        SUM(CAST(isums_mtamt AS bigint) + CAST(isums_biamt AS bigint)) AS mt_bi,
        SUM(CAST(isums_chamt AS bigint) + CAST(isums_biamt AS bigint)) AS ch_bi,
        SUM(CAST(isums_chamt AS bigint) + CAST(isums_biamt AS bigint) + CAST(isums_mtamt AS bigint)) AS ch_bi_mt
      FROM Wisums WHERE LEFT(isums_date, 6) = '${ym}'
    `);
    const s = r.recordset[0];
    console.log(`  isums_mtamt (본인부담)   = ${Number(s.mt).toLocaleString()}`);
    console.log(`  isums_chamt (청구)       = ${Number(s.ch).toLocaleString()}`);
    console.log(`  isums_iramt (일부본인)   = ${Number(s.ir).toLocaleString()}${chk(s.ir, EX.inBonbu)}`);
    console.log(`  isums_biamt (비급여)     = ${Number(s.bi).toLocaleString()}`);
    console.log(`  isums_bohd_amt (공단)    = ${Number(s.bohd).toLocaleString()}${chk(s.bohd, EX.inGongdan)}`);
    console.log(`  isums_aidamt (의료급여)  = ${Number(s.aid).toLocaleString()}`);
    console.log(`  mt + bi                 = ${Number(s.mt_bi).toLocaleString()}${chk(s.mt_bi, EX.inTotal)}`);
    console.log(`  ch + bi                 = ${Number(s.ch_bi).toLocaleString()}${chk(s.ch_bi, EX.inTotal)}`);
    console.log(`  ch + bi + mt            = ${Number(s.ch_bi_mt).toLocaleString()}${chk(s.ch_bi_mt, EX.inTotal)}`);
  } catch(e) { console.log(`  실패: ${e.message}`); }

  // ── 4. Tisums (임시 합산) ──
  console.log('\n[4] Tisums:');
  try {
    const cols = await pool.request().query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'Tisums' ORDER BY ORDINAL_POSITION
    `);
    console.log('  컬럼:', cols.recordset.map(c => c.COLUMN_NAME).join(', '));

    const r = await pool.request().query(`
      SELECT
        SUM(CAST(tisums_mtamt AS bigint)) AS mt,
        SUM(CAST(tisums_chamt AS bigint)) AS ch,
        SUM(CAST(tisums_iramt AS bigint)) AS ir,
        SUM(CAST(tisums_biamt AS bigint)) AS bi,
        SUM(CAST(tisums_bohd_amt AS bigint)) AS bohd,
        SUM(CAST(tisums_chamt AS bigint) + CAST(tisums_biamt AS bigint)) AS ch_bi
      FROM Tisums WHERE LEFT(tisums_date, 6) = '${ym}'
    `);
    const t = r.recordset[0];
    console.log(`  tisums_chamt (청구)      = ${Number(t.ch).toLocaleString()}`);
    console.log(`  tisums_biamt (비급여)    = ${Number(t.bi).toLocaleString()}`);
    console.log(`  tisums_bohd_amt (공단)   = ${Number(t.bohd).toLocaleString()}${chk(t.bohd, EX.inGongdan)}`);
    console.log(`  tisums_iramt (일부본인)  = ${Number(t.ir).toLocaleString()}${chk(t.ir, EX.inBonbu)}`);
    console.log(`  ch + bi                 = ${Number(t.ch_bi).toLocaleString()}${chk(t.ch_bi, EX.inTotal)}`);
  } catch(e) { console.log(`  실패: ${e.message}`); }

  // ── 5. Tiadds (임시 가산 합산) ──
  console.log('\n[5] Tiadds:');
  try {
    const r = await pool.request().query(`
      SELECT
        SUM(CAST(tiadds_i_allamt AS bigint)) AS i_all,
        SUM(CAST(tiadds_ii_allamt AS bigint)) AS ii_all,
        SUM(CAST(tiadds_i_allamt AS bigint) + CAST(tiadds_ii_allamt AS bigint)) AS total_all,
        SUM(CAST(tiadds_i_iramt AS bigint)) AS i_ir,
        SUM(CAST(tiadds_i_selamt AS bigint)) AS i_sel
      FROM Tiadds WHERE LEFT(tiadds_date, 6) = '${ym}'
    `);
    const a = r.recordset[0];
    console.log(`  i_allamt                = ${Number(a.i_all).toLocaleString()}${chk(a.i_all, EX.inTotal)}`);
    console.log(`  i_all + ii_all          = ${Number(a.total_all).toLocaleString()}${chk(a.total_all, EX.inTotal)}`);
    console.log(`  i_iramt                 = ${Number(a.i_ir).toLocaleString()}${chk(a.i_ir, EX.inBonbu)}`);
  } catch(e) { console.log(`  실패: ${e.message}`); }

  // ── 6. TempIdam (임시 입원 처방) ──
  console.log('\n[6] TempIdam:');
  try {
    const r = await pool.request().query(`
      SELECT
        SUM(CAST(tidam_allamt AS bigint)) AS allamt,
        SUM(CAST(tidam_amt AS bigint)) AS amt,
        SUM(CAST(tidam_gaamt AS bigint)) AS gaamt,
        SUM(CAST(tidam_iramt AS bigint)) AS iramt,
        SUM(CAST(tidam_selamt AS bigint)) AS selamt,
        SUM(CAST(tidam_mtamt AS bigint)) AS mtamt,
        SUM(CAST(tidam_etcamt AS bigint)) AS etcamt
      FROM TempIdam WHERE LEFT(tidam_date, 6) = '${ym}'
    `);
    const t = r.recordset[0];
    console.log(`  tidam_allamt             = ${Number(t.allamt).toLocaleString()}${chk(t.allamt, EX.inTotal)}`);
    console.log(`  tidam_amt                = ${Number(t.amt).toLocaleString()}`);
    console.log(`  tidam_gaamt              = ${Number(t.gaamt).toLocaleString()}`);
    console.log(`  tidam_iramt              = ${Number(t.iramt).toLocaleString()}${chk(t.iramt, EX.inBonbu)}`);
    console.log(`  tidam_selamt             = ${Number(t.selamt).toLocaleString()}`);
    console.log(`  tidam_mtamt              = ${Number(t.mtamt).toLocaleString()}`);
  } catch(e) { console.log(`  TempIdam 실패 (날짜컬럼?): ${e.message}`);
    // 날짜 컬럼 찾기
    try {
      const cols = await pool.request().query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='TempIdam' ORDER BY ORDINAL_POSITION`);
      console.log('  TempIdam 컬럼:', cols.recordset.map(c=>c.COLUMN_NAME).join(', '));
    } catch(e2) {}
  }

  // ── 7. 외래: Toadds ──
  console.log('\n[7] Toadds (외래 가산 합산):');
  try {
    const r = await pool.request().query(`
      SELECT
        SUM(CAST(toadds_i_allamt AS bigint)) AS i_all,
        SUM(CAST(toadds_i_allamt AS bigint) + CAST(toadds_ii_allamt AS bigint)) AS total_all,
        SUM(CAST(toadds_i_iramt AS bigint)) AS i_ir
      FROM Toadds WHERE LEFT(toadds_date, 6) = '${ym}'
    `);
    const a = r.recordset[0];
    console.log(`  i_allamt                = ${Number(a.i_all).toLocaleString()}${chk(a.i_all, EX.outTotal)}`);
    console.log(`  i_all + ii_all          = ${Number(a.total_all).toLocaleString()}${chk(a.total_all, EX.outTotal)}`);
  } catch(e) { console.log(`  실패: ${e.message}`); }

  // ── 8. 외래: Tosums ──
  console.log('\n[8] Tosums (외래 합산):');
  try {
    const r = await pool.request().query(`
      SELECT
        SUM(CAST(tosums_chamt AS bigint) + CAST(tosums_biamt AS bigint)) AS ch_bi,
        SUM(CAST(tosums_chamt AS bigint)) AS ch,
        SUM(CAST(tosums_biamt AS bigint)) AS bi,
        SUM(CAST(tosums_iramt AS bigint)) AS ir,
        SUM(CAST(tosums_bohd_amt AS bigint)) AS bohd
      FROM Tosums WHERE LEFT(tosums_date, 6) = '${ym}'
    `);
    const t = r.recordset[0];
    console.log(`  ch + bi                 = ${Number(t.ch_bi).toLocaleString()}${chk(t.ch_bi, EX.outTotal)}`);
    console.log(`  chamt                   = ${Number(t.ch).toLocaleString()}`);
    console.log(`  biamt                   = ${Number(t.bi).toLocaleString()}`);
    console.log(`  iramt (본인부담)        = ${Number(t.ir).toLocaleString()}`);
    console.log(`  bohd_amt (공단)         = ${Number(t.bohd).toLocaleString()}`);
  } catch(e) { console.log(`  실패: ${e.message}`); }

  console.log('\n' + '═'.repeat(60));
  console.log('✅ 표시된 조합으로 syncDirectorStats.js를 업데이트합니다.');
  console.log('═'.repeat(60));

  await sql.close();
  process.exit(0);
}

main().catch(err => {
  console.error('❌', err.message);
  sql.close().catch(() => {});
  process.exit(1);
});
