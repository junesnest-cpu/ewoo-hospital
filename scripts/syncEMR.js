/**
 * EMR → Firebase 동기화 스크립트
 *
 * 실행 모드:
 *   node scripts/syncEMR.js          경량 모드 (매시간) — 병상 배치 + 현재 입원환자만
 *   node scripts/syncEMR.js --full   전체 모드 (새벽)  — 중복정리 + 전체 환자 + 병상 + 입원이력
 *
 * [경량] Phase 1L: 현재 입원환자 마스터만 동기화
 * [경량] Phase 2:  병상 배치 동기화
 *
 * [전체] Phase 0:   차트번호 중복 정리
 * [전체] Phase 0.5: 구형 슬롯 키 마이그레이션
 * [전체] Phase 1:   전체 환자 마스터 동기화
 * [전체] Phase 2:   병상 배치 동기화
 * [전체] Phase 3:   과거 입원이력 동기화
 */

require('dotenv').config({ path: '.env.local' });
const sql   = require('mssql');
const admin = require('firebase-admin');

// ── Firebase Admin 초기화 ─────────────────────────────────────────
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

// ── SQL Server 설정 ────────────────────────────────────────────────
const sqlConfig = {
  user:     process.env.EMR_DB_USER,
  password: process.env.EMR_DB_PASSWORD,
  database: 'BrWonmu',
  server:   '192.168.0.253',
  port:     1433,
  requestTimeout: 120000,
  options: {
    encrypt:                false,
    trustServerCertificate: true,
  },
};

// ── 전화번호 정규화 ────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11) return `${digits.slice(0,3)}-${digits.slice(3,7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
  return String(raw).trim();
}

// ── 날짜 포맷 (YYYYMMDD → YYYY-MM-DD) ────────────────────────────
function formatDate(raw) {
  if (!raw) return '';
  const s = String(raw).replace(/\D/g, '');
  if (s.length === 8) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  return '';
}

// ── 차트번호 정규화 (10자리 0패딩) ─────────────────────────────────
// "233/p02929" → "0000000233", "233" → "0000000233"
function normalizeChartNo(raw) {
  if (!raw) return String(raw ?? '').trim();
  const s = String(raw).trim();
  const slashMatch = s.match(/^(\d+)\//);
  if (slashMatch) return slashMatch[1].padStart(10, '0');
  if (/^\d+$/.test(s)) return s.padStart(10, '0');
  return s;
}

// ── 전화번호 숫자만 추출 (인덱스 키 용) ────────────────────────────
function digitsOnly(raw) {
  return String(raw || '').replace(/\D/g, '');
}

// ── 배열 변환 ───────────────────────────────────────────────────────
function toArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return Object.values(val);
}

// ── 환자 마스터 필드 병합 (target 기준, source로 보완) ──────────────
function mergePatientFields(target, source) {
  const result = { ...target };
  const fillFields = ['birthDate', 'birthYear', 'gender', 'address',
    'diagCode', 'diagName', 'lastDoctor', 'lastDept',
    'lastVisitDate', 'currentAdmitDate'];
  for (const f of fillFields) {
    if (!result[f] && source[f]) result[f] = source[f];
  }
  if (source.phone && (!result.phone || result.phone.length < source.phone.length)) {
    result.phone = source.phone;
  }
  return result;
}

