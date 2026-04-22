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
const fs    = require('fs');
const path  = require('path');

// ── 환자 마스터 로컬 캐시 (P1 상담연결 최적화) ────────────────────
//   전체 모드(--full) 에서 Phase 2.5 가 Firebase/SQL 에서 구축한 patMaster 를
//   JSON 으로 저장. 이후 경량 sync 는 이 캐시 + 경량 Phase 1 결과 오버레이로
//   전체 환자 인덱스를 얻음 → Firebase 추가 다운로드 실질 0.
const CACHE_DIR       = path.join(__dirname, '..', '.cache');
const PATIENTS_CACHE  = path.join(CACHE_DIR, 'patients.json');
const CACHE_TTL_HOURS = 25; // 새벽 2시 full sync 주기 + 1h 여유
function writePatientsCache(patMaster) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(PATIENTS_CACHE, JSON.stringify(patMaster), 'utf8');
    return true;
  } catch (e) {
    console.error('  ⚠ 캐시 저장 실패:', e.message);
    return false;
  }
}
function readPatientsCache() {
  try {
    if (!fs.existsSync(PATIENTS_CACHE)) return null;
    const stat = fs.statSync(PATIENTS_CACHE);
    const ageH = (Date.now() - stat.mtimeMs) / 3600000;
    const data = JSON.parse(fs.readFileSync(PATIENTS_CACHE, 'utf8'));
    return { data, ageH };
  } catch (e) {
    console.error('  ⚠ 캐시 읽기 실패:', e.message);
    return null;
  }
}
// baseName: 신) 접두어 + 끝자리 숫자 suffix + whitespace 제거 (동명이인·표기변형 내성)
function baseName(n) {
  return (n || '').replace(/^신\)\s*/, '').replace(/\d+$/, '').replace(/\s/g, '').trim().toLowerCase();
}

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

  const [pSnap, phoneSnap, chartSnap, sSnap, cSnap] = await Promise.all([
    db.ref('patients').once('value'),
    db.ref('patientByPhone').once('value'),
    db.ref('patientByChartNo').once('value'),
    db.ref('slots').once('value'),
    db.ref('consultations').once('value'),
  ]);

  const pRaw    = pSnap.val()    || {};
  const slots   = sSnap.val()    || {};
  const conRaw  = cSnap.val()    || {};

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

  // Phase 2에서 참조할 consultations 스냅샷 (퇴원일 복원 + 유령 차단용).
  // cleanupDuplicates(전체 모드) 내부의 conRaw 는 별도 함수 스코프라 여기서 보이지 않으므로,
  // 경량·전체 모드 모두에서 안전하게 main() 스코프에 로드한다.
  const conRaw = (await db.ref('consultations').once('value')).val() || {};

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
  let   setCount = 0, clearCount = 0, transferCount = 0;

  // 병실 이동 감지: Firebase 내 chartNo/patientId/baseName → slotKey 역인덱스
  //   EMR 에서 환자가 다른 병상으로 이동하면, 원래 slotKey 는 emrBedMap 에 없어 퇴원으로 오인된다.
  //   같은 환자가 다른 slotKey 에서 입원중임을 감지하여
  //   (a) 이전 slot.current 는 비우되 퇴원 기록은 남기지 않고
  //   (b) 이전 slot 의 discharge/note 등 사용자 입력값을 새 slot 으로 이관한다.
  //
  // 다중 경로 매칭 (강→약):
  //   1) chartNo (가장 강함. EMR·Firebase 모두 보유)
  //   2) patientId (내부 ID. 재입원·동명이인 구분 가능)
  //   3) baseName (신) + 끝자리 숫자 + whitespace 제거 후 유일 매칭 시에만)
  //      — 레거시 slot.current 에 chartNo 가 없는 경우의 백업. 동명이인 충돌 시 스킵.
  const _baseName = (n) => (n || '').replace(/^신\)\s*/, '').replace(/\d+$/, '').replace(/\s/g, '').trim().toLowerCase();
  const fbChartToSlot = new Map();
  const fbPidToSlot   = new Map();
  const fbBaseToSlots = new Map(); // baseName → [slotKey,...] (중복 허용)
  for (const [sk, s] of Object.entries(fbSlots)) {
    const cur = s?.current;
    if (!cur?.name) continue;
    if (cur.chartNo)   fbChartToSlot.set(cur.chartNo, sk);
    if (cur.patientId) fbPidToSlot.set(cur.patientId, sk);
    const bn = _baseName(cur.name);
    if (bn) {
      if (!fbBaseToSlots.has(bn)) fbBaseToSlots.set(bn, []);
      fbBaseToSlots.get(bn).push(sk);
    }
  }
  const transferredFromSet = new Set();

  for (const [slotKey, emrData] of emrBedMap) {
    const existing  = fbSlots[slotKey] || {};
    const fbCurrent = existing.current || {};

    // 병실 이동 여부 판정 — 다중 경로로 같은 환자가 이미 다른 slot 에 있는지 확인
    const slotPatientIdEarly = chartToId[emrData.chartNo];
    let prevSlotKey = fbChartToSlot.get(emrData.chartNo);
    let transferBy = prevSlotKey ? 'chart' : null;
    if (!prevSlotKey && slotPatientIdEarly) {
      prevSlotKey = fbPidToSlot.get(slotPatientIdEarly);
      if (prevSlotKey) transferBy = 'pid';
    }
    if (!prevSlotKey) {
      // baseName fallback — 레거시 slot (chartNo 누락) 대비.
      //   동명이인 충돌 시 여러 slotKey 가 나올 수 있으므로 '유일 매칭' 일 때만 채택.
      //   또한 chartNo 있는 경우는 위에서 이미 걸렸을 것 — 여기 도달 시 chartNo 로 못 찾은 상황.
      const bn = _baseName(emrData.name);
      const cands = (fbBaseToSlots.get(bn) || []).filter(k => k !== slotKey);
      if (cands.length === 1) {
        prevSlotKey = cands[0];
        transferBy = 'baseName';
      }
    }
    const isTransfer    = !!prevSlotKey && prevSlotKey !== slotKey;
    const prevFbCurrent = isTransfer ? ((fbSlots[prevSlotKey] || {}).current || null) : null;
    if (isTransfer) {
      transferredFromSet.add(prevSlotKey);
      console.log(`  ↔ 병실 이동 감지(${transferBy}): ${emrData.name} ${prevSlotKey} → ${slotKey}`);
      transferCount++;
    }

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

    // 병실 이동 시: 이전 slot 에 있던 사용자 입력값을 새 slot 으로 이관
    //   consultation fallback 보다 신뢰도 높음 (이전 slot 이 현재 입원 중이었으므로)
    if (prevFbCurrent) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (prevFbCurrent.discharge && !newCurrent.discharge) {
        const raw = String(prevFbCurrent.discharge).trim();
        let d = null;
        const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (iso) d = new Date(+iso[1], +iso[2]-1, +iso[3]);
        const md = !iso && raw.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (md) d = new Date(today.getFullYear(), +md[1]-1, +md[2]);
        if (!d || d >= today) newCurrent.discharge = raw;
      }
      if (prevFbCurrent.note && !newCurrent.note) newCurrent.note = prevFbCurrent.note;
      if (prevFbCurrent.admitTime && !newCurrent.admitTime) newCurrent.admitTime = prevFbCurrent.admitTime;
      if (prevFbCurrent.dischargeTime && !newCurrent.dischargeTime) newCurrent.dischargeTime = prevFbCurrent.dischargeTime;
      if (prevFbCurrent.consultationId && !newCurrent.consultationId) newCurrent.consultationId = prevFbCurrent.consultationId;
    }

    // 예약에서 입원된 환자의 reservation 데이터 병합 후 정리
    //
    // 매칭 우선순위 (강→약):
    //   1) consultationId → consultations[cid].chartNo === emrData.chartNo  (최강: 교차DB 식별자)
    //   2) consultationId → consultations[cid].patientId === slotPatientId
    //   3) 이름 완전 일치 (trim + lowercase)
    //   4) baseName 일치 + (admit 또는 discharge 일치)
    //        baseName: 신) 제거 + 끝자리 숫자(동명이인 suffix) 제거 + whitespace 제거
    //        EMR 이 "김은정4" 로 숫자를 붙이고 상담일지는 "김은정" 으로 남아있는 케이스 해결
    const resList = existing.reservations || [];
    if (resList.length > 0) {
      const laxNorm  = (n) => (n || '').trim().toLowerCase();
      const baseName = (n) => (n || '').replace(/^신\)\s*/, '').replace(/\d+$/, '').replace(/\s/g, '').trim().toLowerCase();
      const normMD   = (s) => {
        if (!s) return '';
        const t = String(s).trim();
        const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (iso) return `${+iso[2]}/${+iso[3]}`;
        const md = t.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (md) return `${+md[1]}/${+md[2]}`;
        return t;
      };

      const emrLax    = laxNorm(emrData.name);
      const emrBase   = baseName(emrData.name);
      const emrAdmit  = normMD(emrData.admitDate);
      const curDis    = normMD(newCurrent.discharge);

      const matchIdx = resList.findIndex(r => {
        if (!r?.name) return false;
        // 1/2) consultationId 경유 식별자 매칭
        if (r.consultationId && conRaw[r.consultationId]) {
          const c = conRaw[r.consultationId];
          if (c.chartNo   && emrData.chartNo  && c.chartNo   === emrData.chartNo)   return true;
          if (c.patientId && slotPatientId    && c.patientId === slotPatientId)    return true;
        }
        // 3) 이름 완전 일치
        if (emrLax && laxNorm(r.name) === emrLax) return true;
        // 4) baseName + 날짜 시그널
        if (emrBase && baseName(r.name) === emrBase) {
          const rAdmit = normMD(r.admitDate);
          const rDis   = normMD(r.discharge);
          if (emrAdmit && rAdmit && emrAdmit === rAdmit) return true;
          if (rDis && curDis && rDis === curDis) return true;
        }
        return false;
      });
      if (matchIdx >= 0) {
        const matched = resList[matchIdx];
        // 예약에 있던 퇴원일·비고·시간 등을 current에 보존
        if (matched.discharge && !newCurrent.discharge) newCurrent.discharge = matched.discharge;
        if (matched.note && !newCurrent.note) newCurrent.note = matched.note;
        if (matched.admitTime) newCurrent.admitTime = matched.admitTime;
        if (matched.dischargeTime) newCurrent.dischargeTime = matched.dischargeTime;
        if (matched.consultationId) newCurrent.consultationId = matched.consultationId;
        // 해당 예약 제거
        const updatedRes = resList.filter((_, i) => i !== matchIdx);
        slotUpdates[`slots/${slotKey}/reservations`] = updatedRes;
        console.log(`  📋 예약→입원 전환: ${slotKey} (${emrData.name} ← 예약"${matched.name}") — 예약 데이터 병합 후 제거`);

        // 연결된 consultation 도 일관되게 갱신 (auto-restore 차단 + 식별자 연결)
        //   reservedSlot=null : 예약이 아니라 입원이 되었음을 반영
        //   chartNo/patientId : 없으면 입원 환자와 동일하게 채워 이후 매칭 강화
        //   status='입원완료' : 이 예약의 입원 사이클 완료
        //     (consultation.js auto-restore 및 index.js 자동승격 방지)
        if (matched.consultationId && conRaw[matched.consultationId]) {
          const c = conRaw[matched.consultationId];
          slotUpdates[`consultations/${matched.consultationId}/reservedSlot`] = null;
          if (!c.chartNo && emrData.chartNo) {
            slotUpdates[`consultations/${matched.consultationId}/chartNo`] = emrData.chartNo;
          }
          if (slotPatientId && c.patientId !== slotPatientId) {
            slotUpdates[`consultations/${matched.consultationId}/patientId`] = slotPatientId;
          }
          if (c.status !== '입원완료') {
            slotUpdates[`consultations/${matched.consultationId}/status`] = '입원완료';
          }
        }
      }
    }

    // 예약·fbCurrent·이전 slot 에서도 퇴원일을 못 찾은 경우: consultations 에서 fallback 검색
    // (예약이 다른 slot 에 있었거나, 이미 정리됐거나, 이름 정규화 mismatch 대비)
    //
    // 제외 조건:
    //   - status='취소'    : 유효하지 않은 예약
    //   - status='입원완료' : 이미 끝난 과거 입원의 퇴원일을 현재 입원에 붙이면 안 됨
    //   - dischargeDate 가 오늘 이전 : 과거 퇴원 예정일 → 재원 카운트에서 탈락시키는 원인
    if (!newCurrent.discharge) {
      const emrNorm = (emrData.name || '').trim().toLowerCase();
      const today = new Date(); today.setHours(0, 0, 0, 0);
      for (const c of Object.values(conRaw)) {
        if (!c || !c.dischargeDate) continue;
        if (c.status === '취소' || c.status === '입원완료') continue;
        const chartMatch   = c.chartNo && emrData.chartNo && c.chartNo === emrData.chartNo;
        const pidMatch     = c.patientId && slotPatientId && c.patientId === slotPatientId;
        const slotNameMatch = c.reservedSlot === slotKey &&
          (c.name || '').trim().toLowerCase() === emrNorm;
        if (!(chartMatch || pidMatch || slotNameMatch)) continue;

        const raw = String(c.dischargeDate).trim();
        let d = null;
        const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (iso) d = new Date(+iso[1], +iso[2]-1, +iso[3]);
        const md = !iso && raw.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (md) d = new Date(today.getFullYear(), +md[1]-1, +md[2]);
        if (d && d < today) continue; // 과거 dischargeDate 복원 금지

        newCurrent.discharge = c.dischargeDate;
        if (!newCurrent.dischargeTime && c.dischargeTime) newCurrent.dischargeTime = c.dischargeTime;
        console.log(`  🔗 consultations에서 퇴원일 복원: ${slotKey} ${emrData.name} → ${c.dischargeDate}`);
        break;
      }
    }

    slotUpdates[`slots/${slotKey}/current`] = newCurrent;
    setCount++;

    // OLD → NEW 치료계획 스키마 이관 (patient-keyed 전환 후)
    //   history.js 예약 승인 시 OLD path(treatmentPlans/{slotKey})에 쓴 플랜을
    //   EMR 입원 감지 시점에 NEW path(treatmentPlansV2/{pid}/{admissionKey})로 이동.
    //   NEW path 기존 데이터가 없을 때만 이관 (중복 방지).
    try {
      const pid = newCurrent.patientId;
      const admStr = newCurrent.admitDate || '';
      let admKey = null;
      const isoM2 = admStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (isoM2) admKey = `${isoM2[1]}-${isoM2[2]}-${isoM2[3]}`;
      else {
        const mdM2 = admStr.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (mdM2) admKey = `${new Date().getFullYear()}-${String(mdM2[1]).padStart(2,'0')}-${String(mdM2[2]).padStart(2,'0')}`;
      }
      if (pid && admKey) {
        const [oldTpSnap, oldWpSnap, oldApSnap, newTpSnap] = await Promise.all([
          db.ref(`treatmentPlans/${slotKey}`).once('value'),
          db.ref(`weeklyPlans/${slotKey}`).once('value'),
          db.ref(`admissionPlans/${slotKey}`).once('value'),
          db.ref(`treatmentPlansV2/${pid}/${admKey}`).once('value'),
        ]);
        // NEW path가 비어 있을 때만 이관 (이미 이관된 환자 재이관 방지)
        if (!newTpSnap.exists()) {
          if (oldTpSnap.exists()) slotUpdates[`treatmentPlansV2/${pid}/${admKey}`] = oldTpSnap.val();
          if (oldWpSnap.exists()) slotUpdates[`weeklyPlansV2/${pid}/${admKey}`]    = oldWpSnap.val();
          if (oldApSnap.exists()) slotUpdates[`admissionPlansV2/${pid}/${admKey}`] = oldApSnap.val();
          if (oldTpSnap.exists() || oldWpSnap.exists() || oldApSnap.exists()) {
            console.log(`  🔄 OLD→NEW 플랜 이관: ${slotKey} → ${pid}/${admKey}`);
          }
        }
      }
    } catch (migErr) {
      console.error(`  ⚠ 플랜 이관 실패 ${slotKey}: ${migErr.message}`);
    }
  }

  // 병실 이동 출처 slot 의 current 는 단순 비우기 (퇴원 아님 → monthlyBoards 기록하지 않음)
  for (const prevSk of transferredFromSet) {
    slotUpdates[`slots/${prevSk}/current`] = null;
  }

  // 퇴원 감지: Firebase에 있지만 EMR에 없는 환자 (단, 병실 이동 출처는 제외)
  const dischargedPatients = []; // { name, room, admitDate, ... }
  const todayForAdmit = new Date(); todayForAdmit.setHours(0, 0, 0, 0);
  for (const [slotKey, slot] of Object.entries(fbSlots)) {
    if (!slot?.current?.name) continue;
    if (emrBedMap.has(slotKey)) continue;
    if (transferredFromSet.has(slotKey)) continue; // 병실 이동 — 퇴원 아님
    const cur = slot.current;

    // 오늘 이후 입원 예정인 환자는 퇴원 처리하지 않음 (예약→current 자동 승격된 환자 보호)
    // chartNo가 없으면 EMR 미등록 상태 = 아직 물리적 입원 전
    const admitStr = cur.admitDate || '';
    let admitDate = null;
    const isoM = admitStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoM) admitDate = new Date(parseInt(isoM[1]), parseInt(isoM[2])-1, parseInt(isoM[3]));
    const mdM = !isoM && admitStr.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (mdM) admitDate = new Date(todayForAdmit.getFullYear(), parseInt(mdM[1])-1, parseInt(mdM[2]));
    if (admitDate) admitDate.setHours(0, 0, 0, 0);

    if (admitDate && admitDate >= todayForAdmit && !cur.chartNo) {
      // 오늘/미래 입원 예정 + EMR 미등록 → current를 reservation으로 복원
      const restoredRes = { name: cur.name, admitDate: cur.admitDate };
      if (cur.discharge) restoredRes.discharge = cur.discharge;
      if (cur.note) restoredRes.note = cur.note;
      if (cur.admitTime) restoredRes.admitTime = cur.admitTime;
      if (cur.consultationId) restoredRes.consultationId = cur.consultationId;
      if (cur.patientId) restoredRes.patientId = cur.patientId;
      const existingRes = slot.reservations || [];
      slotUpdates[`slots/${slotKey}/current`] = null;
      slotUpdates[`slots/${slotKey}/reservations`] = [...existingRes, restoredRes];
      console.log(`  🔄 예약 복원: ${slotKey} (${cur.name}) — EMR 미등록, 입원 예정 ${admitStr}`);
      continue;
    }

    dischargedPatients.push({
      name: cur.name, room: slotKey.split('-')[0],
      admitDate: cur.admitDate || '', discharge: cur.discharge || '',
      note: cur.note || '', chartNo: cur.chartNo || '',
    });
    console.log(`  🚪 퇴원 처리: ${slotKey} (${cur.name})`);
    slotUpdates[`slots/${slotKey}/current`] = null;
    clearCount++;

    // 연결된 consultations 도 "입원완료" + reservedSlot=null 로 갱신
    // (이 작업을 누락하면 consultation.js auto-restore 가 예약을 되돌리고
    //  index.js 자동승격이 다시 current 로 올려 유령 환자가 생김)
    const normName = (n) => (n || '').replace(/^신\)\s*/, '').replace(/\s/g, '').trim().toLowerCase();
    const curCid = cur.consultationId;
    const curNameN = normName(cur.name);
    let cleared = 0;
    for (const [conId, con] of Object.entries(conRaw)) {
      if (!con) continue;
      if (con.status === '취소' || con.status === '입원완료') continue;
      const byId   = curCid && conId === curCid;
      const bySlot = con.reservedSlot === slotKey && normName(con.name) === curNameN;
      if (byId || bySlot) {
        slotUpdates[`consultations/${conId}/status`]       = '입원완료';
        slotUpdates[`consultations/${conId}/reservedSlot`] = null;
        cleared++;
      }
    }
    if (cleared > 0) console.log(`    ↳ 상담일지 ${cleared}건 "입원완료" 처리 (auto-restore 차단)`);
  }

  // 신규 입원 감지: EMR에 있지만 Firebase에 없거나 다른 환자가 있는 슬롯
  const newAdmissions = [];
  for (const [slotKey, emrData] of emrBedMap) {
    const fbCurrent = (fbSlots[slotKey] || {}).current;
    // 신규 입원: 기존에 비어있거나 다른 환자였던 경우
    if (!fbCurrent?.name || fbCurrent.chartNo !== emrData.chartNo) {
      newAdmissions.push({
        name: emrData.name, room: slotKey.split('-')[0],
        admitDate: emrData.admitDate, chartNo: emrData.chartNo,
      });
    }
  }

  if (Object.keys(slotUpdates).length > 0) {
    await db.ref('/').update(slotUpdates);
  }
  console.log(`  ✅ 병상 배치 완료 — 입원: ${setCount}개 / 퇴원: ${clearCount}개 / 병실이동: ${transferCount}개\n`);

  // ────────────────────────────────────────────────────────────────
  // 입퇴원 이벤트를 monthlyBoards에 영구 기록
  // ────────────────────────────────────────────────────────────────
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  // 날짜 문자열 → YYYY-MM-DD 변환 헬퍼
  const toDateKey = (dateStr) => {
    if (!dateStr || dateStr === '미정') return null;
    const s = String(dateStr).trim();
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // M/D 형식
    const md = s.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (md) return `${today.getFullYear()}-${md[1].padStart(2,'0')}-${md[2].padStart(2,'0')}`;
    // YYYYMMDD
    if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
    return null;
  };

  // 날짜별로 이벤트 수집
  const eventsByDate = new Map(); // dateKey → { admissions: [], discharges: [] }
  const ensureDate = (dk) => { if (!eventsByDate.has(dk)) eventsByDate.set(dk, { admissions: [], discharges: [] }); };

  // 퇴원 환자: 퇴원일(오늘)에 퇴원 기록 + 입원일에 입원 기록
  for (const p of dischargedPatients) {
    // 퇴원 기록 (오늘)
    ensureDate(todayKey);
    eventsByDate.get(todayKey).discharges.push({ name: p.name, room: p.room, note: p.note });
    // 입원 기록 (입원일)
    const admKey = toDateKey(p.admitDate);
    if (admKey) {
      ensureDate(admKey);
      eventsByDate.get(admKey).admissions.push({ name: p.name, room: p.room, note: p.note });
    }
  }

  // 신규 입원 환자: 입원일에 입원 기록
  for (const p of newAdmissions) {
    const admKey = toDateKey(p.admitDate);
    if (admKey) {
      ensureDate(admKey);
      eventsByDate.get(admKey).admissions.push({ name: p.name, room: p.room });
    }
  }

  // monthlyBoards에 누적 병합 (기존 기록 보존, 새 항목만 추가)
  let boardUpdateCount = 0;
  for (const [dateKey, events] of eventsByDate) {
    const ym = dateKey.slice(0, 7);
    const snap = await db.ref(`monthlyBoards/${ym}/${dateKey}`).get();
    const existing = snap.val() || {};
    const exAdm = existing.admissions || [];
    const exDis = existing.discharges || [];
    const exAdmNames = new Set(exAdm.map(a => (a.name||'').trim().toLowerCase()));
    const exDisNames = new Set(exDis.map(d => (d.name||'').trim().toLowerCase()));

    const newAdm = events.admissions.filter(a => !exAdmNames.has((a.name||'').trim().toLowerCase()));
    const newDis = events.discharges.filter(d => !exDisNames.has((d.name||'').trim().toLowerCase()));

    if (newAdm.length || newDis.length) {
      const payload = {
        frozen: true,
        admissions: [...exAdm, ...newAdm],
        discharges: [...exDis, ...newDis],
      };
      // 기존 숨김 목록 보존 (사용자가 수동으로 삭제한 항목이 되살아나지 않도록)
      if (existing.hiddenAdmissions?.length) payload.hiddenAdmissions = existing.hiddenAdmissions;
      if (existing.hiddenDischarges?.length) payload.hiddenDischarges = existing.hiddenDischarges;
      await db.ref(`monthlyBoards/${ym}/${dateKey}`).set(payload);
      boardUpdateCount++;
      console.log(`  📋 ${dateKey}: 입원 +${newAdm.length} (총 ${exAdm.length + newAdm.length}), 퇴원 +${newDis.length} (총 ${exDis.length + newDis.length})`);
    }
  }
  if (boardUpdateCount) console.log(`  ✅ 입퇴원 기록 저장: ${boardUpdateCount}건`);
  else console.log(`  ✅ 입퇴원 변동 없음`);

  // ────────────────────────────────────────────────────────────────
  // 유령 퇴원 자동 회수 (retroactive cleanup)
  //   "현재 EMR 에 입원 중인 환자가 과거 monthlyBoards 에 퇴원 기록으로 남아있음"
  //   은 정의상 병실 이동을 퇴원으로 오탐한 흔적. 이동 감지 기능이 없던 시점(또는
  //   임시 장애로 놓친 경우) 에 누적된 오류를 매 sync 가 알아서 청소한다.
  //
  //   안전장치:
  //     - 퇴원일 < 현재 환자의 EMR admitDate 이면 제외 (정상적인 이전 퇴원 이력)
  //     - hidden* 목록은 건드리지 않음
  //     - 최근 2개월 범위만 스캔 (성능)
  // ────────────────────────────────────────────────────────────────
  try {
    const currentByBase = new Map(); // baseName → { name, admitDate, chartNo }
    const currentByChart = new Map();
    for (const [, ed] of emrBedMap) {
      const bn = _baseName(ed.name);
      if (bn) currentByBase.set(bn, ed);
      if (ed.chartNo) currentByChart.set(ed.chartNo, ed);
    }
    const parseKey = (s) => {
      if (!s) return null;
      const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m ? new Date(+m[1], +m[2]-1, +m[3]) : null;
    };
    const nowMonth = todayKey.slice(0, 7);
    const prev = new Date(today.getFullYear(), today.getMonth()-1, 1);
    const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;
    let cleanupCount = 0;
    for (const ym of [prevMonth, nowMonth]) {
      const monthSnap = await db.ref(`monthlyBoards/${ym}`).get();
      const monthData = monthSnap.val() || {};
      for (const [dateKey, day] of Object.entries(monthData)) {
        if (!day?.discharges?.length) continue;
        const disDate = parseKey(dateKey);
        const kept = [];
        const removed = [];
        for (const d of day.discharges) {
          if (!d || !d.name) { kept.push(d); continue; }
          const bn = _baseName(d.name);
          const stillAdmitted = currentByBase.get(bn);
          if (!stillAdmitted) { kept.push(d); continue; }

          // 안전장치 1: 미래 날짜(오늘 포함) 는 예약 퇴원이므로 절대 삭제하지 않음
          if (disDate && disDate >= today) { kept.push(d); continue; }
          // 안전장치 2: 현재 입원 admitDate >= 퇴원 기록 날짜 → 정상 이력 (같은 날 또는 이후 재입원)
          const admDate = parseKey(stillAdmitted.admitDate);
          if (admDate && disDate && admDate >= disDate) { kept.push(d); continue; }

          // 유령 퇴원: 현재 입원중이고 현재 입원이 퇴원 기록일보다 앞선 경우 → 병실이동 오탐 흔적
          removed.push(d);
          cleanupCount++;
        }
        if (removed.length > 0) {
          await db.ref(`monthlyBoards/${ym}/${dateKey}/discharges`).set(kept);
          removed.forEach(r => console.log(`  🩹 유령 퇴원 회수: ${dateKey} ${r.name}(${r.room||'?'}호) — 현재 입원 중`));
        }
      }
    }
    if (cleanupCount === 0) console.log(`  ✅ 유령 퇴원 스캔: 정리 대상 없음`);
    else console.log(`  ✅ 유령 퇴원 회수: ${cleanupCount}건`);
  } catch (e) {
    console.error(`  ⚠ 유령 퇴원 스캔 실패: ${e.message}`);
  }

  // ════════════════════════════════════════════════════════════════
  // [2.5] 상담일지(consultations) 자동 연결 — P1 재설계
  //
  //   환자 마스터 소스:
  //     전체 모드 : SQL 에서 조회된 patRows 전체 (~7,600명) → patMaster 구축 + 로컬 캐시 저장
  //     경량 모드 : 로컬 캐시 읽기 (age ≤ 25h) + 경량 Phase 1 신규 51명 오버레이
  //                 캐시 없거나 stale → Firebase patients 로부터 fallback 로드
  //   매칭 우선순위 (강→약, P2):
  //     1) chartNo 직접
  //     2) phone / phone2 (정규화)
  //     3) birthDate 전체(YYYY-MM-DD) + baseName 유일
  //     4) birthYear + baseName 유일
  //   결과 메트릭은 emrSyncLog/consultationLinking 에 기록 (P5)
  // ════════════════════════════════════════════════════════════════
  console.log('─'.repeat(50));
  console.log('[2.5] 상담일지 자동 연결 시작');

  // 1) patMaster 준비 ──────────────────────────────────────────────
  let patMaster = {}; // { [chartNo]: { chartNo, name, phone, birthDate, internalId } }
  let cacheStatus = 'none';
  let cacheAgeH = null;

  if (FULL_MODE) {
    // patRows 로부터 patMaster 직접 구축 + 캐시 저장
    for (const row of patRows) {
      if (skipSet.has(row.chartNo)) continue;
      const normChart = normalizeChartNo(row.chartNo);
      patMaster[normChart] = {
        chartNo:    normChart,
        name:       String(row.name || '').trim(),
        phone:      normalizePhone(row.phone),
        birthDate:  formatDate(row.birthDate),
        internalId: chartToId[normChart] || '',
      };
    }
    if (writePatientsCache(patMaster)) {
      cacheStatus = `written(${Object.keys(patMaster).length})`;
      console.log(`  💾 환자 마스터 캐시 저장: ${Object.keys(patMaster).length}건 → ${PATIENTS_CACHE}`);
    } else {
      cacheStatus = 'write-failed';
    }
  } else {
    // 경량 모드: 캐시 우선, 없으면 Firebase fallback
    const cached = readPatientsCache();
    if (cached && cached.ageH < CACHE_TTL_HOURS) {
      patMaster = cached.data || {};
      cacheAgeH = cached.ageH;
      cacheStatus = `cache(${cached.ageH.toFixed(1)}h,${Object.keys(patMaster).length}건)`;
      console.log(`  💾 환자 마스터 캐시 사용: ${Object.keys(patMaster).length}건, age=${cached.ageH.toFixed(1)}h`);
    } else {
      if (cached) {
        console.log(`  ⚠ 캐시 stale ${cached.ageH.toFixed(1)}h > ${CACHE_TTL_HOURS}h → Firebase fallback`);
        cacheStatus = 'stale-fallback';
      } else {
        console.log(`  ⚠ 캐시 파일 없음 → Firebase fallback`);
        cacheStatus = 'missing-fallback';
      }
      const fbSnap = await db.ref('patients').once('value');
      patMaster = fbSnap.val() || {};
      console.log(`  📥 Firebase patients 로드: ${Object.keys(patMaster).length}건`);
      // 다음 sync 를 위해 캐시 갱신 (stale → fresh)
      if (writePatientsCache(patMaster)) cacheStatus += '+cached';
    }
    // 경량 Phase 1 결과(현재 입원환자 51명) 최신으로 오버레이 — 오늘 새 입원환자도 즉시 매칭
    let overlayCount = 0;
    for (const row of patRows) {
      if (skipSet.has(row.chartNo)) continue;
      const normChart = normalizeChartNo(row.chartNo);
      patMaster[normChart] = {
        ...(patMaster[normChart] || {}),
        chartNo:    normChart,
        name:       String(row.name || '').trim(),
        phone:      normalizePhone(row.phone),
        birthDate:  formatDate(row.birthDate),
        internalId: chartToId[normChart] || patMaster[normChart]?.internalId || '',
      };
      overlayCount++;
    }
    if (overlayCount > 0) console.log(`  📥 경량 Phase 1 결과 ${overlayCount}건 오버레이`);
  }

  // 2) consultations + 인덱스 ──────────────────────────────────────
  const conSnap2 = await db.ref('consultations').once('value');
  const conAll   = conSnap2.val() || {};

  const patByChart     = new Map(); // chartNo → pat
  const patByPhone     = new Map(); // normalizedPhone → pat (첫 번째 등록만, 중복은 무시)
  const patByBirthBase = new Map(); // "YYYY-MM-DD|baseName" → [pat]
  const patByYearBase  = new Map(); // "YYYY|baseName" → [pat]
  for (const p of Object.values(patMaster)) {
    if (!p?.name) continue;
    if (p.chartNo && !patByChart.has(p.chartNo)) patByChart.set(p.chartNo, p);
    // Firebase patients 의 phone 필드 포맷이 다양(010-..., 01012345678, 공백 포함 등).
    // 일관되게 normalizePhone 을 거쳐 key 로 저장 → 조회 쪽과 완전 일치.
    const phoneK = normalizePhone(p.phone);
    if (phoneK && !patByPhone.has(phoneK)) patByPhone.set(phoneK, p);
    const bn = baseName(p.name);
    if (!bn) continue;
    if (p.birthDate) {
      const k = `${p.birthDate}|${bn}`;
      if (!patByBirthBase.has(k)) patByBirthBase.set(k, []);
      patByBirthBase.get(k).push(p);
      const y = p.birthDate.slice(0, 4);
      const k2 = `${y}|${bn}`;
      if (!patByYearBase.has(k2)) patByYearBase.set(k2, []);
      patByYearBase.get(k2).push(p);
    }
  }

  // 3) 매칭 루프 ───────────────────────────────────────────────────
  const conUpdates = {};
  let conLinkCount = 0;
  const stats = { byChart: 0, byPhone: 0, byBirthDate: 0, byBirthYear: 0, skip: 0, noMatch: 0 };

  for (const [conId, c] of Object.entries(conAll)) {
    if (!c?.name || c.status === '취소') { stats.skip++; continue; }

    let matched = null;
    let matchBy = null;

    // ① chartNo 직접
    if (c.chartNo && patByChart.has(c.chartNo)) {
      matched = patByChart.get(c.chartNo);
      matchBy = 'byChart';
    }
    // ② phone / phone2
    if (!matched) {
      const p1 = normalizePhone(c.phone);
      const p2 = normalizePhone(c.phone2);
      if (p1 && patByPhone.has(p1))      { matched = patByPhone.get(p1); matchBy = 'byPhone'; }
      else if (p2 && patByPhone.has(p2)) { matched = patByPhone.get(p2); matchBy = 'byPhone'; }
    }
    // ③ birthDate 전체 + baseName (유일)
    if (!matched && c.birthDate) {
      const bn = baseName(c.name);
      const cands = patByBirthBase.get(`${c.birthDate}|${bn}`) || [];
      if (cands.length === 1) { matched = cands[0]; matchBy = 'byBirthDate'; }
    }
    // ④ birthYear + baseName (유일)
    if (!matched && c.birthYear) {
      const bn = baseName(c.name);
      const cands = patByYearBase.get(`${c.birthYear}|${bn}`) || [];
      if (cands.length === 1) { matched = cands[0]; matchBy = 'byBirthYear'; }
    }

    if (!matched) { stats.noMatch++; continue; }

    // 업데이트 필요 필드만 반영 (중복 쓰기 방지)
    const updates = {};
    if (c.name !== matched.name && matched.name) updates.name = matched.name;
    if (matched.chartNo && c.chartNo !== matched.chartNo) updates.chartNo = matched.chartNo;
    if (matched.internalId && c.patientId !== matched.internalId) {
      updates.patientId = matched.internalId;
      updates.isNewPatient = false;
    }
    if (Object.keys(updates).length === 0) continue;

    for (const [k, v] of Object.entries(updates)) {
      conUpdates[`consultations/${conId}/${k}`] = v;
    }
    stats[matchBy]++;
    conLinkCount++;
  }

  // 4) 적용 ─────────────────────────────────────────────────────────
  if (Object.keys(conUpdates).length > 0) {
    const conEntries = Object.entries(conUpdates);
    for (let i = 0; i < conEntries.length; i += 500) {
      await db.ref('/').update(Object.fromEntries(conEntries.slice(i, i + 500)));
    }
  }

  // 5) 오연결 의심 탐지 (P3) ───────────────────────────────────────
  //   chartNo 가 이미 연결된 상담일지의 phone/birthDate/baseName 을 patByChart 의
  //   환자 마스터와 교차검증. 불일치가 있으면 suspect 로 기록 (자동 수정은 하지 않음).
  //   관리자가 emrSyncLog/consultationLinking/suspects 를 보고 조치.
  //
  //   severity:
  //     high   : 2+ 필드 불일치 or baseName 불일치 (다른 환자일 가능성 큼)
  //     medium : 1 필드만 불일치 (번호 변경·기입 오류 등 일상적 사유일 수도)
  const suspects = {};
  let suspectCount = 0;
  for (const [conId, c] of Object.entries(conAll)) {
    if (!c?.chartNo || c.status === '취소') continue;
    const pat = patByChart.get(c.chartNo);
    if (!pat) continue; // chartNo 가 patMaster 에 없는 경우는 별개 issue (sync 범위 외)

    const issues = {};

    // phone (phone2 도 허용)
    const cp  = normalizePhone(c.phone);
    const cp2 = normalizePhone(c.phone2);
    const pp  = normalizePhone(pat.phone);
    if (pp && cp && cp !== pp && (!cp2 || cp2 !== pp)) {
      issues.phone = { con: cp || null, pat: pp };
    }

    // birthDate 전체 비교 (둘 다 있을 때만)
    if (c.birthDate && pat.birthDate && c.birthDate !== pat.birthDate) {
      issues.birthDate = { con: c.birthDate, pat: pat.birthDate };
    } else if (!c.birthDate && c.birthYear && pat.birthDate) {
      const py = pat.birthDate.slice(0, 4);
      if (py && py !== c.birthYear) {
        issues.birthYear = { con: c.birthYear, pat: py };
      }
    }

    // baseName 비교 — suffix/신) 변형 허용 후에도 다르면 다른 사람
    const cBase = baseName(c.name);
    const pBase = baseName(pat.name);
    if (cBase && pBase && cBase !== pBase) {
      issues.baseName = { con: c.name, pat: pat.name };
    }

    const keys = Object.keys(issues);
    if (keys.length === 0) continue;

    const severity = (keys.length >= 2 || issues.baseName) ? 'high' : 'medium';
    suspects[conId] = {
      chartNo:  c.chartNo,
      conName:  c.name || '',
      patName:  pat.name || '',
      severity,
      issues,
    };
    suspectCount++;
  }

  // suspects 갱신 (매 sync 마다 전체 교체 — 과거에 고쳤던 건 자동 제거)
  try {
    await db.ref('emrSyncLog/consultationLinking/suspects').set(suspectCount > 0 ? suspects : null);
  } catch (e) { /* 기록 실패 무시 */ }

  // 6) 로그 & emrSyncLog 기록 (P5) ─────────────────────────────────
  const totalCon    = Object.keys(conAll).length;
  console.log(`  ✅ 상담연결: 총 ${totalCon}건 중 ${conLinkCount}건 신규 매칭 (chart=${stats.byChart} phone=${stats.byPhone} birthDate=${stats.byBirthDate} birthYear=${stats.byBirthYear})`);
  console.log(`     미매칭 ${stats.noMatch}건 / 제외 ${stats.skip}건 / cache=${cacheStatus}`);
  if (suspectCount > 0) {
    const highN = Object.values(suspects).filter(s => s.severity === 'high').length;
    console.log(`  ⚠ 의심 연결 ${suspectCount}건 (high=${highN}) — emrSyncLog/consultationLinking/suspects 참조`);
  } else {
    console.log(`  ✅ 의심 연결: 0건`);
  }
  try {
    await db.ref('emrSyncLog/consultationLinking').update({
      ts: new Date().toISOString(),
      mode: FULL_MODE ? 'full' : 'light',
      total: totalCon,
      fixed: conLinkCount,
      noMatch: stats.noMatch,
      byChart: stats.byChart,
      byPhone: stats.byPhone,
      byBirthDate: stats.byBirthDate,
      byBirthYear: stats.byBirthYear,
      suspectCount,
      cacheStatus,
      cacheAgeH: cacheAgeH === null ? null : +cacheAgeH.toFixed(2),
      masterSize: Object.keys(patMaster).length,
    });
  } catch (e) { /* 기록 실패는 무시 */ }

  // ════════════════════════════════════════════════════════════════
  // [2.6] 신규 입원 환자 consultation 상태 업데이트
  //   입원 감지된 환자의 consultation을 "입원완료"로 변경
  //   consultation이 없는 신규환자는 자동 생성
  // ════════════════════════════════════════════════════════════════
  console.log('─'.repeat(50));
  console.log('[2.6] 입원 환자 상담 상태 업데이트');

  // 최신 consultations 로드 (Phase 2.5에서 갱신되었을 수 있음)
  const conSnap3 = await db.ref('consultations').get();
  const conLatest = conSnap3.val() || {};

  // 현재 EMR에 입원 중인 전체 환자의 chartNo 세트
  const admittedChartNos = new Set();
  for (const [, emrData] of emrBedMap) {
    if (emrData.chartNo) admittedChartNos.add(emrData.chartNo);
  }

  // consultation을 chartNo/patientId/이름으로 인덱스
  const conByChartNo = {};   // chartNo → { key, data }
  const conByPatientId = {}; // patientId → { key, data }
  const conByName = {};      // name → { key, data }
  Object.entries(conLatest).forEach(([k, c]) => {
    if (!c?.name) return;
    if (c.chartNo) conByChartNo[c.chartNo] = { key: k, data: c };
    if (c.patientId) conByPatientId[c.patientId] = { key: k, data: c };
    // 이름 매칭은 가장 최근 상담을 우선
    if (!conByName[c.name] || (c.createdAt || '') > (conByName[c.name].data.createdAt || '')) {
      conByName[c.name] = { key: k, data: c };
    }
  });

  const admitUpdates = {};
  let statusUpdateCount = 0, autoCreateCount = 0;

  for (const [slotKey, emrData] of emrBedMap) {
    const chartNo = emrData.chartNo;
    const patientId = chartToId[chartNo];

    // 매칭 consultation 찾기: chartNo → patientId → 이름 순
    let matched = conByChartNo[chartNo] || null;
    if (!matched && patientId) matched = conByPatientId[patientId] || null;
    if (!matched) matched = conByName[emrData.name] || null;

    if (matched) {
      // 이미 "입원완료"면 건너뜀
      if (matched.data.status === '입원완료') continue;
      // 취소된 상담은 건너뜀
      if (matched.data.status === '취소') continue;
      admitUpdates[`consultations/${matched.key}/status`] = '입원완료';
      statusUpdateCount++;
      console.log(`  ✏️ ${emrData.name}: ${matched.data.status || '상태없음'} → 입원완료`);
    } else {
      // consultation이 없는 환자 → 자동 생성 (신규환자만)
      // 재입원 환자(patientId 있음)는 건너뜀
      if (patientId) continue;

      const newKey = db.ref('consultations').push().key;
      admitUpdates[`consultations/${newKey}`] = {
        name: emrData.name,
        admitDate: emrData.admitDate || '',
        status: '입원완료',
        isNewPatient: true,
        chartNo: chartNo || '',
        createdAt: emrData.admitDate || new Date().toISOString().slice(0, 10),
        source: 'EMR자동',
      };
      autoCreateCount++;
      console.log(`  🆕 ${emrData.name}: consultation 자동 생성 (신규환자)`);
    }
  }

  // 보조 매칭 (안전망): 현재 EMR 입원 slotKey 에 reservedSlot 이 걸려있는 모든
  //   consultation 을 "입원완료" + reservedSlot=null 로 정리.
  //   이름/chartNo/pid 어느 경로로도 매칭 실패했지만 reservedSlot 이 입원 slot 이면
  //   사실상 이 예약은 입원으로 전환된 것 (해당 환자의 과거 다른 상담레코드 등).
  //   이를 정리하지 않으면 consultation.js auto-restore 가 예약을 다시 생성함.
  const admittedSlotKeys = new Set(emrBedMap.keys());
  let safetyNetCount = 0;
  for (const [conId, c] of Object.entries(conLatest)) {
    if (!c || !c.reservedSlot) continue;
    if (c.status === '입원완료' || c.status === '취소') continue;
    if (!admittedSlotKeys.has(c.reservedSlot)) continue;
    // 이미 같은 iteration 에서 업데이트된 경우 중복 방지
    if (admitUpdates[`consultations/${conId}/status`] === '입원완료') continue;
    admitUpdates[`consultations/${conId}/reservedSlot`] = null;
    admitUpdates[`consultations/${conId}/status`] = '입원완료';
    safetyNetCount++;
    console.log(`  🛡 안전망: ${c.name || '?'} (${conId}) reservedSlot=${c.reservedSlot} → 입원완료 + null`);
  }

  if (Object.keys(admitUpdates).length > 0) {
    await db.ref('/').update(admitUpdates);
  }
  console.log(`  ✅ 상태 업데이트: ${statusUpdateCount}건 / 자동 생성: ${autoCreateCount}건 / 안전망: ${safetyNetCount}건\n`);

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
  // EMR 싱크 완료 시간 기록 + 이전 실패 상태 클리어
  await db.ref('emrSyncLog/lastSync').set(new Date().toISOString());
  await db.ref('emrSyncLog/lastError').set(null);

  console.log('─'.repeat(50));
  console.log(`🎉 ${FULL_MODE ? '전체' : '경량'} 동기화 완료!`);
  if (FULL_MODE) {
    console.log(`   [0]   차트번호 중복 정리`);
    console.log(`   [0.5] 구형 슬롯 키 마이그레이션`);
  }
  console.log(`   [1]   환자 마스터: ${patEntries.length}명${FULL_MODE ? '' : ' (입원환자만)'}`);
  console.log(`   [2]   병상 입원: ${setCount}개 / 퇴원: ${clearCount}개 / 병실이동: ${transferCount}개`);
  console.log(`   [2.5] 상담연결: ${conLinkCount}건`);
  console.log(`   [2.6] 입원상태: 업데이트 ${statusUpdateCount}건 / 자동생성 ${autoCreateCount}건`);
  if (FULL_MODE) {
    console.log(`   [3]   입원이력: ${histSize}명 / ${histTotal}건`);
  }

  await sql.close();
  process.exit(0);
}

main().catch(async err => {
  console.error('❌ 오류:', err.message);
  // Firebase에 실패 상태 기록 — UI/진단 스크립트에서 감지 가능하도록.
  // (conRaw 누락 같은 회귀가 조용히 며칠씩 누적되는 것을 방지)
  try {
    await db.ref('emrSyncLog/lastError').set({
      ts:    new Date().toISOString(),
      mode:  FULL_MODE ? 'full' : 'light',
      phase: 'unknown',
      msg:   String(err && err.message || err),
      stack: String(err && err.stack || '').slice(0, 2000),
    });
  } catch {}
  sql.close().catch(() => {});
  process.exit(1);
});
