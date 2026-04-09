/**
 * EMR → Firebase 치료계획표 동기화 (201호 테스트)
 * - 일치 항목: emr:"match"
 * - EMR에만 있는 항목: emr:"added"  (추가)
 * - Firebase에만 있는 항목: emr:"removed" (삭제 표시)
 * - 수량 불일치: emr:"modified", 기존 qty를 EMR 기준으로 변경
 *
 * 실행: node scripts/syncTreatmentEMR.js [roomId]
 *   예: node scripts/syncTreatmentEMR.js 201
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

// 전체 호실 목록
const ALL_ROOMS = [
  '201','202','203','204','205','206',
  '301','302','303','304','305','306',
  '501','502','503','504','505','506',
  '601','602','603',
];

async function main() {
  const argRoom = process.argv[2];
  const targetRooms = argRoom ? [argRoom] : ALL_ROOMS;
  const maxBeds = 6;

  console.log(`🏥 치료계획표 EMR 연동 시작 (${argRoom ? argRoom+'호' : '전체 호실'})`);
  console.log(`📅 기준일: ~${TODAY} (오늘 미포함)\n`);

  const pool = await sql.connect(sqlConfig);

  // 대상 호실 전체에서 환자 조회
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

  const fbUpdates = {};
  let matchCount = 0, addCount = 0, removeCount = 0, modifyCount = 0;

  for (const pat of patients) {
    console.log('─'.repeat(50));
    console.log(`[${pat.slotKey}] ${pat.name} (입원:${pat.admitDate})`);

    const admitYMD = pat.admitDate.replace(/-/g, '');

    // EMR 비급여 처방 조회
    const emrRes = await pool.request().query(`
      SELECT d.idam_date, d.idam_momn, d.idam_dosage, d.idam_times,
        d.idam_day, d.idam_amt, d.idam_bigub
      FROM Widam d
      WHERE d.idam_cham = '${pat.chartNo}'
        AND d.idam_in_date = '${admitYMD}'
        AND d.idam_bigub = 1
        AND d.idam_date >= '${admitYMD}'
        AND d.idam_date < '${TODAY}'
      ORDER BY d.idam_date, d.idam_cnt
    `);

    // EMR → 날짜별 치료항목 변환
    const emrByDate = {}; // { 'YYYY-MM': { 'D': { itemId: {id, qty} } } }
    for (const row of emrRes.recordset) {
      const code = row.idam_momn.trim();
      const mapping = EMR_TO_PLAN[code];
      if (!mapping) continue;

      const dateStr = row.idam_date.trim();
      const monthKey = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}`;
      const day = String(parseInt(dateStr.slice(6,8)));

      if (!emrByDate[monthKey]) emrByDate[monthKey] = {};
      if (!emrByDate[monthKey][day]) emrByDate[monthKey][day] = {};

      const itemId = mapping.id;
      let qty;
      if (mapping.vitcG) qty = mapping.vitcG;
      else if (mapping.qtyField === 'dosage') qty = row.idam_dosage;
      else if (mapping.qtyField === 'times') qty = row.idam_times || 1;
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

    // combo 항목 정리 (dramin은 닥터라민+멀티주 2개가 있어야 1세트)
    for (const mk of Object.keys(emrByDate)) {
      for (const d of Object.keys(emrByDate[mk])) {
        for (const [id, item] of Object.entries(emrByDate[mk][d])) {
          if (item._combo !== undefined) {
            delete item._combo;
          }
        }
      }
    }

    // Firebase 치료계획표 조회
    const fbSnap = await db.ref(`treatmentPlans/${pat.slotKey}`).once('value');
    const fbPlan = fbSnap.val() || {};

    // 입원일~오늘 사이 날짜 범위 계산
    const admitDate = new Date(pat.admitDate);
    const todayDate = new Date(`${TODAY.slice(0,4)}-${TODAY.slice(4,6)}-${TODAY.slice(6,8)}`);

    // 대상 월 목록 계산
    const months = new Set();
    for (let d = new Date(admitDate); d < todayDate; d.setDate(d.getDate() + 1)) {
      months.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
    }

    // 월별로 처리
    for (const monthKey of months) {
      const emrMonth = emrByDate[monthKey] || {};
      const fbMonth  = fbPlan[monthKey] || {};

      const [yr, mo] = monthKey.split('-').map(Number);
      const daysInMonth = new Date(yr, mo, 0).getDate();

      // 대상 일자 범위 (입원일~오늘 사이)
      const startDay = (monthKey === `${admitDate.getFullYear()}-${String(admitDate.getMonth()+1).padStart(2,'0')}`)
        ? admitDate.getDate() : 1;
      const endDay = (monthKey === `${todayDate.getFullYear()}-${String(todayDate.getMonth()+1).padStart(2,'0')}`)
        ? todayDate.getDate() - 1 : daysInMonth;

      for (let day = startDay; day <= endDay; day++) {
        const dayStr = String(day);
        const emrItems = emrMonth[dayStr] || {};
        const fbItems  = Array.isArray(fbMonth[dayStr]) ? fbMonth[dayStr]
                       : fbMonth[dayStr] ? Object.values(fbMonth[dayStr]) : [];

        // Firebase 항목을 id 기준 Map으로
        const fbMap = {};
        for (const item of fbItems) {
          if (item && item.id) fbMap[item.id] = { ...item };
        }

        const allIds = new Set([...Object.keys(emrItems), ...Object.keys(fbMap)]);
        if (allIds.size === 0) continue;

        const newItems = [];

        for (const itemId of allIds) {
          const inEmr = emrItems[itemId];
          const inFb  = fbMap[itemId];

          if (inEmr && inFb) {
            // 양쪽 모두 존재
            const emrQty = inEmr.qty;
            const fbQty  = inFb.qty;

            if (emrQty !== undefined && fbQty !== undefined &&
                Number(emrQty) !== Number(fbQty)) {
              // 수량 불일치 → EMR 기준으로 수정
              newItems.push({ id: itemId, qty: emrQty, emr: 'modified' });
              console.log(`  ${monthKey}/${dayStr} ${itemId}: 수량 수정 (${fbQty}→${emrQty})`);
              modifyCount++;
            } else {
              // 일치 → V 체크
              const entry = { id: itemId, emr: 'match' };
              if (inFb.qty !== undefined) entry.qty = inFb.qty;
              newItems.push(entry);
              matchCount++;
            }
          } else if (inEmr && !inFb) {
            // EMR에만 있음 → 추가
            const entry = { id: itemId, emr: 'added' };
            if (inEmr.qty !== undefined) entry.qty = inEmr.qty;
            newItems.push(entry);
            console.log(`  ${monthKey}/${dayStr} ${itemId}: ➕ 추가${inEmr.qty ? ' ('+inEmr.qty+')' : ''}`);
            addCount++;
          } else if (!inEmr && inFb) {
            // Firebase에만 있음
            if (itemId === 'hyperbaric') {
              // 고압산소치료는 EMR 연동 제외 (치료실 현황에서만 관리)
              newItems.push({ ...inFb });
            } else {
              // 그 외 항목 → 삭제 표시
              const entry = { ...inFb, emr: 'removed' };
              newItems.push(entry);
              console.log(`  ${monthKey}/${dayStr} ${itemId}: ➖ 삭제 표시`);
              removeCount++;
            }
          }
        }

        // Firebase 경로에 업데이트 등록
        fbUpdates[`treatmentPlans/${pat.slotKey}/${monthKey}/${dayStr}`] = newItems;
      }
    }
  }

  // Firebase 반영
  const entries = Object.entries(fbUpdates);
  if (entries.length > 0) {
    console.log('\n' + '─'.repeat(50));
    console.log(`🔥 Firebase 업데이트: ${entries.length}개 날짜`);
    for (let i = 0; i < entries.length; i += 500) {
      await db.ref('/').update(Object.fromEntries(entries.slice(i, i + 500)));
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log('✅ 치료계획표 EMR 연동 완료');
  console.log(`   ✅ 일치:  ${matchCount}건`);
  console.log(`   ➕ 추가:  ${addCount}건`);
  console.log(`   ➖ 삭제:  ${removeCount}건`);
  console.log(`   ✏️  수정:  ${modifyCount}건`);

  await sql.close();
  process.exit(0);
}

main().catch(err => {
  console.error('❌', err.message);
  sql.close().catch(() => {});
  process.exit(1);
});
