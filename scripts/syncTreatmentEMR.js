/**
 * EMR → Firebase 치료계획표 동기화
 *
 * 규칙:
 *   - 어제까지: EMR 우선. EMR에만 있음=added, Firebase에만 있음=removed, 수량 불일치=modified
 *   - 오늘 이후: 삭제 로직 없이 일치 여부만 표시. Firebase에만 있으면 원본 유지(태그 제거)
 *   - hyperbaric(고압산소)는 EMR 연동 제외
 *   - 주치의(VIEWJUBLIST.dctrName): 강국형/이숙경만 인정, slots/{sk}/current/attending 갱신
 *   - Widam/VIEWJUBLIST 쿼리는 IN 절 벌크화
 *
 * 실행: node scripts/syncTreatmentEMR.js [roomId]
 */
require('dotenv').config({ path: '.env.local' });
const sql   = require('mssql');
const admin = require('firebase-admin');

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
  requestTimeout: 120000,
  options: { encrypt: false, trustServerCertificate: true },
};

// ── EMR 코드 → 치료계획표 ID 매핑 ──
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

const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
const TODAY_INT = parseInt(TODAY);

const ALL_ROOMS = [
  '201','202','203','204','205','206',
  '301','302','303','304','305','306',
  '501','502','503','504','505','506',
  '601','602','603',
];

function computeMaxPlanYMD(fbPlan) {
  let maxYMD = TODAY;
  for (const mk of Object.keys(fbPlan || {})) {
    const [yr, mo] = mk.split('-').map(Number);
    if (!yr || !mo) continue;
    for (const d of Object.keys(fbPlan[mk] || {})) {
      const dayNum = parseInt(d);
      if (isNaN(dayNum)) continue;
      const ymd = `${yr}${String(mo).padStart(2,'0')}${String(dayNum).padStart(2,'0')}`;
      if (ymd > maxYMD) maxYMD = ymd;
    }
  }
  return maxYMD;
}

function attendingOf(raw) {
  const s = (raw || '').trim();
  if (s.includes('강국형')) return '강국형';
  if (s.includes('이숙경')) return '이숙경';
  return '';
}

