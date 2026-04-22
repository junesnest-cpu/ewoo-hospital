/**
 * EMR(BrWonmu.Wbedm) ↔ Firebase slot.current 1:1 병상 대조 검증
 *
 * 3종 판정:
 *   - ✅ MATCH         : 같은 slotKey 에서 이름·차트번호·입원일 모두 일치
 *   - ⚠ MISMATCH      : 같은 slotKey 인데 필드 불일치
 *   - 🔴 EMR_ONLY     : EMR 에만 있고 Firebase 에 없음 (아직 신규 입원 반영 안 됨)
 *   - 👻 FB_ONLY      : Firebase 에만 있고 EMR 에 없음 (퇴원 미반영 유령)
 *
 * RPi 전용 — 병원 내부망에서만 실행 가능.
 */
require('dotenv').config({ path: '.env.local' });
const admin = require('firebase-admin');
const sql   = require('mssql');

const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  }),
  databaseURL: 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
});
const db = admin.database();

const sqlConfig = {
  user:     process.env.EMR_DB_USER,
  password: process.env.EMR_DB_PASSWORD,
  database: 'BrWonmu',
  server:   '192.168.0.253',
  port:     1433,
  requestTimeout: 60000,
  options:  { encrypt: false, trustServerCertificate: true },
};

function formatDate(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function normalizeChartNo(raw) {
  if (!raw) return '';
  const s = String(raw).trim().replace(/\D/g, '');
  return s.padStart(10, '0');
}
// syncEMR.js 와 동일한 병실 매핑 (bedm_room 숫자 → "201"~"603")
const ROOM_MAP = {
   1:'201',  2:'202',  3:'203',  4:'204',  5:'205',  6:'206',
   7:'301',  8:'302',  9:'303', 10:'304', 11:'305', 12:'306',
  13:'501', 14:'502', 15:'503', 16:'504', 17:'505', 18:'506',
  19:'601', 20:'602', 21:'603',
};
function makeSlotKey(dong, room, bedKey) {
  const roomId = ROOM_MAP[room];
  if (!roomId) return null;
  return `${roomId}-${bedKey}`;
}
function normName(n) {
  return (n || '').replace(/^신\)\s*/, '').replace(/\s/g, '').trim().toLowerCase();
}

