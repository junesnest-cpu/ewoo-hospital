/**
 * 병원장 전용 경영현황 API
 * - action: "revenue"  → EMR 월별 입원/외래 매출 합산
 * - action: "occupancy" → EMR 일자별 병상가동률
 */
import sql from 'mssql';

const sqlConfig = {
  user:     process.env.EMR_DB_USER,
  password: process.env.EMR_DB_PASSWORD,
  database: 'BrWonmu',
  server:   '192.168.0.253',
  port:     1433,
  options: { encrypt: false, trustServerCertificate: true },
  requestTimeout: 30000,
  connectionTimeout: 10000,
};

// 병상 수 (호실별)
const WARD_BEDS = {
  '201':4,'202':1,'203':4,'204':2,'205':6,'206':6,
  '301':4,'302':1,'303':4,'304':2,'305':2,'306':6,
  '501':4,'502':1,'503':4,'504':2,'505':6,'506':6,
  '601':6,'602':1,'603':6,
};
const TOTAL_BEDS = Object.values(WARD_BEDS).reduce((s,v) => s+v, 0);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { action, year } = req.body;
  const targetYear = year || new Date().getFullYear();

  let pool;
  try {
    pool = await sql.connect(sqlConfig);

    if (action === 'revenue') {
      return await handleRevenue(pool, targetYear, res);
    } else if (action === 'occupancy') {
      const { month } = req.body;
      return await handleOccupancy(pool, targetYear, month || (new Date().getMonth() + 1), res);
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('director-stats error:', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    if (pool) await pool.close().catch(() => {});
  }
}

// ── 월별 매출 합산 ──
async function handleRevenue(pool, year, res) {
  const yearStart = `${year}0101`;
  const yearEnd   = `${year + 1}0101`;

  // 입원 매출 (Widam)
  const inpatient = await pool.request().query(`
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

  // 외래 매출 시도 (Wodam — Brain EMR 외래처방 테이블)
  let outpatient = [];
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
    outpatient = opResult.recordset;
  } catch (e) {
    // 외래 테이블이 다른 이름일 수 있음 — 무시
    console.log('Wodam not found, trying alternative...');
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
      outpatient = opResult2.recordset;
    } catch (e2) {
      console.log('Wjdam also not found:', e2.message);
    }
  }

  return res.json({
    year,
    totalBeds: TOTAL_BEDS,
    inpatient: inpatient.recordset,
    outpatient,
  });
}

// ── 일자별 병상가동률 ──
async function handleOccupancy(pool, year, month, res) {
  const ym = `${year}${String(month).padStart(2, '0')}`;
  const daysInMonth = new Date(year, month, 0).getDate();

  // 해당 월에 입원 중이었던 환자 조회 (입원일 <= 해당월말 AND (퇴원일 >= 해당월초 OR 퇴원일 없음))
  const monthStart = `${ym}01`;
  const monthEnd   = `${ym}${String(daysInMonth).padStart(2, '0')}`;

  let dailyOccupancy;
  try {
    // SILVER_PATIENT_INFO에서 입퇴원 기록으로 일별 재원 환자 수 계산
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
    dailyOccupancy = result.recordset.map(r => ({
      date: r.dt,
      occupied: r.occupied,
      total: TOTAL_BEDS,
      rate: Math.round((r.occupied / TOTAL_BEDS) * 1000) / 10,
    }));
  } catch (e) {
    console.log('SILVER_PATIENT_INFO query failed:', e.message);
    // 대안: Wbedm 테이블에서 현재 배정된 병상 조회
    try {
      const result2 = await pool.request().query(`
        SELECT COUNT(*) AS occupied
        FROM Wbedm
        WHERE bedm_cham IS NOT NULL AND bedm_cham != ''
      `);
      const currentOccupied = result2.recordset[0]?.occupied || 0;
      dailyOccupancy = [{ date: monthEnd, occupied: currentOccupied, total: TOTAL_BEDS, rate: Math.round((currentOccupied / TOTAL_BEDS) * 1000) / 10 }];
    } catch (e2) {
      console.log('Wbedm also failed:', e2.message);
      dailyOccupancy = [];
    }
  }

  return res.json({
    year, month, totalBeds: TOTAL_BEDS,
    daily: dailyOccupancy,
  });
}
