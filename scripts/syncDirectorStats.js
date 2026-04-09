/**
 * EMR → Firebase 경영현황 동기화
 *
 * 사용법:
 *   node scripts/syncDirectorStats.js --init       # 2020년~현재까지 전체 동기화
 *   node scripts/syncDirectorStats.js              # 현재 월만 업데이트 (cron용)
 *   node scripts/syncDirectorStats.js 2025         # 특정 연도만
 *   node scripts/syncDirectorStats.js 2025 3       # 특정 연도 특정 월만
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
  requestTimeout: 120000,
};

const TOTAL_BEDS = 78;

// ── EMR 코드 → 치료항목 매핑 ──
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

// ── 한 연도 전체 동기화 ──
async function syncYear(pool, year, updates) {
  const yearStart = `${year}0101`;
  const yearEnd   = `${year + 1}0101`;
  const today = new Date();
  const isCurrentYear = year === today.getFullYear();

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`  ${year}년 동기화`);
  console.log('━'.repeat(50));

  // 1. 입원 매출
  console.log('\n  [입원 매출]');
  const inResult = await pool.request().query(`
    SELECT LEFT(iadd_date, 6) AS ym, SUM(CAST(iadd_amt AS bigint)) AS total
    FROM Wiadd WHERE iadd_date >= '${yearStart}' AND iadd_date < '${yearEnd}'
    GROUP BY LEFT(iadd_date, 6) ORDER BY ym
  `);
  const inpatient = {};
  for (const r of inResult.recordset) {
    inpatient[r.ym] = { total: Number(r.total) };
    console.log(`    ${r.ym}: ${Math.round(Number(r.total)/10000).toLocaleString()}만`);
  }

  // 2. 공단수입/본부금
  try {
    const detailResult = await pool.request().query(`
      SELECT LEFT(isums_date, 6) AS ym,
        SUM(CAST(isums_iramt AS bigint)) AS iramt,
        SUM(CAST(isums_biamt AS bigint)) AS biamt
      FROM Wisums WHERE isums_date >= '${yearStart}' AND isums_date < '${yearEnd}'
      GROUP BY LEFT(isums_date, 6) ORDER BY ym
    `);
    for (const r of detailResult.recordset) {
      if (inpatient[r.ym]) {
        const total = inpatient[r.ym].total;
        const iramt = Number(r.iramt);
        const biamt = Number(r.biamt);
        inpatient[r.ym].gongdan = Math.max(0, total - iramt - biamt);
        inpatient[r.ym].bonbu = iramt;
        inpatient[r.ym].bigub = biamt;
      }
    }
  } catch (e) { console.log(`    공단/본부금 실패: ${e.message}`); }
  updates[`directorStats/${year}/revenue/inpatient`] = inpatient;

  // 3. 외래 매출
  console.log('  [외래 매출]');
  let outpatient = {};
  try {
    const outResult = await pool.request().query(`
      SELECT LEFT(oadd_date, 6) AS ym, SUM(CAST(oadd_amt AS bigint)) AS total
      FROM Woadd WHERE oadd_date >= '${yearStart}' AND oadd_date < '${yearEnd}'
      GROUP BY LEFT(oadd_date, 6) ORDER BY ym
    `);
    for (const r of outResult.recordset) {
      outpatient[r.ym] = { total: Number(r.total) };
      console.log(`    ${r.ym}: ${Math.round(Number(r.total)/10000).toLocaleString()}만`);
    }
  } catch (e) { console.log(`    외래 실패: ${e.message}`); }
  updates[`directorStats/${year}/revenue/outpatient`] = Object.keys(outpatient).length > 0 ? outpatient : null;

  // 4. 입원일수
  console.log('  [입원일수]');
  try {
    const bdResult = await pool.request().query(`
      SELECT LEFT(dt, 6) AS ym, COUNT(*) AS bedDays FROM (
        SELECT d.dt FROM (
          SELECT '${year}' + RIGHT('0'+CAST(m AS VARCHAR),2) + RIGHT('0'+CAST(d AS VARCHAR),2) AS dt
          FROM (SELECT DISTINCT n AS m FROM (SELECT TOP 12 ROW_NUMBER() OVER(ORDER BY(SELECT NULL)) AS n FROM sys.objects) x) months
          CROSS JOIN (SELECT TOP 31 ROW_NUMBER() OVER(ORDER BY(SELECT NULL)) AS d FROM sys.objects) days
          WHERE ISDATE('${year}' + RIGHT('0'+CAST(m AS VARCHAR),2) + RIGHT('0'+CAST(d AS VARCHAR),2)) = 1
        ) d CROSS JOIN SILVER_PATIENT_INFO p
        WHERE p.INDAT <= d.dt AND (p.OUTDAT > d.dt OR p.OUTDAT IS NULL OR p.OUTDAT = '')
          AND p.INSUCLS NOT IN ('50','100') AND d.dt >= '${yearStart}' AND d.dt < '${yearEnd}'
      ) sub GROUP BY LEFT(dt, 6) ORDER BY ym
    `);
    const bedDays = {};
    for (const r of bdResult.recordset) { bedDays[r.ym] = r.bedDays; console.log(`    ${r.ym}: ${r.bedDays}일`); }
    updates[`directorStats/${year}/revenue/bedDays`] = Object.keys(bedDays).length > 0 ? bedDays : null;
  } catch (e) { console.log(`    입원일수 실패: ${e.message}`); }

  // 5. 병상가동률
  console.log('  [병상 가동률]');
  const lastMonth = isCurrentYear ? today.getMonth() + 1 : 12;
  for (let m = 1; m <= lastMonth; m++) {
    const ym = `${year}${String(m).padStart(2, '0')}`;
    const daysInMonth = new Date(year, m, 0).getDate();
    const lastDay = (isCurrentYear && m === today.getMonth() + 1) ? today.getDate() : daysInMonth;
    try {
      const result = await pool.request().query(`
        SELECT d.dt, COUNT(p.CHARTNO) AS occupied FROM (
          SELECT '${ym}' + RIGHT('0' + CAST(n AS VARCHAR), 2) AS dt
          FROM (SELECT TOP ${lastDay} ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.objects) nums
        ) d LEFT JOIN SILVER_PATIENT_INFO p
          ON p.INDAT <= d.dt AND (p.OUTDAT > d.dt OR p.OUTDAT IS NULL OR p.OUTDAT = '')
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
      updates[`directorStats/${year}/occupancy/${ym}`] = daily;
      const avg = result.recordset.length > 0 ? Math.round((totalOcc / result.recordset.length / TOTAL_BEDS) * 1000) / 10 : 0;
      console.log(`    ${m}월: 평균 ${avg}% (${result.recordset.length}일)`);
    } catch (e) { console.log(`    ${m}월 실패: ${e.message}`); }
  }

  // 6. 치료항목
  console.log('  [치료항목]');
  try {
    const treatResult = await pool.request().query(`
      SELECT LEFT(idam_date, 6) AS ym, RTRIM(idam_momn) AS code,
        COUNT(*) AS cnt, SUM(CAST(idam_times AS int)) AS total_times,
        SUM(CAST(idam_dosage AS float)) AS total_dosage
      FROM Widam WHERE idam_date >= '${yearStart}' AND idam_date < '${yearEnd}'
      GROUP BY LEFT(idam_date, 6), RTRIM(idam_momn) ORDER BY ym
    `);
    const treatItems = {};
    for (const row of treatResult.recordset) {
      const mapping = EMR_TO_PLAN[row.code];
      if (!mapping) continue;
      const ym = `${row.ym.slice(0,4)}-${row.ym.slice(4,6)}`;
      if (!treatItems[ym]) treatItems[ym] = {};
      const itemId = mapping.id;
      if (!treatItems[ym][itemId]) treatItems[ym][itemId] = { count: 0, revenue: 0 };
      if (mapping.vitcG) {
        treatItems[ym][itemId].count += row.cnt;
        treatItems[ym][itemId].revenue += row.cnt * vitcPrice(mapping.vitcG);
      } else if (mapping.combo) {
        if (!treatItems[ym][itemId]._cc) treatItems[ym][itemId]._cc = 0;
        treatItems[ym][itemId]._cc += row.cnt;
      } else {
        const qty = mapping.qtyField === 'times' ? (row.total_times || row.cnt)
                  : mapping.qtyField === 'dosage' ? (Math.round(row.total_dosage) || row.cnt)
                  : row.cnt;
        treatItems[ym][itemId].count += qty;
        treatItems[ym][itemId].revenue += qty * (ITEM_PRICES[itemId] || 0);
      }
    }
    // combo 정리
    for (const items of Object.values(treatItems)) {
      for (const data of Object.values(items)) {
        if (data._cc !== undefined) {
          const sets = Math.floor(data._cc / 2);
          data.count = sets; data.revenue = sets * (ITEM_PRICES['dramin'] || 0);
          delete data._cc;
        }
      }
    }
    for (const [ym, items] of Object.entries(treatItems)) {
      updates[`directorStats/${year}/treatmentItems/${ym}`] = items;
      const rev = Object.values(items).reduce((s, v) => s + v.revenue, 0);
      console.log(`    ${ym}: ${Object.keys(items).length}종, ${Math.round(rev/10000).toLocaleString()}만`);
    }
  } catch (e) { console.log(`    치료항목 실패: ${e.message}`); }

  updates[`directorStats/${year}/lastSync`] = new Date().toISOString();
}

// ── 한 달만 동기화 (cron용 — 매출/가동률/치료항목) ──
async function syncMonth(pool, year, month, updates) {
  const ym = `${year}${String(month).padStart(2, '0')}`;
  const ymStart = `${ym}01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const ymEnd = `${year}${String(month).padStart(2,'0')}${String(daysInMonth).padStart(2,'0')}`;
  const nextYm = month === 12 ? `${year+1}0101` : `${year}${String(month+1).padStart(2,'0')}01`;
  const today = new Date();
  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1;

  console.log(`\n📅 ${year}년 ${month}월 업데이트`);

  // 입원 매출
  const inR = await pool.request().query(`
    SELECT SUM(CAST(iadd_amt AS bigint)) AS total FROM Wiadd
    WHERE iadd_date >= '${ymStart}' AND iadd_date < '${nextYm}'
  `);
  const inTotal = Number(inR.recordset[0]?.total || 0);
  const inp = { total: inTotal };

  try {
    const dR = await pool.request().query(`
      SELECT SUM(CAST(isums_iramt AS bigint)) AS iramt, SUM(CAST(isums_biamt AS bigint)) AS biamt
      FROM Wisums WHERE isums_date >= '${ymStart}' AND isums_date < '${nextYm}'
    `);
    const ir = Number(dR.recordset[0]?.iramt || 0);
    const bi = Number(dR.recordset[0]?.biamt || 0);
    inp.gongdan = Math.max(0, inTotal - ir - bi);
    inp.bonbu = ir; inp.bigub = bi;
  } catch(e) {}
  updates[`directorStats/${year}/revenue/inpatient/${ym}`] = inp;
  console.log(`  입원: ${Math.round(inTotal/10000).toLocaleString()}만`);

  // 외래 매출
  try {
    const outR = await pool.request().query(`
      SELECT SUM(CAST(oadd_amt AS bigint)) AS total FROM Woadd
      WHERE oadd_date >= '${ymStart}' AND oadd_date < '${nextYm}'
    `);
    const outTotal = Number(outR.recordset[0]?.total || 0);
    if (outTotal > 0) {
      updates[`directorStats/${year}/revenue/outpatient/${ym}`] = { total: outTotal };
      console.log(`  외래: ${Math.round(outTotal/10000).toLocaleString()}만`);
    }
  } catch(e) {}

  // 입원일수
  try {
    const lastDay = isCurrentMonth ? today.getDate() : daysInMonth;
    const bdR = await pool.request().query(`
      SELECT COUNT(*) AS bedDays FROM (
        SELECT d.dt FROM (
          SELECT '${ym}' + RIGHT('0'+CAST(n AS VARCHAR),2) AS dt
          FROM (SELECT TOP ${lastDay} ROW_NUMBER() OVER(ORDER BY(SELECT NULL)) AS n FROM sys.objects) nums
        ) d CROSS JOIN SILVER_PATIENT_INFO p
        WHERE p.INDAT <= d.dt AND (p.OUTDAT > d.dt OR p.OUTDAT IS NULL OR p.OUTDAT = '')
          AND p.INSUCLS NOT IN ('50','100')
      ) sub
    `);
    updates[`directorStats/${year}/revenue/bedDays/${ym}`] = bdR.recordset[0]?.bedDays || 0;
    console.log(`  입원일수: ${bdR.recordset[0]?.bedDays || 0}일`);
  } catch(e) {}

  // 병상가동률
  const lastDay = isCurrentMonth ? today.getDate() : daysInMonth;
  try {
    const occR = await pool.request().query(`
      SELECT d.dt, COUNT(p.CHARTNO) AS occupied FROM (
        SELECT '${ym}' + RIGHT('0'+CAST(n AS VARCHAR),2) AS dt
        FROM (SELECT TOP ${lastDay} ROW_NUMBER() OVER(ORDER BY(SELECT NULL)) AS n FROM sys.objects) nums
      ) d LEFT JOIN SILVER_PATIENT_INFO p
        ON p.INDAT <= d.dt AND (p.OUTDAT > d.dt OR p.OUTDAT IS NULL OR p.OUTDAT = '')
        AND p.INSUCLS NOT IN ('50','100')
      GROUP BY d.dt ORDER BY d.dt
    `);
    const daily = {};
    for (const r of occR.recordset) {
      daily[r.dt] = { occupied: r.occupied, total: TOTAL_BEDS, rate: Math.round((r.occupied/TOTAL_BEDS)*1000)/10 };
    }
    updates[`directorStats/${year}/occupancy/${ym}`] = daily;
    const avg = occR.recordset.length > 0 ? Math.round(occR.recordset.reduce((s,r)=>s+r.occupied,0)/occR.recordset.length/TOTAL_BEDS*1000)/10 : 0;
    console.log(`  가동률: 평균 ${avg}%`);
  } catch(e) {}

  // 치료항목
  try {
    const tR = await pool.request().query(`
      SELECT RTRIM(idam_momn) AS code, COUNT(*) AS cnt,
        SUM(CAST(idam_times AS int)) AS total_times, SUM(CAST(idam_dosage AS float)) AS total_dosage
      FROM Widam WHERE idam_date >= '${ymStart}' AND idam_date < '${nextYm}'
      GROUP BY RTRIM(idam_momn)
    `);
    const items = {};
    for (const row of tR.recordset) {
      const m = EMR_TO_PLAN[row.code];
      if (!m) continue;
      if (!items[m.id]) items[m.id] = { count:0, revenue:0 };
      if (m.vitcG) { items[m.id].count += row.cnt; items[m.id].revenue += row.cnt * vitcPrice(m.vitcG); }
      else if (m.combo) { if (!items[m.id]._cc) items[m.id]._cc = 0; items[m.id]._cc += row.cnt; }
      else {
        const q = m.qtyField==='times'?(row.total_times||row.cnt):m.qtyField==='dosage'?(Math.round(row.total_dosage)||row.cnt):row.cnt;
        items[m.id].count += q; items[m.id].revenue += q * (ITEM_PRICES[m.id]||0);
      }
    }
    for (const d of Object.values(items)) { if(d._cc!==undefined){d.count=Math.floor(d._cc/2);d.revenue=d.count*(ITEM_PRICES['dramin']||0);delete d._cc;} }
    const ymKey = `${year}-${String(month).padStart(2,'0')}`;
    updates[`directorStats/${year}/treatmentItems/${ymKey}`] = items;
    const rev = Object.values(items).reduce((s,v)=>s+v.revenue,0);
    console.log(`  치료항목: ${Object.keys(items).length}종, ${Math.round(rev/10000).toLocaleString()}만`);
  } catch(e) {}

  updates[`directorStats/${year}/lastSync`] = new Date().toISOString();
}

async function main() {
  const args = process.argv.slice(2);
  const isInit = args.includes('--init');
  const today = new Date();

  const pool = await sql.connect(sqlConfig);
  const updates = {};

  if (isInit) {
    // ── 전체 동기화: 2020년~현재 ──
    const startYear = 2020;
    const endYear = today.getFullYear();
    console.log(`📊 전체 초기 동기화 (${startYear}~${endYear}년)`);
    for (let y = startYear; y <= endYear; y++) {
      await syncYear(pool, y, updates);
    }
  } else if (args.length >= 2 && !isNaN(args[0]) && !isNaN(args[1])) {
    // ── 특정 연도 특정 월 ──
    const y = parseInt(args[0]), m = parseInt(args[1]);
    console.log(`📊 ${y}년 ${m}월 동기화`);
    await syncMonth(pool, y, m, updates);
  } else if (args.length === 1 && !isNaN(args[0])) {
    // ── 특정 연도 전체 ──
    const y = parseInt(args[0]);
    console.log(`📊 ${y}년 전체 동기화`);
    await syncYear(pool, y, updates);
  } else {
    // ── 기본: 현재 월만 (cron용) ──
    console.log(`📊 현재 월 업데이트 (${today.getFullYear()}년 ${today.getMonth()+1}월)`);
    await syncMonth(pool, today.getFullYear(), today.getMonth() + 1, updates);
  }

  // Firebase 반영
  const keys = Object.keys(updates);
  console.log(`\n🔥 Firebase 업데이트 (${keys.length}개 항목)...`);
  // 500개씩 나눠서 업데이트 (Firebase 제한)
  for (let i = 0; i < keys.length; i += 500) {
    const batch = Object.fromEntries(keys.slice(i, i + 500).map(k => [k, updates[k]]));
    await db.ref('/').update(batch);
  }

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