async function main() {
  const argRoom = process.argv[2];
  const targetRooms = argRoom ? [argRoom] : ALL_ROOMS;
  const maxBeds = 6;

  console.log(`🏥 치료계획표 EMR 연동 시작 (${argRoom ? argRoom+'호' : '전체 호실'})`);
  console.log(`📅 오늘: ${TODAY}\n`);

  const pool = await sql.connect(sqlConfig);

  // ── 1) 입원환자 수집 ──
  const patients = [];
  for (const roomId of targetRooms) {
    for (let bed = 1; bed <= maxBeds; bed++) {
      const sk = `${roomId}-${bed}`;
      const snap = await db.ref(`slots/${sk}/current`).once('value');
      if (snap.exists() && snap.val()?.name) {
        patients.push({ slotKey: sk, ...snap.val() });
      }
    }
  }

  if (patients.length === 0) {
    console.log('입원환자가 없습니다.');
    await sql.close(); process.exit(0);
  }

  console.log(`환자 ${patients.length}명: ${patients.map(p => `${p.slotKey} ${p.name}`).join(', ')}\n`);

  // ── 2) Firebase 치료계획표 사전 로드 + maxPlanYMD 계산 ──
  await Promise.all(patients.map(async pat => {
    const fbSnap = await db.ref(`treatmentPlans/${pat.slotKey}`).once('value');
    pat.fbPlan = fbSnap.val() || {};
    pat.maxPlanYMD = computeMaxPlanYMD(pat.fbPlan);
  }));

  const globalMaxYMD = patients.reduce((m, p) =>
    p.maxPlanYMD > m ? p.maxPlanYMD : m, TODAY);
  const minAdmitYMD = patients.reduce((m, p) => {
    const ymd = (p.admitDate || '').replace(/-/g, '');
    if (!ymd) return m;
    return !m || ymd < m ? ymd : m;
  }, null);

  const chartNos = patients
    .map(p => (p.chartNo || '').toString().trim())
    .filter(c => /^[0-9A-Za-z\-]+$/.test(c));

  // ── 3) 주치의 벌크 조회 (VIEWJUBLIST) ──
  const attMap = {};
  if (chartNos.length) {
    const inList = chartNos.map(c => `'${c}'`).join(',');
    try {
      const attRes = await pool.request().query(`
        SELECT x.chamKey, x.dctrName FROM (
          SELECT chamKey, dctrName,
            ROW_NUMBER() OVER (PARTITION BY chamKey ORDER BY (SELECT NULL)) AS rn
          FROM VIEWJUBLIST WHERE chamKey IN (${inList})
        ) x WHERE x.rn = 1
      `);
      for (const r of attRes.recordset) {
        attMap[String(r.chamKey).trim()] = attendingOf(r.dctrName);
      }
    } catch (e) {
      console.error('주치의 조회 오류:', e.message);
    }
  }

  // ── 4) Widam 벌크 쿼리 ──
  const emrByPat = {};
  if (chartNos.length && minAdmitYMD) {
    const inList = chartNos.map(c => `'${c}'`).join(',');
    const emrRes = await pool.request().query(`
      SELECT RTRIM(d.idam_cham) AS chartNo,
             d.idam_in_date AS inDate, d.idam_date AS dt,
             d.idam_momn AS code,
             d.idam_dosage AS dosage, d.idam_times AS times
      FROM Widam d
      WHERE d.idam_cham IN (${inList})
        AND d.idam_bigub = 1
        AND d.idam_date >= '${minAdmitYMD}'
        AND d.idam_date <= '${globalMaxYMD}'
      ORDER BY d.idam_cham, d.idam_date
    `);
    for (const row of emrRes.recordset) {
      const cham = String(row.chartNo).trim();
      if (!emrByPat[cham]) emrByPat[cham] = [];
      emrByPat[cham].push(row);
    }
  }

  // ── 5) 환자별 처리 ──
  const fbUpdates = {};
  let matchCount = 0, addCount = 0, removeCount = 0, modifyCount = 0;

  for (const pat of patients) {
    const chart = (pat.chartNo || '').toString().trim();
    const att = attMap[chart] || '';
    console.log('─'.repeat(50));
    console.log(`[${pat.slotKey}] ${pat.name} (입원:${pat.admitDate}) 주치의:${att || '-'}`);

    // 주치의 갱신
    if (pat.chartNo) {
      fbUpdates[`slots/${pat.slotKey}/current/attending`] = att;
    }

    const admitYMD = (pat.admitDate || '').replace(/-/g, '');
    if (!admitYMD) continue;

    // 현재 입원건만 필터 (idam_in_date == admitYMD)
    const rows = (emrByPat[chart] || [])
      .filter(r => String(r.inDate).trim() === admitYMD);

    // EMR → 날짜별 치료항목 변환
    const emrByDate = {};
    for (const row of rows) {
      const code = (row.code || '').trim();
      const mapping = EMR_TO_PLAN[code];
      if (!mapping) continue;

      const dateStr = String(row.dt).trim();
      const monthKey = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}`;
      const day = String(parseInt(dateStr.slice(6,8)));

      if (!emrByDate[monthKey]) emrByDate[monthKey] = {};
      if (!emrByDate[monthKey][day]) emrByDate[monthKey][day] = {};

      const itemId = mapping.id;
      let qty;
      if (mapping.vitcG) qty = mapping.vitcG;
      else if (mapping.qtyField === 'dosage') qty = row.dosage;
      else if (mapping.qtyField === 'times') qty = row.times || 1;
      else qty = undefined;

      if (mapping.combo) {
        if (!emrByDate[monthKey][day][itemId]) {
          emrByDate[monthKey][day][itemId] = { id: itemId, _combo: 0 };
        }
        emrByDate[monthKey][day][itemId]._combo++;
        continue;
      }

      if (emrByDate[monthKey][day][itemId]) {
        if (qty !== undefined) {
          emrByDate[monthKey][day][itemId].qty =
            (emrByDate[monthKey][day][itemId].qty || 0) + qty;
        }
      } else {
        const entry = { id: itemId };
        if (qty !== undefined) entry.qty = qty;
        emrByDate[monthKey][day][itemId] = entry;
      }
    }

    // combo 태그 정리
    for (const mk of Object.keys(emrByDate)) {
      for (const d of Object.keys(emrByDate[mk])) {
        for (const [, item] of Object.entries(emrByDate[mk][d])) {
          if (item._combo !== undefined) delete item._combo;
        }
      }
    }

    const fbPlan = pat.fbPlan || {};
    const admitDate = new Date(
      `${admitYMD.slice(0,4)}-${admitYMD.slice(4,6)}-${admitYMD.slice(6,8)}`
    );
    const maxDate = new Date(
      `${pat.maxPlanYMD.slice(0,4)}-${pat.maxPlanYMD.slice(4,6)}-${pat.maxPlanYMD.slice(6,8)}`
    );

    const months = new Set();
    for (let d = new Date(admitDate); d <= maxDate; d.setDate(d.getDate() + 1)) {
      months.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
    }

    for (const monthKey of months) {
      const emrMonth = emrByDate[monthKey] || {};
      const fbMonth  = fbPlan[monthKey] || {};

      const [yr, mo] = monthKey.split('-').map(Number);
      const daysInMonth = new Date(yr, mo, 0).getDate();

      const startDay = (monthKey === `${admitDate.getFullYear()}-${String(admitDate.getMonth()+1).padStart(2,'0')}`)
        ? admitDate.getDate() : 1;
      const endDay = (monthKey === `${maxDate.getFullYear()}-${String(maxDate.getMonth()+1).padStart(2,'0')}`)
        ? maxDate.getDate() : daysInMonth;

      for (let day = startDay; day <= endDay; day++) {
        const dayStr = String(day);
        const emrItems = emrMonth[dayStr] || {};
        const fbItems  = Array.isArray(fbMonth[dayStr]) ? fbMonth[dayStr]
                       : fbMonth[dayStr] ? Object.values(fbMonth[dayStr]) : [];

        const fbMap = {};
        for (const item of fbItems) {
          if (item && item.id) fbMap[item.id] = { ...item };
        }

        const allIds = new Set([...Object.keys(emrItems), ...Object.keys(fbMap)]);
        if (allIds.size === 0) continue;

        const dayYMD = parseInt(`${yr}${String(mo).padStart(2,'0')}${String(day).padStart(2,'0')}`);
        const isTodayOrFuture = dayYMD >= TODAY_INT;

        const newItems = [];

        for (const itemId of allIds) {
          const inEmr = emrItems[itemId];
          const inFb  = fbMap[itemId];

          if (inEmr && inFb) {
            const emrQty = inEmr.qty;
            const fbQty  = inFb.qty;

            if (emrQty !== undefined && fbQty !== undefined &&
                Number(emrQty) !== Number(fbQty)) {
              newItems.push({ id: itemId, qty: emrQty, emr: 'modified' });
              console.log(`  ${monthKey}/${dayStr} ${itemId}: 수량 수정 (${fbQty}→${emrQty})`);
              modifyCount++;
            } else {
              const entry = { id: itemId, emr: 'match' };
              if (inFb.qty !== undefined) entry.qty = inFb.qty;
              newItems.push(entry);
              matchCount++;
            }
          } else if (inEmr && !inFb) {
            const entry = { id: itemId, emr: 'added' };
            if (inEmr.qty !== undefined) entry.qty = inEmr.qty;
            newItems.push(entry);
            console.log(`  ${monthKey}/${dayStr} ${itemId}: ➕ 추가${inEmr.qty ? ' ('+inEmr.qty+')' : ''}`);
            addCount++;
          } else if (!inEmr && inFb) {
            if (itemId === 'hyperbaric') {
              newItems.push({ ...inFb });
            } else if (isTodayOrFuture) {
              // 오늘 이후: 삭제 태깅 금지. 기존 emr 태그는 제거해 원본으로 복원
              const { emr, ...rest } = inFb;
              newItems.push(rest);
            } else {
              newItems.push({ ...inFb, emr: 'removed' });
              console.log(`  ${monthKey}/${dayStr} ${itemId}: ➖ 삭제 표시`);
              removeCount++;
            }
          }
        }

        fbUpdates[`treatmentPlans/${pat.slotKey}/${monthKey}/${dayStr}`] = newItems;
      }
    }
  }

  // ── 6) Firebase 반영 ──
  const entries = Object.entries(fbUpdates);
  if (entries.length > 0) {
    console.log('\n' + '─'.repeat(50));
    console.log(`🔥 Firebase 업데이트: ${entries.length}개 경로`);
    for (let i = 0; i < entries.length; i += 500) {
      await db.ref('/').update(Object.fromEntries(entries.slice(i, i + 500)));
    }
  }

  // ── 7) 싱크 로그 ──
  await db.ref('emrSyncLog/lastSync').set(new Date().toISOString());
  await db.ref('emrSyncLog/lastCounts').set({
    match: matchCount, added: addCount, removed: removeCount, modified: modifyCount,
    patients: patients.length,
  });

  console.log('\n' + '═'.repeat(50));
  console.log('✅ 치료계획표 EMR 연동 완료');
  console.log(`   ✅ 일치:  ${matchCount}건`);
  console.log(`   ➕ 추가:  ${addCount}건`);
  console.log(`   ➖ 삭제:  ${removeCount}건 (어제 이전만)`);
  console.log(`   ✏️  수정:  ${modifyCount}건`);

  await sql.close();
  process.exit(0);
}

main().catch(err => {
  console.error('❌', err.message);
  sql.close().catch(() => {});
  process.exit(1);
});
