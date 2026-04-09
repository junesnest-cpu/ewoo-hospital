/**
 * EMR → Firebase 경영현황 동기화
 * - 월별 입원 매출: Wiadd.iadd_amt (입원 가산 개별 — 전체 진료비)
 * - 월별 외래 매출: Woadd.oadd_amt (외래 가산 개별 — 전체 진료비)
 * - 입원일수/공단수입/본부금: Wisums
 * - 일자별 병상가동률: SILVER_PATIENT_INFO (오늘까지만)
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
  requestTimeout: 60000,
};

const TOTAL_BEDS = 78;

// ── EMR 코드 → 치료항목 매핑 (syncTreatmentEMR.js와 동일) ──
const EMR_TO_PLAN = {
  'HZ272':       { id: 'hyperthermia', qtyField: 'times' },
  '662800041':   { id: 'zadaxin' },
  '654802341':   { id: 'imualpha' },
  '654802341-EW':{ id: 'imualpha' },
  '645906361':   { id: 'scion' },
  '053100040':   { id: 'iscador_m' }, '053100050': { id: 'iscador_m' },
  '053100010':   { id: 'iscador_m' }, '053100090': { id: 'iscador_m' },
  '053100100':   { id: 'iscador_m' },
  '053100060':   { id: 'iscador_q' }, '053100080': { id: 'iscador_q' },
  '053100030':   { id: 'iscador_q' }, '053100070': { id: 'iscador_q' },
  '645905861':   { id: 'glutathione' },
  '678900490':   { id: 'dramin', combo: true },
  '681100281':   { id: 'dramin', combo: true },
  '654004501':   { id: 'thioctic' },
  'JU11':        { id: 'myers1' },
  'JU12':        { id: 'myers2' },
  '654802311':   { id: 'selenium_iv' },
  '645906061':   { id: 'vitd' },
  'JU2':         { id: 'vitc', vitcG: 20 },
  'JU3':         { id: 'vitc', vitcG: 30 },
  'JU4':         { id: 'vitc', vitcG: 40 },
  'JU5':         { id: 'vitc', vitcG: 50 },
  '642105601':   { id: 'periview_360' },
  '642105603':   { id: 'periview_560' },
  'ML1':         { id: 'pain', qtyField: 'times' },
  'ML2':         { id: 'manip1', qtyField: 'times' },
  'ML3':         { id: 'manip2', qtyField: 'times' },
  'BM5001QF.':   { id: 'rejuderm', qtyField: 'dosage' },
  '655006870':   { id: 'meshima', qtyField: 'dosage' },
  '674800010':   { id: 'selenase_l', qtyField: 'dosage' },
  '659901380':   { id: 'selenase_t', qtyField: 'dosage' },
  '681100440':   { id: 'selenase_f', qtyField: 'dosage' },
};

// 치료항목 단가
const ITEM_PRICES = {
  hyperthermia:300000, zadaxin:350000, imualpha:300000, scion:250000,
  iscador_m:75000, iscador_q:80000, glutathione:60000, dramin:100000,
  thioctic:40000, gt:100000, myers1:70000, myers2:120000,
  selenium_iv:70000, vitd:50000, periview_360:100000, periview_560:150000,
  pain:200000, manip1:120000, manip2:200000,
  rejuderm:45000, meshima:18000, selenase_l:5000, selenase_t:5000, selenase_f:5000,
};

function vitcPrice(g) {
  if (g <= 0) return 0;
  const u = Math.ceil(g / 10);
  return u === 1 ? 30000 : 30000 + (u - 1) * 10000;
}

async function main() {
  const year = parseInt(process.argv[2]) || new Date().getFullYear();
  console.log(`📊 경영현황 동기화 시작 (${year}년)`);

  const pool = await sql.connect(sqlConfig);
  const updates = {};
  const yearStart = `${year}0101`;
  const yearEnd   = `${year + 1}0101`;

  // ── 1. 월별 입원 매출 (Wiadd) ──
  console.log('\n[입원 매출] Wiadd.iadd_amt');
  const inResult = await pool.request().query(`
    SELECT LEFT(iadd_date, 6) AS ym, SUM(CAST(iadd_amt AS bigint)) AS total
    FROM Wiadd
    WHERE iadd_date >= '${yearStart}' AND iadd_date < '${yearEnd}'
    GROUP BY LEFT(iadd_date, 6)
    ORDER BY ym
  `);
  const inpatient = {};
  for (const r of inResult.recordset) {
    inpatient[r.ym] = { total: Number(r.total) };
    console.log(`  ${r.ym}: ${Math.round(Number(r.total)/10000).toLocaleString()}만원`);
  }

  // ── 2. 공단수입/본부금 (Wisums) ──
  console.log('\n[공단수입/본부금] Wisums');
  try {
    const detailResult = await pool.request().query(`
      SELECT LEFT(isums_date, 6) AS ym,
        SUM(CAST(isums_chamt AS bigint)) AS chamt,
        SUM(CAST(isums_iramt AS bigint)) AS iramt,
        SUM(CAST(isums_biamt AS bigint)) AS biamt
      FROM Wisums
      WHERE isums_date >= '${yearStart}' AND isums_date < '${yearEnd}'
      GROUP BY LEFT(isums_date, 6)
      ORDER BY ym
    `);
    for (const r of detailResult.recordset) {
      if (inpatient[r.ym]) {
        // 공단수입 = 총진료비 - 일부본인부담 - 비급여 (역산)
        const total = inpatient[r.ym].total;
        const iramt = Number(r.iramt);  // 본부금 (일부본인부담)
        const biamt = Number(r.biamt);  // 비급여
        const gongdan = total - iramt - biamt;  // 공단수입 (역산)
        inpatient[r.ym].gongdan = gongdan > 0 ? gongdan : 0;
        inpatient[r.ym].bonbu = iramt;
        inpatient[r.ym].bigub = biamt;
        console.log(`  ${r.ym}: 공단=${Math.round(gongdan/10000)}만 본부금=${Math.round(iramt/10000)}만 비급여=${Math.round(biamt/10000)}만`);
      }
    }
  } catch (e) {
    console.log(`  공단/본부금 조회 실패: ${e.message}`);
  }
  updates[`directorStats/${year}/revenue/inpatient`] = inpatient;

  // ── 3. 월별 외래 매출 (Woadd) ──
  console.log('\n[외래 매출] Woadd.oadd_amt');
  let outpatient = {};
  try {
    const outResult = await pool.request().query(`
      SELECT LEFT(oadd_date, 6) AS ym, SUM(CAST(oadd_amt AS bigint)) AS total
      FROM Woadd
      WHERE oadd_date >= '${yearStart}' AND oadd_date < '${yearEnd}'
      GROUP BY LEFT(oadd_date, 6)
      ORDER BY ym
    `);
    for (const r of outResult.recordset) {
      outpatient[r.ym] = { total: Number(r.total) };
      console.log(`  ${r.ym}: ${Math.round(Number(r.total)/10000).toLocaleString()}만원`);
    }
  } catch (e) {
    console.log(`  Woadd 실패: ${e.message}`);
  }
  updates[`directorStats/${year}/revenue/outpatient`] = Object.keys(outpatient).length > 0 ? outpatient : null;

  // ── 4. 입원일수 (SILVER_PATIENT_INFO) ──
  console.log('\n[입원일수]');
  try {
    const bdResult = await pool.request().query(`
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
          AND (p.OUTDAT > d.dt OR p.OUTDAT IS NULL OR p.OUTDAT = '')
          AND p.INSUCLS NOT IN ('50','100')
          AND d.dt >= '${yearStart}' AND d.dt < '${yearEnd}'
      ) sub
      GROUP BY LEFT(dt, 6) ORDER BY ym
    `);
    const bedDays = {};
    for (const r of bdResult.recordset) {
      bedDays[r.ym] = r.bedDays;
      console.log(`  ${r.ym}: ${r.bedDays}일`);
    }
    updates[`directorStats/${year}/revenue/bedDays`] = Object.keys(bedDays).length > 0 ? bedDays : null;
  } catch (e) {
    console.log(`  입원일수 조회 실패: ${e.message}`);
  }

  // ── 5. 일자별 병상가동률 (오늘까지만) ──
  console.log('\n[병상 가동률]');
  const today = new Date();
  const todayStr = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
  const lastMonth = year === today.getFullYear() ? today.getMonth() + 1 : 12;

  for (let m = 1; m <= lastMonth; m++) {
    const ym = `${year}${String(m).padStart(2, '0')}`;
    const daysInMonth = new Date(year, m, 0).getDate();
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
          AND (p.OUTDAT > d.dt OR p.OUTDAT IS NULL OR p.OUTDAT = '')
          AND p.INSUCLS NOT IN ('50','100')
        GROUP BY d.dt ORDER BY d.dt
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
      console.log(`  ${m}월: 평균 ${avgRate}% (${result.recordset.length}일)`);
    } catch (e) {
      console.log(`  ${m}월 실패: ${e.message}`);
    }
  }

  // ── 6. 치료항목 월별 수량 (EMR Widam) ──
  console.log('\n[치료항목 월별 현황]');
  try {
    // EMR 코드 목록 (combo 제외한 고유 코드)
    const emrCodes = Object.keys(EMR_TO_PLAN).filter(c => !c.includes('-EW'));

    const treatResult = await pool.request().query(`
      SELECT LEFT(idam_date, 6) AS ym, RTRIM(idam_momn) AS code,
        COUNT(*) AS cnt,
        SUM(CAST(idam_times AS int)) AS total_times,
        SUM(CAST(idam_dosage AS float)) AS total_dosage
      FROM Widam
      WHERE idam_date >= '${yearStart}' AND idam_date < '${yearEnd}'
      GROUP BY LEFT(idam_date, 6), RTRIM(idam_momn)
      ORDER BY ym
    `);

    // 월별 항목별 집계
    const treatItems = {}; // { "2025-01": { "hyperthermia": { count, revenue }, ... } }
    for (const row of treatResult.recordset) {
      const mapping = EMR_TO_PLAN[row.code];
      if (!mapping) continue;

      const ym = `${row.ym.slice(0,4)}-${row.ym.slice(4,6)}`;
      if (!treatItems[ym]) treatItems[ym] = {};

      const itemId = mapping.id;
      if (!treatItems[ym][itemId]) treatItems[ym][itemId] = { count: 0, revenue: 0 };

      // 수량 계산
      let qty;
      if (mapping.vitcG) {
        // vitc: 각 코드별 건수 = 횟수, 매출은 건당 vitcPrice
        qty = row.cnt;
        treatItems[ym][itemId].count += qty;
        treatItems[ym][itemId].revenue += qty * vitcPrice(mapping.vitcG);
        continue;
      } else if (mapping.combo) {
        // combo (dramin): 2개 코드가 1세트이므로 cnt로 세지 않고 별도 처리
        if (!treatItems[ym][itemId]._comboCnt) treatItems[ym][itemId]._comboCnt = 0;
        treatItems[ym][itemId]._comboCnt += row.cnt;
        continue;
      } else if (mapping.qtyField === 'times') {
        qty = row.total_times || row.cnt;
      } else if (mapping.qtyField === 'dosage') {
        qty = Math.round(row.total_dosage) || row.cnt;
      } else {
        qty = row.cnt;
      }

      treatItems[ym][itemId].count += qty;
      treatItems[ym][itemId].revenue += qty * (ITEM_PRICES[itemId] || 0);
    }

    // combo 정리 (dramin: 2개 코드 = 1세트)
    for (const [ym, items] of Object.entries(treatItems)) {
      for (const [id, data] of Object.entries(items)) {
        if (data._comboCnt !== undefined) {
          // combo 항목의 최소 건수 = 1세트 (2개 코드 중 적은 쪽이 세트 수)
          // 간소화: 전체 combo 건수 / 2 = 세트 수
          const sets = Math.floor(data._comboCnt / 2);
          data.count = sets;
          data.revenue = sets * (ITEM_PRICES[id] || 0);
          delete data._comboCnt;
        }
      }
    }

    for (const [ym, items] of Object.entries(treatItems)) {
      updates[`directorStats/${year}/treatmentItems/${ym}`] = items;
      const itemCount = Object.keys(items).length;
      const totalRev = Object.values(items).reduce((s, v) => s + v.revenue, 0);
      console.log(`  ${ym}: ${itemCount}종, 매출 ${Math.round(totalRev/10000).toLocaleString()}만원`);
    }
  } catch (e) {
    console.log(`  치료항목 집계 실패: ${e.message}`);
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