async function main() {
  console.log('═'.repeat(70));
  console.log('  EMR ↔ Firebase 병상 1:1 대조 검증');
  console.log('═'.repeat(70));

  // 1) EMR 조회
  console.log('\n🔌 EMR 연결 중...');
  const pool = await sql.connect(sqlConfig);
  const bedResult = await pool.request().query(`
    WITH currentPats AS (
      SELECT CHARTNO, INSUCLS,
        ROW_NUMBER() OVER (PARTITION BY CHARTNO ORDER BY INDAT DESC) AS rn
      FROM BrWonmu.dbo.SILVER_PATIENT_INFO
      WHERE OUTDAT IS NULL OR OUTDAT = ''
    )
    SELECT
      b.bedm_dong    AS dong,
      b.bedm_room    AS room,
      b.bedm_key     AS bedKey,
      b.bedm_cham    AS chartNo,
      b.bedm_in_date AS admitDate,
      (SELECT TOP 1 chamWhanja
       FROM BrWonmu.dbo.VIEWJUBLIST
       WHERE chamKey = b.bedm_cham) AS name
    FROM BrWonmu.dbo.Wbedm b
    JOIN currentPats cp ON cp.CHARTNO = b.bedm_cham AND cp.rn = 1 AND cp.INSUCLS <> '50'
    WHERE b.bedm_cham IS NOT NULL AND b.bedm_cham <> ''
    ORDER BY b.bedm_dong, b.bedm_room, b.bedm_key
  `);
  await sql.close();

  const emrMap = new Map();
  for (const b of bedResult.recordset) {
    const slotKey = makeSlotKey(b.dong, b.room, b.bedKey);
    if (!slotKey) {
      console.log(`  ⚠ 알 수 없는 room 번호 skip: dong=${b.dong} room=${b.room} bed=${b.bedKey} name=${b.name}`);
      continue;
    }
    emrMap.set(slotKey, {
      name:      String(b.name || '').trim(),
      admitDate: formatDate(b.admitDate),
      chartNo:   normalizeChartNo(b.chartNo),
    });
  }
  console.log(`  EMR 입원 병상: ${emrMap.size}개`);

  // 2) Firebase slots
  const slotsSnap = await db.ref('slots').once('value');
  const slots = slotsSnap.val() || {};
  const fbMap = new Map();
  for (const [slotKey, slot] of Object.entries(slots)) {
    if (slot?.current?.name) {
      fbMap.set(slotKey, {
        name:      slot.current.name || '',
        admitDate: slot.current.admitDate || '',
        chartNo:   slot.current.chartNo || '',
        patientId: slot.current.patientId || '',
      });
    }
  }
  console.log(`  Firebase slot.current: ${fbMap.size}개`);

  // 3) 비교
  const matches = [];
  const mismatches = [];
  const emrOnly = [];
  const fbOnly  = [];

  const allKeys = new Set([...emrMap.keys(), ...fbMap.keys()]);
  for (const key of [...allKeys].sort()) {
    const e = emrMap.get(key);
    const f = fbMap.get(key);
    if (e && !f) { emrOnly.push({ key, ...e }); continue; }
    if (!e && f) { fbOnly.push({ key, ...f });  continue; }
    // 둘 다 있음
    const nameEq = normName(e.name) === normName(f.name);
    const chartEq = !e.chartNo || !f.chartNo || e.chartNo === f.chartNo;
    const admitEq = !e.admitDate || !f.admitDate || e.admitDate === f.admitDate;
    const ok = nameEq && chartEq && admitEq;
    if (ok) matches.push({ key, name: e.name });
    else mismatches.push({
      key,
      emrName: e.name, fbName: f.name,
      emrChart: e.chartNo, fbChart: f.chartNo,
      emrAdmit: e.admitDate, fbAdmit: f.admitDate,
      nameEq, chartEq, admitEq,
    });
  }

  // 4) 출력
  console.log('\n─'.repeat(70));
  console.log(`📊 요약`);
  console.log('─'.repeat(70));
  console.log(`  ✅ MATCH (완전일치)   : ${matches.length}개`);
  console.log(`  ⚠ MISMATCH (불일치)  : ${mismatches.length}개`);
  console.log(`  🔴 EMR_ONLY (FB누락)  : ${emrOnly.length}개`);
  console.log(`  👻 FB_ONLY  (유령)   : ${fbOnly.length}개`);

  if (mismatches.length > 0) {
    console.log('\n⚠ MISMATCH 상세:');
    mismatches.forEach(m => {
      console.log(`  [${m.key}]`);
      if (!m.nameEq)  console.log(`    이름 불일치:    EMR="${m.emrName}" ↔ FB="${m.fbName}"`);
      if (!m.chartEq) console.log(`    차트번호 불일치: EMR=${m.emrChart} ↔ FB=${m.fbChart}`);
      if (!m.admitEq) console.log(`    입원일 불일치:  EMR=${m.emrAdmit} ↔ FB=${m.fbAdmit}`);
    });
  }

  if (emrOnly.length > 0) {
    console.log('\n🔴 EMR_ONLY (EMR 있는데 Firebase 에 없음):');
    emrOnly.forEach(e => console.log(`  ${e.key.padEnd(7)} ${e.name.padEnd(10)} chart=${e.chartNo} admit=${e.admitDate}`));
  }

  if (fbOnly.length > 0) {
    console.log('\n👻 FB_ONLY (Firebase 유령 - 퇴원 미반영):');
    fbOnly.forEach(f => console.log(`  ${f.key.padEnd(7)} ${f.name.padEnd(10)} chart=${f.chartNo||'(없음)'} admit=${f.admitDate} pid=${f.patientId}`));
  }

  console.log('\n─'.repeat(70));
  if (mismatches.length === 0 && emrOnly.length === 0 && fbOnly.length === 0) {
    console.log('🎉 완전 일치! EMR 과 병동현황이 동일합니다.');
  } else {
    console.log('⚠ 불일치 존재 — 위 내역 확인 필요');
  }
  console.log('─'.repeat(70));

  process.exit(0);
}

main().catch(e => {
  console.error('❌', e.message);
  sql.close().catch(()=>{});
  process.exit(1);
});