// ── 예약 배열 병합 (중복 제거) ──────────────────────────────────────
function mergeReservations(listA, listB, primaryId, secondaryId) {
  const all = [...toArray(listA), ...toArray(listB)];
  const seen = new Set();
  return all.filter(Boolean).map(r => {
    const fixed = { ...r };
    if (fixed.patientId === secondaryId) fixed.patientId = primaryId;
    return fixed;
  }).filter(r => {
    const key = `${r.name || ''}__${r.admitDate || r.date || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── [Phase 0] Firebase 내 차트번호 중복 정리 ───────────────────────
async function cleanupDuplicates(db) {
  console.log('─'.repeat(50));
  console.log('[0] 차트번호 중복 정리 시작');

  const [pSnap, phoneSnap, chartSnap, sSnap, cSnap, pendSnap] = await Promise.all([
    db.ref('patients').once('value'),
    db.ref('patientByPhone').once('value'),
    db.ref('patientByChartNo').once('value'),
    db.ref('slots').once('value'),
    db.ref('consultations').once('value'),
    db.ref('pendingChanges').once('value'),
  ]);

  const pRaw    = pSnap.val()    || {};
  const slots   = sSnap.val()    || {};
  const conRaw  = cSnap.val()    || {};
  const pending = pendSnap.val() || {};

  // 환자 레코드 수집 (슬래시 경로로 중첩 저장된 레코드 포함)
  const allPatients = [];
  function collectPatients(node, path) {
    if (!node || typeof node !== 'object') return;
    if (node.name && typeof node.name === 'string') {
      allPatients.push({ dbKey: path, ...node });
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      collectPatients(v, path ? `${path}/${k}` : k);
    }
  }
  for (const [k, v] of Object.entries(pRaw)) {
    if (!v) continue;
    if (v.name && typeof v.name === 'string') allPatients.push({ dbKey: k, ...v });
    else if (typeof v === 'object') collectPatients(v, k);
  }

  // 정규화 차트번호 기준 그룹핑
  const byNormChart = {};
  for (const p of allPatients) {
    const norm = normalizeChartNo(p.chartNo);
    if (!norm) continue;
    if (!byNormChart[norm]) byNormChart[norm] = [];
    byNormChart[norm].push(p);
  }

  const dupGroups = Object.values(byNormChart).filter(g => g.length > 1);
  console.log(`  중복 차트번호 그룹: ${dupGroups.length}건`);
  if (dupGroups.length === 0) {
    console.log('✅ 중복 없음\n');
    return;
  }

  const updates = {};
  const idRemap = {}; // { 구형 internalId → 신형 internalId }
  let mergeCount = 0;

  for (const group of dupGroups) {
    const names = [...new Set(group.map(p => p.name))];
    if (names.length > 1) {
      console.log(`  ⚠ 이름 불일치 (수동 확인): ${group.map(p => `${p.name}(${p.chartNo})`).join(' vs ')}`);
      continue;
    }

    // 우선순위: internalId 있음 > 0패딩 chartNo > 기타
    const ranked = [...group].sort((a, b) => {
      const s = p => (p.internalId ? 100 : 0) + (String(p.chartNo || '').startsWith('0') ? 10 : 0);
      return s(b) - s(a);
    });
    const primary   = ranked[0];
    const secondary = ranked.slice(1);
    const normChart = normalizeChartNo(primary.chartNo);

    // internalId 재매핑 등록
    for (const sec of secondary) {
      if (sec.internalId && primary.internalId && sec.internalId !== primary.internalId) {
        idRemap[sec.internalId] = primary.internalId;
      }
    }

    // 환자 마스터 병합
    let merged = { ...primary };
    for (const src of secondary) merged = mergePatientFields(merged, src);
    merged.chartNo = normChart;
    delete merged.dbKey;

    updates[`patients/${primary.dbKey}`] = merged;
    for (const sec of secondary) {
      updates[`patients/${sec.dbKey}`] = null;
      mergeCount++;
    }

    // 인덱스 재구축
    if (merged.internalId) {
      updates[`patientByChartNo/${normChart}`] = merged.internalId;
      const n = digitsOnly(merged.phone);
      if (n.length >= 10) updates[`patientByPhone/${n}`] = merged.internalId;
      for (const sec of secondary) {
        const oldNorm = normalizeChartNo(sec.chartNo);
        if (oldNorm && oldNorm !== normChart) updates[`patientByChartNo/${oldNorm}`] = null;
      }
    }

    console.log(`  병합: [${group.map(p => p.dbKey).join(' + ')}] → ${primary.dbKey}  (${primary.name})`);
  }

  // 슬롯 patientId 참조 갱신
  for (const [slotKey, slot] of Object.entries(slots)) {
    if (!slot) continue;
    const cur = slot.current;
    if (cur?.patientId && idRemap[cur.patientId]) {
      updates[`slots/${slotKey}/current/patientId`] = idRemap[cur.patientId];
    }
    if (cur?.chartNo) {
      const norm = normalizeChartNo(cur.chartNo);
      if (norm && norm !== String(cur.chartNo)) updates[`slots/${slotKey}/current/chartNo`] = norm;
    }
    const resList = toArray(slot.reservations);
    const newRes  = resList.map(r => {
      if (!r) return r;
      const fixed = { ...r };
      if (fixed.patientId && idRemap[fixed.patientId]) fixed.patientId = idRemap[fixed.patientId];
      if (fixed.chartNo) {
        const norm = normalizeChartNo(fixed.chartNo);
        if (norm && norm !== String(fixed.chartNo)) fixed.chartNo = norm;
      }
      return fixed;
    });
    const resChanged = resList.some((r, i) => JSON.stringify(r) !== JSON.stringify(newRes[i]));
    if (resChanged) updates[`slots/${slotKey}/reservations`] = newRes;
  }

  // 상담 patientId 참조 갱신
  for (const [key, con] of Object.entries(conRaw)) {
    if (con?.patientId && idRemap[con.patientId]) {
      updates[`consultations/${key}/patientId`] = idRemap[con.patientId];
    }
  }

  // 승인대기 patientId 참조 갱신
  for (const [key, item] of Object.entries(pending)) {
    if (item?.patientId && idRemap[item.patientId]) {
      updates[`pendingChanges/${key}/patientId`] = idRemap[item.patientId];
    }
  }

  // Firebase 반영
  const entries = Object.entries(updates);
  if (entries.length > 0) {
    for (let i = 0; i < entries.length; i += 500) {
      await db.ref('/').update(Object.fromEntries(entries.slice(i, i + 500)));
    }
  }
  console.log(`✅ 중복 정리 완료 — 병합: ${mergeCount}건, Firebase 업데이트: ${entries.length}건\n`);
}

// ── [Phase 0.5] 구형 슬롯 키 마이그레이션 ──────────────────────────
async function migrateOldSlotKeys(db, slots) {
  const VALID_ROOM_IDS = new Set(Object.values(ROOM_MAP));

  function convertOldKey(slotKey) {
    const dashIdx = slotKey.indexOf('-');
    if (dashIdx < 0) return null;
    const roomPart = slotKey.slice(0, dashIdx);
    const bed      = slotKey.slice(dashIdx + 1);
    if (VALID_ROOM_IDS.has(roomPart)) return null; // 이미 신형
    const m = roomPart.match(/^(\d)0(\d{1,2})$/);
    if (!m) return null;
    const roomId = ROOM_MAP[parseInt(m[2], 10)];
    if (!roomId) return null;
    return `${roomId}-${bed}`;
  }

  function mergeSlotCurrent(primary, secondary) {
    const result = { ...primary };
    for (const f of ['discharge', 'note', 'roomFeeType', 'patientId', 'chartNo']) {
      if (!result[f] && secondary[f]) result[f] = secondary[f];
    }
    return result;
  }

  const oldKeys = Object.keys(slots).filter(k => convertOldKey(k) !== null);
  if (oldKeys.length === 0) {
    console.log('  구형 슬롯 키 없음 — 스킵\n');
    return slots; // 변경 없으면 원본 반환
  }
  console.log(`  구형 슬롯 키 ${oldKeys.length}개 마이그레이션 중...`);

  const updates = {};
  for (const oldKey of oldKeys) {
    const newKey  = convertOldKey(oldKey);
    const oldSlot = slots[oldKey] || {};
    const newSlot = slots[newKey] || {};

    const newCurrent = newSlot.current?.name
      ? mergeSlotCurrent(newSlot.current, oldSlot.current || {})
      : (oldSlot.current || null);

    const mergedRes = [...toArray(newSlot.reservations), ...toArray(oldSlot.reservations)];
    const seen = new Set();
    const dedupRes = mergedRes.filter(Boolean).filter(r => {
      const key = `${r.name || ''}__${r.admitDate || r.date || ''}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    if (newCurrent)       updates[`slots/${newKey}/current`]      = newCurrent;
    if (dedupRes.length)  updates[`slots/${newKey}/reservations`] = dedupRes;
    updates[`slots/${oldKey}`] = null;
  }

  const entries = Object.entries(updates);
  for (let i = 0; i < entries.length; i += 500) {
    await db.ref('/').update(Object.fromEntries(entries.slice(i, i + 500)));
  }
  console.log(`  ✅ 구형 슬롯 키 마이그레이션 완료 (${oldKeys.length}개)\n`);

  // 업데이트된 slots 반환 (Phase 2에서 재조회 불필요하도록)
  const updatedSlots = { ...slots };
  for (const oldKey of oldKeys) {
    const newKey = convertOldKey(oldKey);
    if (updatedSlots[newKey]) {
      updatedSlots[newKey] = { ...updatedSlots[newKey], ...updates[`slots/${newKey}/current`] ? { current: updates[`slots/${newKey}/current`] } : {} };
    }
    delete updatedSlots[oldKey];
  }
  return updatedSlots;
}

// ── 병상 슬롯 키 생성 (EMR → Firebase) ───────────────────────────
// bedm_room은 병원 전체 순차 번호 (1~21), roomId로 변환 필요
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

// ── 모드 판별 ────────────────────────────────────────────────────
const FULL_MODE = process.argv.includes('--full');

// ── 메인 ──────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  EMR 동기화 [${FULL_MODE ? '전체 모드 --full' : '경량 모드'}]`);
  console.log(`  ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
  console.log('═'.repeat(50));

  console.log('🔌 SQL Server 연결 중... (192.168.0.253:1433)');
  const pool = await sql.connect(sqlConfig);
  console.log('✅ 연결 성공\n');

  // ── [전체 모드] Phase 0: 차트번호 중복 정리 ──
  if (FULL_MODE) {
    await cleanupDuplicates(db);
  }

  // ════════════════════════════════════════════════════════════════
  // Phase 1: 환자 마스터 동기화
  //   경량: 현재 입원환자(Wbedm)만  /  전체: 전체 환자
  // ════════════════════════════════════════════════════════════════
  console.log('─'.repeat(50));
  console.log(`[1] 환자 마스터 동기화 시작 (${FULL_MODE ? '전체' : '입원환자만'})`);

  const patientQuery = FULL_MODE
    ? `
    WITH ranked AS (
      SELECT
        chamKey, chamWhanja, chamBirth, chamSex,
        chamHphone, chamJuso, jubDate, dctrName, hyGubunName,
        ROW_NUMBER() OVER (PARTITION BY chamKey ORDER BY jubDate DESC) AS rn
      FROM BrWonmu.dbo.VIEWJUBLIST
      WHERE chamWhanja IS NOT NULL AND LEN(TRIM(chamWhanja)) > 0
    ),
    mainDiag AS (
      SELECT
        d.idis_cham,
        d.idis_dism                            AS diagCode,
        COALESCE(dm.dism_h_name, d.idis_dism)  AS diagName,
        ROW_NUMBER() OVER (
          PARTITION BY d.idis_cham
          ORDER BY d.idis_in_date DESC, d.idis_cnt
        ) AS rn
      FROM BrWonmu.dbo.Widis d
      LEFT JOIN BrWonmu.dbo.Wdism dm ON dm.dism_key = d.idis_dism
      WHERE d.idis_first = 1
    ),
    currentAdmit AS (
      SELECT bedm_cham AS chartNo, bedm_in_date AS admitDate
      FROM BrWonmu.dbo.Wbedm
      WHERE bedm_cham IS NOT NULL AND bedm_cham <> ''
    )
    SELECT
      r.chamKey       AS chartNo,
      r.chamWhanja    AS name,
      r.chamBirth     AS birthDate,
      r.chamSex       AS sex,
      r.chamHphone    AS phone,
      r.chamJuso      AS address,
      r.jubDate       AS lastVisitDate,
      r.dctrName      AS lastDoctor,
      r.hyGubunName   AS lastDept,
      md.diagCode,
      md.diagName,
      ca.admitDate    AS currentAdmitDate
    FROM ranked r
    LEFT JOIN mainDiag md    ON md.idis_cham = r.chamKey AND md.rn = 1
    LEFT JOIN currentAdmit ca ON ca.chartNo  = r.chamKey
    WHERE r.rn = 1
    ORDER BY r.chamKey
  `
    : `
    SELECT
      b.bedm_cham      AS chartNo,
      v.chamWhanja     AS name,
      v.chamBirth      AS birthDate,
      v.chamSex        AS sex,
      v.chamHphone     AS phone,
      v.chamJuso       AS address,
      v.jubDate        AS lastVisitDate,
      v.dctrName       AS lastDoctor,
      v.hyGubunName    AS lastDept,
      md.diagCode,
      md.diagName,
      b.bedm_in_date   AS currentAdmitDate
    FROM BrWonmu.dbo.Wbedm b
    OUTER APPLY (
      SELECT TOP 1 chamWhanja, chamBirth, chamSex, chamHphone, chamJuso,
                   jubDate, dctrName, hyGubunName
      FROM BrWonmu.dbo.VIEWJUBLIST
      WHERE chamKey = b.bedm_cham
      ORDER BY jubDate DESC
    ) v
    OUTER APPLY (
      SELECT TOP 1
        d.idis_dism                            AS diagCode,
        COALESCE(dm.dism_h_name, d.idis_dism)  AS diagName
      FROM BrWonmu.dbo.Widis d
      LEFT JOIN BrWonmu.dbo.Wdism dm ON dm.dism_key = d.idis_dism
      WHERE d.idis_cham = b.bedm_cham AND d.idis_first = 1
      ORDER BY d.idis_in_date DESC, d.idis_cnt
    ) md
    WHERE b.bedm_cham IS NOT NULL AND b.bedm_cham <> ''
  `;

  const patResult = await pool.request().query(patientQuery);
  const patRows = patResult.recordset;
  console.log(`  조회: ${patRows.length}명`);

  // patientByChartNo 인덱스 로드 (internalId 보존 및 Phase 2 patientId 설정에 사용)
  const chartIdxSnap = await db.ref('patientByChartNo').once('value');
  const chartToId = Object.assign({}, chartIdxSnap.val() || {});

  // 현재 최대 internalId 계산 (신규 부여 시 충돌 방지)
  const existingIds = Object.values(chartToId).filter(id => /^P\d+$/.test(id));
  const maxIdNum = existingIds.length > 0
    ? Math.max(...existingIds.map(id => parseInt(id.slice(1), 10)))
    : 0;
  let nextIdNum = maxIdNum + 1;
  const assignedIdSet = new Set(existingIds);
  let newIdCount = 0;

  // 전화번호 기준 중복 감지
  const phoneMap = new Map();
  const skipSet  = new Set();
  for (const row of patRows) {
    const phone = normalizePhone(row.phone);
    if (!phone) continue;
    if (phoneMap.has(phone)) {
      skipSet.add(row.chartNo);
    } else {
      phoneMap.set(phone, row.chartNo);
    }
  }

  const patUpdates = {};
  for (const row of patRows) {
    if (skipSet.has(row.chartNo)) continue;
    const normChart = normalizeChartNo(row.chartNo);
    const patient = {
      chartNo:       normChart,
      name:          String(row.name || '').trim(),
      phone:         normalizePhone(row.phone),
      address:       String(row.address || '').trim(),
      lastDoctor:    String(row.lastDoctor || '').trim(),
      lastDept:      String(row.lastDept || '').trim(),
      lastVisitDate: formatDate(row.lastVisitDate),
      syncedAt:      new Date().toISOString(),
    };
    const gender    = row.sex === 1 ? 'M' : row.sex === 2 ? 'F' : '';
    const birthDate = formatDate(row.birthDate);
    const admitDate = formatDate(row.currentAdmitDate);
    if (gender)    patient.gender           = gender;
    if (birthDate) patient.birthDate        = birthDate;
    if (row.diagCode) patient.diagCode      = String(row.diagCode).trim();
    if (row.diagName) patient.diagName      = String(row.diagName).trim();
    if (admitDate) patient.currentAdmitDate = admitDate;

    // internalId 보존 또는 신규 부여
    let internalId = chartToId[normChart];
    if (!internalId) {
      while (assignedIdSet.has(`P${String(nextIdNum).padStart(5, '0')}`)) nextIdNum++;
      internalId = `P${String(nextIdNum).padStart(5, '0')}`;
      assignedIdSet.add(internalId);
      nextIdNum++;
      chartToId[normChart] = internalId;
      patUpdates[`patientByChartNo/${normChart}`] = internalId;
      newIdCount++;
    }
    patient.internalId = internalId;

    patUpdates[`patients/${normChart}`] = patient;
  }

  const patEntries = Object.entries(patUpdates);
  console.log(`  저장: ${patEntries.length}명 / 건너뜀: ${skipSet.size}건`);
  for (let i = 0; i < patEntries.length; i += 500) {
    await db.ref('/').update(Object.fromEntries(patEntries.slice(i, i + 500)));
  }
  console.log(`  ✅ 환자 마스터 완료 (신규 ID: ${newIdCount}명)\n`);

  // ════════════════════════════════════════════════════════════════
  // Phase 2: 병상 배치 동기화
  // ════════════════════════════════════════════════════════════════
  console.log('─'.repeat(50));
  console.log('[2] 병상 배치 동기화 시작');

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

  const emrBedMap = new Map();
  for (const b of bedResult.recordset) {
    const slotKey = makeSlotKey(b.dong, b.room, b.bedKey);
    emrBedMap.set(slotKey, {
      name:      String(b.name || '').trim(),
      admitDate: formatDate(b.admitDate),
      chartNo:   normalizeChartNo(b.chartNo),
    });
  }
  console.log(`  EMR 입원 병상: ${emrBedMap.size}개`);

  // Firebase 현재 slots 조회
  const slotsSnap = await db.ref('slots').get();
  let fbSlots = slotsSnap.val() || {};

  // [전체 모드] 구형 슬롯 키 마이그레이션
  if (FULL_MODE) {
    console.log('─'.repeat(50));
    console.log('[0.5] 구형 슬롯 키 마이그레이션');
    fbSlots = await migrateOldSlotKeys(db, fbSlots);
  }

  const slotUpdates = {};
  let   setCount = 0, clearCount = 0;

  for (const [slotKey, emrData] of emrBedMap) {
    const existing  = fbSlots[slotKey] || {};
    const fbCurrent = existing.current || {};

    const newCurrent = {
      name:      emrData.name,
      admitDate: emrData.admitDate,
      chartNo:   emrData.chartNo,
    };
    const slotPatientId = chartToId[emrData.chartNo];
    if (slotPatientId) newCurrent.patientId = slotPatientId;
    if (fbCurrent.note) newCurrent.note = fbCurrent.note;
    if (fbCurrent.discharge) {
      const raw   = String(fbCurrent.discharge).trim();
      const today = new Date(); today.setHours(0, 0, 0, 0);
      let dischargeDate = null;

      const isoM = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (isoM) dischargeDate = new Date(parseInt(isoM[1]), parseInt(isoM[2])-1, parseInt(isoM[3]));

      const mdM = !isoM && raw.match(/^(\d{1,2})\/(\d{1,2})$/);
      if (mdM) dischargeDate = new Date(today.getFullYear(), parseInt(mdM[1])-1, parseInt(mdM[2]));

      const isPast = dischargeDate && dischargeDate < today;
      if (!isPast) newCurrent.discharge = raw;
    }

    slotUpdates[`slots/${slotKey}/current`] = newCurrent;
    setCount++;
  }

  for (const [slotKey, slot] of Object.entries(fbSlots)) {
    if (!slot?.current?.name) continue;
    if (emrBedMap.has(slotKey)) continue;
    console.log(`  🚪 퇴원 처리: ${slotKey} (${slot.current.name})`);
    slotUpdates[`slots/${slotKey}/current`] = null;
    clearCount++;
  }

  if (Object.keys(slotUpdates).length > 0) {
    await db.ref('/').update(slotUpdates);
  }
  console.log(`  ✅ 병상 배치 완료 — 입원: ${setCount}개 / 퇴원: ${clearCount}개\n`);

  // ════════════════════════════════════════════════════════════════
  // [전체 모드] Phase 3: 과거 입원이력 동기화
  // ════════════════════════════════════════════════════════════════
  let histSize = 0, histTotal = 0;
  if (FULL_MODE) {
    console.log('─'.repeat(50));
    console.log('[3] 과거 입원이력 동기화 시작');

    const admitHistResult = await pool.request().query(`
      SELECT
        CHARTNO,
        INDAT   AS admitDate,
        OUTDAT  AS dischargeDate,
        INSUCLS AS insuCls
      FROM BrWonmu.dbo.SILVER_PATIENT_INFO
      WHERE OUTDAT IS NOT NULL AND OUTDAT <> ''
        AND INDAT  IS NOT NULL AND INDAT  <> ''
      ORDER BY CHARTNO, INDAT DESC
    `);

    const admitHistMap = new Map();
    for (const row of admitHistResult.recordset) {
      const normChart = normalizeChartNo(row.CHARTNO);
      if (!normChart) continue;
      const entry = {
        admitDate:     formatDate(row.admitDate),
        dischargeDate: formatDate(row.dischargeDate),
      };
      if (!entry.admitDate) continue;
      if (row.insuCls) entry.insuCls = String(row.insuCls).trim();
      if (!admitHistMap.has(normChart)) admitHistMap.set(normChart, []);
      admitHistMap.get(normChart).push(entry);
    }

    histSize  = admitHistMap.size;
    histTotal = admitHistResult.recordset.length;
    console.log(`  대상: ${histSize}명 / 이력: ${histTotal}건`);

    const histUpdates = {};
    for (const [normChart, history] of admitHistMap) {
      const seen = new Set();
      const dedup = history.filter(h => {
        const key = `${h.admitDate}__${h.dischargeDate}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      histUpdates[`patients/${normChart}/emrAdmissions`] = dedup;
    }

    const histEntries = Object.entries(histUpdates);
    for (let i = 0; i < histEntries.length; i += 500) {
      await db.ref('/').update(Object.fromEntries(histEntries.slice(i, i + 500)));
      process.stdout.write(`\r  ↑ ${Math.min(i + 500, histEntries.length)} / ${histEntries.length}`);
    }
    console.log(`\n  ✅ 입원이력 완료\n`);
  }

  // ════════════════════════════════════════════════════════════════
  // EMR 싱크 완료 시간 기록
  await db.ref('emrSyncLog/lastSync').set(new Date().toISOString());

  console.log('─'.repeat(50));
  console.log(`🎉 ${FULL_MODE ? '전체' : '경량'} 동기화 완료!`);
  if (FULL_MODE) {
    console.log(`   [0]   차트번호 중복 정리`);
    console.log(`   [0.5] 구형 슬롯 키 마이그레이션`);
  }
  console.log(`   [1]   환자 마스터: ${patEntries.length}명${FULL_MODE ? '' : ' (입원환자만)'}`);
  console.log(`   [2]   병상 입원: ${setCount}개 / 퇴원: ${clearCount}개`);
  if (FULL_MODE) {
    console.log(`   [3]   입원이력: ${histSize}명 / ${histTotal}건`);
  }

  await sql.close();
  process.exit(0);
}

main().catch(err => {
  console.error('❌ 오류:', err.message);
  sql.close().catch(() => {});
  process.exit(1);
});
