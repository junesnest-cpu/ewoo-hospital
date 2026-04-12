import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set, update } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

const DOW = ["일","월","화","수","목","금","토"];

// 유효한 병상 목록 (index.js와 동일 범위 — 이 외 슬롯은 유령 데이터로 간주)
const WARD_ROOMS = [
  {id:"201",cap:4},{id:"202",cap:1},{id:"203",cap:4},{id:"204",cap:2},{id:"205",cap:6},{id:"206",cap:6},
  {id:"301",cap:4},{id:"302",cap:1},{id:"303",cap:4},{id:"304",cap:2},{id:"305",cap:2},{id:"306",cap:6},
  {id:"501",cap:4},{id:"502",cap:1},{id:"503",cap:4},{id:"504",cap:2},{id:"505",cap:6},{id:"506",cap:6},
  {id:"601",cap:6},{id:"602",cap:1},{id:"603",cap:6},
];

function parseMD(str, year, month) {
  if (!str || str === "미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
}
function parseISO(str) {
  if (!str) return null;
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}
function toYM(year, month) {
  return `${year}-${String(month).padStart(2,"0")}`;
}
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}
function slotKeyToRoom(slotKey) {
  const [roomId, bedNum] = slotKey.split("-");
  return roomId ? `${roomId}-${bedNum}` : slotKey;
}
function dateKey(d) {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
// 이름 정규화: "신)박은정" → "박은정" 등 비교용 (동명이인 숫자는 보존)
function normName(name) {
  return (name || "").replace(/^신\)\s*/, "").trim().toLowerCase();
}
function uid() { return Math.random().toString(36).slice(2,9); }
function parseDateStr(str, contextYear) {
  if (!str || str === "미정") return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return parseISO(str);
  const m = str.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return new Date(contextYear, parseInt(m[1])-1, parseInt(m[2]));
  return null;
}

const EMPTY_ADM = () => ({ id:uid(), name:"", room:"", isNew:false, isReserved:false, note:"", time:"" });
const EMPTY_DIS = () => ({ id:uid(), name:"", room:"", note:"", time:"" });

const TIME_OPTIONS = ["아침 후","점심 후","저녁 후"];

export default function MonthlySchedule() {
  const router = useRouter();
  const isMobile = useIsMobile();

  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [slots, setSlots] = useState({});
  const [consultations, setConsultations] = useState({});

  // 공지/메모
  const [memo, setMemo] = useState("");
  const [memoEdit, setMemoEdit] = useState("");
  const [memoEditing, setMemoEditing] = useState(false);
  const [memoSaving, setMemoSaving] = useState(false);

  // 편집된 월간 데이터 (Firebase monthlyBoards/{YYYY-MM})
  const [boardData, setBoardData] = useState({});

  // 신환 플래그 (공유 저장소: 일일현황판과 동기화)
  const [newPatientFlags, setNewPatientFlags] = useState({});

  // 날짜 편집 모달
  const [editModal, setEditModal] = useState(null); // "YYYY-MM-DD" | null
  const [editAdm, setEditAdm] = useState([]);
  const [editDis, setEditDis] = useState([]);
  const [editSaving, setEditSaving] = useState(false);

  // 인라인 추가 팝오버
  const [popover, setPopover] = useState(null); // { dateKey, type, rect }

  // 과거 날짜 자동 스냅샷 추적용
  const frozenKeysRef = useRef(new Set());

  // 사이드바 환자 이름 하이라이트
  const [filterName, setFilterName] = useState("");
  const dayCellRefs = useRef({});
  const searchHandlerRef = useRef(null);
  searchHandlerRef.current = (q) => {
    setFilterName(q);
    // 해당 이름이 있는 첫 날짜 셀로 스크롤
    setTimeout(() => {
      const total = daysInMonth(year, month);
      for (let d = 1; d <= total; d++) {
        const key = `${year}-${String(month).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
        const dd = getDisplayData(key);
        const found = [...(dd.admissions||[]), ...(dd.discharges||[])].some(p => p.name?.includes(q));
        if (found && dayCellRefs.current[key]) {
          dayCellRefs.current[key].scrollIntoView({ behavior:"smooth", block:"center" });
          break;
        }
      }
    }, 100);
  };
  useEffect(() => {
    const handler = (e) => { const q = e.detail?.q; if (q) searchHandlerRef.current?.(q); };
    window.addEventListener("sidebar-search", handler);
    return () => window.removeEventListener("sidebar-search", handler);
  }, []);

  const [dailyBoards, setDailyBoards] = useState({});

  useEffect(() => {
    const u1 = onValue(ref(db,"slots"), snap => setSlots(snap.val() || {}));
    const u2 = onValue(ref(db,"consultations"), snap => setConsultations(snap.val() || {}));
    const u3 = onValue(ref(db,"newPatientFlags"), snap => setNewPatientFlags(snap.val() || {}));
    return () => { u1(); u2(); u3(); };
  }, []);

  // 일일현황판 데이터 로드 (해당 월 전체)
  useEffect(() => {
    const ym = toYM(year, month);
    const total = daysInMonth(year, month);
    const unsubs = [];
    const boards = {};
    for (let d = 1; d <= total; d++) {
      const dateStr = `${ym}-${String(d).padStart(2,"0")}`;
      unsubs.push(onValue(ref(db, `dailyBoards/${dateStr}`), snap => {
        const val = snap.val();
        if (val) boards[dateStr] = val;
        else delete boards[dateStr];
        setDailyBoards({ ...boards });
      }));
    }
    return () => unsubs.forEach(u => u());
  }, [year, month]);

  // 자동완성용 전체 환자 목록 (MonthlySchedule 레벨에서 계산)
  const allPatients = useMemo(() => {
    const list = [];
    const seenNorm = new Set();
    const add = (p) => {
      const nk = normName(p.name);
      if (seenNorm.has(nk)) return;
      seenNorm.add(nk);
      list.push(p);
    };
    Object.entries(slots || {}).forEach(([slotKey, slot]) => {
      const [roomId, bedNum] = slotKey.split("-");
      const room = `${roomId}-${bedNum}`;
      if (slot?.current?.name) {
        add({ name: slot.current.name, room, note: slot.current.note || "",
          isNew: false, isReserved: false, source:"current", sourceBadge:"입원중",
          doctor: slot.current.doctor || "" });
      }
      (slot?.reservations || []).forEach(r => {
        if (r?.name) add({ name: r.name, room, note: r.note || "",
          isNew: false, isReserved: true, source:"reservation", sourceBadge:"예약",
          doctor: "" });
      });
    });
    Object.values(consultations || {}).forEach(c => {
      if (!c?.name) return;
      const noteFields = [];
      if (c.birthYear) noteFields.push(`${new Date().getFullYear()-parseInt(c.birthYear)}세`);
      if (c.diagnosis) noteFields.push(c.diagnosis);
      if (c.hospital)  noteFields.push(c.hospital);
      if (c.surgery)   noteFields.push(c.surgeryDate ? `수술후(${c.surgeryDate})` : "수술후");
      if (c.chemo)     noteFields.push(c.chemoDate   ? `항암(${c.chemoDate})`     : "항암중");
      if (c.radiation) noteFields.push("방사선");
      const cIsNew = c.isNewPatient !== undefined ? !!c.isNewPatient : !c.patientId;
      add({ name: c.name, room: c.roomTypes?.join("/") || "",
        note: noteFields.join(" · "),
        isNew: cIsNew, isReserved: c.status === "예약완료",
        source:"consultation", sourceBadge:"상담",
        doctor: "" });
    });
    return list;
  }, [slots, consultations]);

  // 월간 보드 데이터 로드
  useEffect(() => {
    const u = onValue(ref(db, `monthlyBoards/${toYM(year, month)}`), snap => {
      setBoardData(snap.val() || {});
    });
    return () => u();
  }, [year, month]);

  // 메모 로드
  const memoKey = toYM(year, month);
  useEffect(() => {
    const u = onValue(ref(db, `monthlyMemos/${memoKey}`), snap => {
      const val = snap.val() || "";
      setMemo(val);
      setMemoEdit(val);
      setMemoEditing(false);
    });
    return () => u();
  }, [memoKey]);

  async function saveMemo() {
    setMemoSaving(true);
    await set(ref(db, `monthlyMemos/${memoKey}`), memoEdit);
    setMemoSaving(false);
    setMemoEditing(false);
  }

  // slots + consultations에서 자동 계산된 데이터
  const calendarData = useMemo(() => {
    const data = {};
    const ensure = (key) => { if (!data[key]) data[key] = { admissions:[], discharges:[] }; };

    // 신환 판별용: isNewPatient 명시 설정 우선, 없으면 patientId 없음 = 신환
    const consultNewById = {};
    const consultNewByName = new Set();
    Object.entries(consultations).forEach(([cid, c]) => {
      if (!c?.name) return;
      if (c.status === "취소" || c.status === "입원완료") return;
      const isNew = c.isNewPatient !== undefined ? !!c.isNewPatient : !c.patientId;
      consultNewById[cid] = isNew;
      if (isNew) consultNewByName.add(normName(c.name));
    });
    // 일일현황판에서 ★ 신규 표시한 환자도 포함
    Object.values(dailyBoards).forEach(db => {
      (db.admissions || []).forEach(a => {
        if (a.isNew && a.name) consultNewByName.add(normName(a.name));
      });
    });

    Object.entries(slots).forEach(([slotKey, slot]) => {
      const roomLabel = slotKeyToRoom(slotKey);
      const cur = slot?.current;
      if (cur?.name) {
        const aKey = dateKey(parseMD(cur.admitDate, year, month));
        const dKey = dateKey(parseMD(cur.discharge, year, month));
        // 현재 입원 환자: consultationId 직접 연결 또는 이름 매칭으로 신환 판별
        const curIsNew = cur.consultationId ? !!consultNewById[cur.consultationId]
          : consultNewByName.has(normName(cur.name));
        if (aKey) { ensure(aKey); data[aKey].admissions.push({ id:uid(), name:cur.name, room:roomLabel, note:cur.note||"", isNew:curIsNew, isReserved:false, time:cur.admitTime||"", _slotKey:slotKey, _consultationId:cur.consultationId||"" }); }
        if (dKey) { ensure(dKey); data[dKey].discharges.push({ id:uid(), name:cur.name, room:roomLabel, note:cur.discharge||"", time:cur.dischargeTime||"", _slotKey:slotKey }); }
      }
      (slot?.reservations || []).forEach(r => {
        if (!r?.name) return;
        const aKey = dateKey(parseMD(r.admitDate, year, month));
        const dKey = dateKey(parseMD(r.discharge, year, month));
        // 예약 환자: consultationId 직접 연결 또는 이름 매칭으로 신환 판별
        const rIsNew = r.consultationId ? !!consultNewById[r.consultationId]
          : consultNewByName.has(normName(r.name));
        if (aKey) { ensure(aKey); data[aKey].admissions.push({ id:uid(), name:r.name, room:roomLabel, note:r.note||"", isNew:rIsNew, isReserved:true, time:r.admitTime||"", _slotKey:slotKey, _consultationId:r.consultationId||"" }); }
        if (dKey) { ensure(dKey); data[dKey].discharges.push({ id:uid(), name:r.name, room:roomLabel, note:r.discharge||"", time:r.dischargeTime||"", _slotKey:slotKey }); }
      });
    });

    // 이름 → 실제 병실 매핑 (슬롯에 배정된 환자의 실제 병실 조회용)
    const nameToSlotRoom = {};
    Object.entries(slots).forEach(([slotKey, slot]) => {
      if (slot?.current?.name) {
        const n = normName(slot.current.name);
        if (n) nameToSlotRoom[n] = slotKeyToRoom(slotKey);
      }
    });

    // consultations: 슬롯에 미배정된 신환만 추가 (슬롯 배정된 환자는 이미 위에서 신환 플래그 처리됨)
    Object.entries(consultations).forEach(([cid, c]) => {
      if (!c?.name || !c.admitDate) return;
      const cIsNew = c.isNewPatient !== undefined ? !!c.isNewPatient : !c.patientId;
      if (!cIsNew) return;                                    // 재입원 → 제외
      if (c.status === "취소" || c.status === "입원완료") return;
      const admitD = parseISO(c.admitDate);
      if (!admitD) return;
      const aKey = dateKey(admitD);
      if (!aKey) return;
      ensure(aKey);

      const noteFields = [c.diagnosis, c.hospital].filter(Boolean);
      if (c.surgery) noteFields.push(c.surgeryDate ? `수술후(${c.surgeryDate})` : "수술후");
      if (c.chemo)   noteFields.push(c.chemoDate   ? `항암(${c.chemoDate})`     : "항암중");
      if (c.radiation) noteFields.push("방사선");
      const cNote = noteFields.join(" · ");

      const nc = normName(c.name);
      // 슬롯에 배정된 환자면 실제 병실 사용, 아니면 상담의 희망 병실유형
      const actualRoom = nameToSlotRoom[nc] || c.roomTypes?.join("/") || "";

      // 같은 날짜에 이미 슬롯 기반 항목이 있으면 병합
      const existIdx = data[aKey].admissions.findIndex(a => normName(a.name) === nc);

      if (existIdx >= 0) {
        // 슬롯 항목에 신환 정보 병합 (실제 병실은 슬롯 값 유지, ★신환 플래그 추가)
        const ex = data[aKey].admissions[existIdx];
        data[aKey].admissions[existIdx] = {
          ...ex,
          isNew: true,
          note: cNote || ex.note,
        };
      } else {
        // 다른 날짜에 슬롯 항목이 있는지도 확인 (날짜 변경된 경우)
        let mergedElsewhere = false;
        if (nameToSlotRoom[nc]) {
          // 슬롯에 이미 배정된 환자 → 다른 날짜의 기존 항목에 신환 플래그만 추가
          for (const dk of Object.keys(data)) {
            const idx = data[dk].admissions.findIndex(a => normName(a.name) === nc);
            if (idx >= 0) {
              data[dk].admissions[idx] = { ...data[dk].admissions[idx], isNew: true, note: cNote || data[dk].admissions[idx].note };
              mergedElsewhere = true;
              break;
            }
          }
        }
        if (!mergedElsewhere) {
          data[aKey].admissions.push({
            id: uid(),
            name: c.name,
            room: actualRoom,
            note: cNote,
            isNew: true,
            isReserved: false,
            _consultationId: cid,
          });
        }
      }
    });
    return data;
  }, [slots, consultations, dailyBoards, year, month]);

  // 당일 누적 병합: 슬롯/상담에서 새로 감지된 입퇴원을 frozen 스냅샷에 추가
  // (과거 날짜는 syncEMR이 이벤트 기반으로 기록하므로 프론트엔드에서 건드리지 않음)
  useEffect(() => {
    if (!Object.keys(slots).length) return;
    const today = new Date(); today.setHours(0,0,0,0);
    const ym = toYM(year, month);

    // 당월이 아니면 건너뜀
    if (year !== today.getFullYear() || month !== (today.getMonth()+1)) return;

    const key = `${year}-${String(month).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    const bd = boardData[key];
    const cd = calendarData[key] || { admissions:[], discharges:[] };

    // live 데이터: calendarData + boardData(수동 추가분) 병합
    const mergeCdBd = () => {
      if (!bd || bd.frozen) return { admissions: cd.admissions || [], discharges: cd.discharges || [] };
      const hiddenAdm = new Set(bd.hiddenAdmissions || []);
      const hiddenDis = new Set(bd.hiddenDischarges || []);
      const baseAdm = (cd.admissions || []).filter(a => !hiddenAdm.has(normName(a.name)));
      const baseDis = (cd.discharges || []).filter(dd => !hiddenDis.has(normName(dd.name)));
      const cdAdmNorms = new Set((cd.admissions || []).map(a => normName(a.name)));
      const cdDisNorms = new Set((cd.discharges || []).map(dd => normName(dd.name)));
      const manualAdm = (bd.admissions || []).filter(a => !cdAdmNorms.has(normName(a.name)));
      const manualDis = (bd.discharges || []).filter(dd => !cdDisNorms.has(normName(dd.name)));
      return { admissions: [...baseAdm, ...manualAdm], discharges: [...baseDis, ...manualDis] };
    };

    const live = mergeCdBd();

    if (bd?.frozen) {
      // 기존 frozen에 새 항목만 추가 (기존 항목은 절대 삭제하지 않음)
      const existAdmNorms = new Set((bd.admissions || []).map(a => normName(a.name)));
      const existDisNorms = new Set((bd.discharges || []).map(d => normName(d.name)));
      const newAdm = (live.admissions || []).filter(a => a.name && !existAdmNorms.has(normName(a.name)));
      const newDis = (live.discharges || []).filter(d => d.name && !existDisNorms.has(normName(d.name)));
      if (newAdm.length || newDis.length) {
        set(ref(db, `monthlyBoards/${ym}/${key}`), {
          frozen: true,
          admissions: [...(bd.admissions || []), ...newAdm],
          discharges: [...(bd.discharges || []), ...newDis],
        });
      }
    } else {
      // 최초 frozen 생성 (당일에 처음 monthly 방문 시)
      if (frozenKeysRef.current.has(key)) return;
      if (!live.admissions.length && !live.discharges.length) return;
      frozenKeysRef.current.add(key);
      set(ref(db, `monthlyBoards/${ym}/${key}`), { frozen: true, admissions: live.admissions, discharges: live.discharges });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarData, boardData, year, month, slots]);

  // 월 변경 시 스냅샷 추적 초기화
  useEffect(() => { frozenKeysRef.current = new Set(); }, [year, month]);

  // 날짜별 재원 환자 수: 오늘 실제 재원 수 기준으로 입/퇴원 이벤트 누적
  const censusData = useMemo(() => {
    const counts = {};
    const total = daysInMonth(year, month);
    const now = new Date();
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth() + 1;
    const nowDay = now.getDate();

    // 이름 기준 중복 제거 (전실 등으로 동일 환자가 여러 슬롯에 있을 경우 대비)
    const dedupByName = (list) => {
      const seen = new Set();
      return (list || []).filter(a => {
        const n = normName(a.name);
        if (!n || seen.has(n)) return false;
        seen.add(n);
        return true;
      });
    };

    // 날짜별 입/퇴원 건수 계산 (frozen 스냅샷 우선, 이름 중복 제거)
    const getAdmDis = (d) => {
      const k = `${year}-${String(month).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      const cd = calendarData[k] || { admissions:[], discharges:[] };
      const bd = boardData[k];
      // frozen 스냅샷이 있으면 그 데이터를 기준으로 사용
      if (bd?.frozen) {
        const allAdm = dedupByName(bd.admissions || []);
        const allDis = dedupByName(bd.discharges || []);
        return {
          adm: allAdm.length,
          admActual: allAdm.filter(a => !a.isReserved).length,
          dis: allDis.length,
        };
      }
      if (!bd) {
        const allAdm = dedupByName(cd.admissions || []);
        const allDis = dedupByName(cd.discharges || []);
        return {
          adm: allAdm.length,
          admActual: allAdm.filter(a => !a.isReserved).length,
          dis: allDis.length,
        };
      }
      const hiddenAdm = new Set(bd.hiddenAdmissions || []);
      const hiddenDis = new Set(bd.hiddenDischarges || []);
      const baseAdm = (cd.admissions||[]).filter(a => !hiddenAdm.has(normName(a.name)));
      const baseDis = (cd.discharges||[]).filter(d2 => !hiddenDis.has(normName(d2.name)));
      const cdAdmNorms = new Set((cd.admissions||[]).map(a => normName(a.name)));
      const cdDisNorms = new Set((cd.discharges||[]).map(d2 => normName(d2.name)));
      const manualAdm = (bd.admissions||[]).filter(a => !cdAdmNorms.has(normName(a.name)));
      const manualDis = (bd.discharges||[]).filter(d2 => !cdDisNorms.has(normName(d2.name)));
      const allAdm = dedupByName([...baseAdm, ...manualAdm]);
      const allDis = dedupByName([...baseDis, ...manualDis]);
      return {
        adm: allAdm.length,
        admActual: allAdm.filter(a => !a.isReserved).length,
        dis: allDis.length,
      };
    };

    if (year === nowYear && month === nowMonth) {
      // 현재 달: 오늘 실제 재원 수를 기준점으로 (index.js와 동일 병상 범위 + 동일 로직)
      const todayDateOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let todayCensus = 0;
      WARD_ROOMS.forEach(({ id, cap }) => {
        for (let i = 1; i <= cap; i++) {
          const s = slots[`${id}-${i}`];
          if (!s?.current?.name) continue;
          const dis = parseDateStr(s.current.discharge, now.getFullYear());
          if (dis) {
            const disD = new Date(dis.getFullYear(), dis.getMonth(), dis.getDate());
            if (disD <= todayDateOnly) continue;
          }
          todayCensus++;
        }
      });
      const todayKey = `${year}-${String(month).padStart(2,"0")}-${String(nowDay).padStart(2,"0")}`;
      counts[todayKey] = todayCensus;
      // 오늘 이후 → 앞으로 누적
      let cur = todayCensus;
      for (let d = nowDay + 1; d <= total; d++) {
        const { adm, dis } = getAdmDis(d);
        cur = Math.max(0, cur + adm - dis);
        counts[`${year}-${String(month).padStart(2,"0")}-${String(d).padStart(2,"0")}`] = cur;
      }
      // 오늘 이전 → 역방향 누적 (census[d] = census[d+1] - admActual[d+1] + dis[d+1])
      cur = todayCensus;
      for (let d = nowDay - 1; d >= 1; d--) {
        const { admActual, dis } = getAdmDis(d + 1);
        cur = Math.max(0, cur - admActual + dis);
        counts[`${year}-${String(month).padStart(2,"0")}-${String(d).padStart(2,"0")}`] = cur;
      }
    } else {
      // 다른 달: 슬롯에서 해당 월 시작 전에 입원 중인 환자 수(이월 재원)를 계산해 시작값으로 사용
      const monthFirstDay = new Date(year, month - 1, 1);
      const seenCarry = new Set();
      let carryOver = 0;
      WARD_ROOMS.forEach(({ id, cap }) => {
        for (let i = 1; i <= cap; i++) {
          const slot = slots[`${id}-${i}`];
          if (!slot) continue;
          const checkPatient = (p) => {
            if (!p?.name) return;
            const n = normName(p.name);
            if (!n || seenCarry.has(n)) return;
            const admit = parseDateStr(p.admitDate, year);
            if (!admit) return;
            const admitDay = new Date(admit.getFullYear(), admit.getMonth(), admit.getDate());
            if (admitDay >= monthFirstDay) return;
            const discharge = parseDateStr(p.discharge, year);
            if (discharge) {
              const disDay = new Date(discharge.getFullYear(), discharge.getMonth(), discharge.getDate());
              if (disDay < monthFirstDay) return;
            }
            seenCarry.add(n);
            carryOver++;
          };
          checkPatient(slot.current);
          (slot.reservations || []).forEach(r => checkPatient(r));
        }
      });
      // 이월 재원 수를 시작값으로 순방향 누적
      let cur = carryOver;
      for (let d = 1; d <= total; d++) {
        const { adm, dis } = getAdmDis(d);
        cur = Math.max(0, cur + adm - dis);
        counts[`${year}-${String(month).padStart(2,"0")}-${String(d).padStart(2,"0")}`] = cur;
      }
    }
    return counts;
  }, [slots, calendarData, boardData, year, month]);

  // 이름 기준 중복 제거 (boardData에 이미 저장된 중복도 처리)
  function dedupList(list) {
    const seen = new Set();
    return (list || []).filter(a => {
      const n = normName(a.name);
      if (!n || seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  }

  // 신환 이름 집합: 상담일지 + 공유 신환 플래그 (입원일 기준 1주일 유지)
  const newPatientNorms = useMemo(() => {
    const s = new Set();
    const today = new Date(); today.setHours(0,0,0,0);
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    Object.values(consultations).forEach(c => {
      if (!c?.name) return;
      const isNew = c.isNewPatient !== undefined ? !!c.isNewPatient : !c.patientId;
      if (!isNew) return;
      if (c.status === "취소" || c.status === "입원완료") return;
      s.add(normName(c.name));
    });
    // 공유 신환 플래그: 입원일 기준 1주일 이내만 유효
    Object.entries(newPatientFlags).forEach(([nk, flag]) => {
      if (!flag?.admitDate) { s.add(nk); return; }
      const admitD = parseISO(flag.admitDate) || parseDateStr(flag.admitDate, year);
      if (!admitD) { s.add(nk); return; }
      admitD.setHours(0,0,0,0);
      // 입원일로부터 1주일 이내이면 유효
      if (today.getTime() - admitD.getTime() < weekMs) s.add(nk);
    });
    // 일일현황판에서 ★ 신규 표시한 환자도 포함
    Object.values(dailyBoards).forEach(db => {
      (db.admissions || []).forEach(a => {
        if (a.isNew && a.name) s.add(normName(a.name));
      });
    });
    return s;
  }, [consultations, newPatientFlags, dailyBoards, year]);

  // 표시 데이터: calendarData 기반 + boardData 수동 추가/숨김 병합
  function getDisplayData(key) {
    const bd = boardData[key];
    // frozen(스냅샷) 데이터: 저장된 데이터 + calendarData 보완 (누락 방지)
    if (bd?.frozen) {
      // frozen이어도 상담일지의 신환 플래그는 반영
      const admissions = dedupList(bd.admissions || []).map(a => {
        if (!a.isNew && newPatientNorms.has(normName(a.name))) return { ...a, isNew: true };
        return a;
      });
      const discharges = dedupList(bd.discharges || []);
      // frozen에 없지만 calendarData에 있는 항목 보완 (숨김 제외)
      const cd = calendarData[key] || { admissions:[], discharges:[] };
      const hiddenAdm = new Set((bd.hiddenAdmissions || []).map(n => typeof n === 'string' ? n : normName(n)));
      const hiddenDis = new Set((bd.hiddenDischarges || []).map(n => typeof n === 'string' ? n : normName(n)));
      const frozenAdmNorms = new Set(admissions.map(a => normName(a.name)));
      const frozenDisNorms = new Set(discharges.map(d => normName(d.name)));
      const extraAdm = (cd.admissions || []).filter(a =>
        a.name && !frozenAdmNorms.has(normName(a.name)) && !hiddenAdm.has(normName(a.name))
      );
      const extraDis = (cd.discharges || []).filter(d =>
        d.name && !frozenDisNorms.has(normName(d.name)) && !hiddenDis.has(normName(d.name))
      );
      return {
        admissions: dedupList([...admissions, ...extraAdm]),
        discharges: dedupList([...discharges, ...extraDis]),
        isManual: true,
      };
    }
    const cd = calendarData[key] || { admissions:[], discharges:[] };
    if (!bd) return { admissions: dedupList(cd.admissions), discharges: dedupList(cd.discharges), isManual: false };
    const hiddenAdm = new Set(bd.hiddenAdmissions || []);
    const hiddenDis = new Set(bd.hiddenDischarges || []);
    const baseAdm = (cd.admissions || []).filter(a => !hiddenAdm.has(normName(a.name)));
    const baseDis = (cd.discharges || []).filter(d => !hiddenDis.has(normName(d.name)));
    const cdAdmNorms = new Set((cd.admissions || []).map(a => normName(a.name)));
    const cdDisNorms = new Set((cd.discharges || []).map(d => normName(d.name)));
    const manualAdm = (bd.admissions || []).filter(a => !cdAdmNorms.has(normName(a.name)));
    const manualDis = (bd.discharges || []).filter(d => !cdDisNorms.has(normName(d.name)));
    const hasManual = hiddenAdm.size > 0 || hiddenDis.size > 0 || manualAdm.length > 0 || manualDis.length > 0;
    return {
      admissions: dedupList([...baseAdm, ...manualAdm]),
      discharges: dedupList([...baseDis, ...manualDis]),
      isManual: hasManual,
    };
  }

  // 편집 모달 열기
  function openEdit(key) {
    const merged = getDisplayData(key);
    setEditAdm((merged.admissions || []).map(a => ({ ...a, id: a.id || uid() })));
    setEditDis((merged.discharges || []).map(d => ({ ...d, id: d.id || uid() })));
    setEditModal(key);
  }

  // 신환 플래그 동기화: 편집된 입원 목록의 isNew 변경을 공유 저장소에 반영
  async function syncNewPatientFlags(admList, dateKey) {
    const updates = {};
    for (const a of admList) {
      if (!a.name) continue;
      const nk = normName(a.name);
      if (a.isNew) {
        // 신환 표시: 입원일 정보와 함께 저장
        if (!newPatientFlags[nk]) {
          updates[`newPatientFlags/${nk}`] = { admitDate: dateKey, markedAt: new Date().toISOString() };
        }
      } else {
        // 신환 해제
        if (newPatientFlags[nk]) {
          updates[`newPatientFlags/${nk}`] = null;
        }
      }
    }
    for (const [path, val] of Object.entries(updates)) {
      await set(ref(db, path), val);
    }
  }

  // 이름 변경 시 consultation/slots 연동 업데이트
  async function propagateNameChanges(editList, origList) {
    const fbUpdates = {};
    for (const edited of editList) {
      if (!edited.name) continue;
      // 원본 항목 찾기 (id 기반)
      const orig = origList.find(o => o.id === edited.id);
      if (!orig || orig.name === edited.name) continue;
      // 이름이 변경된 경우: consultation과 slots 업데이트
      if (edited._consultationId) {
        fbUpdates[`consultations/${edited._consultationId}/name`] = edited.name;
      }
      if (edited._slotKey) {
        const slot = slots[edited._slotKey];
        if (slot?.current?.name === orig.name) {
          fbUpdates[`slots/${edited._slotKey}/current/name`] = edited.name;
        } else {
          // reservations에서 매칭
          const resList = slot?.reservations || [];
          const ri = resList.findIndex(r => r.name === orig.name);
          if (ri >= 0) fbUpdates[`slots/${edited._slotKey}/reservations/${ri}/name`] = edited.name;
        }
      }
    }
    if (Object.keys(fbUpdates).length > 0) {
      await update(ref(db), fbUpdates);
    }
  }

  // 편집 저장 (calendarData 기반 수동 추가/숨김만 저장)
  async function saveEdit() {
    setEditSaving(true);
    // 이름 변경 시 consultation/slots 연동
    const cd = calendarData[editModal] || { admissions:[], discharges:[] };
    await propagateNameChanges(editAdm, cd.admissions || []);
    await propagateNameChanges(editDis, cd.discharges || []);
    // 신환 플래그 동기화
    await syncNewPatientFlags(editAdm, editModal);
    const bd = boardData[editModal];
    // frozen 데이터: 전체 목록을 직접 저장 (_slotKey, _consultationId 메타 제거)
    const cleanList = (list) => (list || []).map(({_slotKey, _consultationId, ...rest}) => rest);
    if (bd?.frozen) {
      const savedAdmNorms = new Set(editAdm.map(a => normName(a.name)));
      const savedDisNorms = new Set(editDis.map(d => normName(d.name)));
      // calendarData에 있지만 편집 목록에서 제거된 항목 → hidden 처리 (되살아남 방지)
      const cd = calendarData[editModal] || { admissions:[], discharges:[] };
      const hiddenAdmissions = (cd.admissions || [])
        .filter(a => a.name && !savedAdmNorms.has(normName(a.name)))
        .map(a => normName(a.name));
      const hiddenDischarges = (cd.discharges || [])
        .filter(d => d.name && !savedDisNorms.has(normName(d.name)))
        .map(d => normName(d.name));
      const payload = { frozen: true, admissions: cleanList(editAdm), discharges: cleanList(editDis) };
      if (hiddenAdmissions.length) payload.hiddenAdmissions = hiddenAdmissions;
      if (hiddenDischarges.length) payload.hiddenDischarges = hiddenDischarges;
      await set(ref(db, `monthlyBoards/${toYM(year, month)}/${editModal}`), payload);
      setEditSaving(false);
      setEditModal(null);
      return;
    }
    const cdAdmNorms = new Set((cd.admissions || []).map(a => normName(a.name)));
    const cdDisNorms = new Set((cd.discharges || []).map(d => normName(d.name)));
    const savedAdmNorms = new Set(editAdm.map(a => normName(a.name)));
    const savedDisNorms = new Set(editDis.map(d => normName(d.name)));
    const hiddenAdmissions = (cd.admissions || []).filter(a => !savedAdmNorms.has(normName(a.name))).map(a => normName(a.name));
    const hiddenDischarges = (cd.discharges || []).filter(d => !savedDisNorms.has(normName(d.name))).map(d => normName(d.name));
    const manualAdmissions = cleanList(editAdm.filter(a => !cdAdmNorms.has(normName(a.name))));
    const manualDischarges = cleanList(editDis.filter(d => !cdDisNorms.has(normName(d.name))));
    const hasAny = manualAdmissions.length || manualDischarges.length || hiddenAdmissions.length || hiddenDischarges.length;
    await set(ref(db, `monthlyBoards/${toYM(year, month)}/${editModal}`),
      hasAny ? { admissions: manualAdmissions, discharges: manualDischarges, hiddenAdmissions, hiddenDischarges } : null);
    setEditSaving(false);
    setEditModal(null);
  }

  // 인라인 삭제
  async function deleteEntry(dKey, type, entryId) {
    const bd = boardData[dKey];
    // frozen 데이터: 직접 필터 + calendarData 항목은 hidden 처리
    if (bd?.frozen) {
      const all = type === "admission" ? [...(bd.admissions || [])] : [...(bd.discharges || [])];
      const deleted = all.find(e => (e.id || "") === entryId);
      const newBd = { frozen: true, admissions: [...(bd.admissions || [])], discharges: [...(bd.discharges || [])] };
      if (bd.hiddenAdmissions?.length) newBd.hiddenAdmissions = [...bd.hiddenAdmissions];
      if (bd.hiddenDischarges?.length) newBd.hiddenDischarges = [...bd.hiddenDischarges];
      if (type === "admission") newBd.admissions = newBd.admissions.filter(a => a.id !== entryId);
      else newBd.discharges = newBd.discharges.filter(d => d.id !== entryId);
      // calendarData에 있는 항목이면 hidden 목록에 추가 (삭제 후 되살아남 방지)
      if (deleted?.name) {
        const dn = normName(deleted.name);
        const cd = calendarData[dKey] || { admissions:[], discharges:[] };
        const inCd = type === "admission"
          ? (cd.admissions || []).some(a => normName(a.name) === dn)
          : (cd.discharges || []).some(d => normName(d.name) === dn);
        if (inCd) {
          const hKey = type === "admission" ? "hiddenAdmissions" : "hiddenDischarges";
          newBd[hKey] = [...new Set([...(newBd[hKey] || []), dn])];
        }
      }
      await set(ref(db, `monthlyBoards/${toYM(year, month)}/${dKey}`), newBd);
      return;
    }
    const merged = getDisplayData(dKey);
    const all = type === "admission" ? (merged.admissions || []) : (merged.discharges || []);
    const deleted = all.find(e => (e.id || "") === entryId);
    const deletedNorm = normName(deleted?.name || "");
    const cd = calendarData[dKey] || { admissions:[], discharges:[] };
    const newBd2 = { admissions: (bd||{}).admissions || [], discharges: (bd||{}).discharges || [], hiddenAdmissions: (bd||{}).hiddenAdmissions || [], hiddenDischarges: (bd||{}).hiddenDischarges || [] };
    if (type === "admission") {
      if ((cd.admissions || []).some(a => normName(a.name) === deletedNorm))
        newBd2.hiddenAdmissions = [...newBd2.hiddenAdmissions.filter(n => n !== deletedNorm), deletedNorm];
      else newBd2.admissions = newBd2.admissions.filter(a => a.id !== entryId);
    } else {
      if ((cd.discharges || []).some(d => normName(d.name) === deletedNorm))
        newBd2.hiddenDischarges = [...newBd2.hiddenDischarges.filter(n => n !== deletedNorm), deletedNorm];
      else newBd2.discharges = newBd2.discharges.filter(d => d.id !== entryId);
    }
    const hasAny = newBd2.admissions.length || newBd2.discharges.length || newBd2.hiddenAdmissions.length || newBd2.hiddenDischarges.length;
    await set(ref(db, `monthlyBoards/${toYM(year, month)}/${dKey}`), hasAny ? newBd2 : null);
  }

  // 인라인 추가
  async function addEntry(dKey, type, entry) {
    // 입원 추가 시 신환 플래그 동기화
    if (type === "admission" && entry.isNew && entry.name) {
      const nk = normName(entry.name);
      if (!newPatientFlags[nk]) {
        await set(ref(db, `newPatientFlags/${nk}`), { admitDate: dKey, markedAt: new Date().toISOString() });
      }
    }
    const bd = boardData[dKey] || {};
    // frozen 데이터: 직접 추가
    if (bd?.frozen) {
      const newBd = { frozen: true, admissions: [...(bd.admissions || [])], discharges: [...(bd.discharges || [])] };
      if (type === "admission") newBd.admissions.push({...entry, id: uid()});
      else newBd.discharges.push({...entry, id: uid()});
      await set(ref(db, `monthlyBoards/${toYM(year, month)}/${dKey}`), newBd);
      return;
    }
    const newBd = { admissions: bd.admissions || [], discharges: bd.discharges || [], hiddenAdmissions: bd.hiddenAdmissions || [], hiddenDischarges: bd.hiddenDischarges || [] };
    if (type === "admission") newBd.admissions = [...newBd.admissions, {...entry, id: uid()}];
    else newBd.discharges = [...newBd.discharges, {...entry, id: uid()}];
    await set(ref(db, `monthlyBoards/${toYM(year, month)}/${dKey}`), newBd);
  }

  // 시간만 인라인 수정
  async function updateEntryTime(dKey, type, entryId, newTime) {
    const bd = boardData[dKey];
    if (bd?.frozen) {
      const newBd = { ...bd, [type]: (bd[type] || []).map(e => e.id === entryId ? { ...e, time: newTime } : e) };
      await set(ref(db, `monthlyBoards/${toYM(year, month)}/${dKey}`), newBd);
      return;
    }
    // non-frozen: getDisplayData → frozen으로 저장 (시간 수정은 boardData에 보존 필요)
    const display = getDisplayData(dKey);
    const admissions = type === "admissions" ? (display.admissions || []).map(e => e.id === entryId ? { ...e, time: newTime } : e) : (display.admissions || []);
    const discharges = type === "discharges" ? (display.discharges || []).map(e => e.id === entryId ? { ...e, time: newTime } : e) : (display.discharges || []);
    await set(ref(db, `monthlyBoards/${toYM(year, month)}/${dKey}`), { frozen: true, admissions, discharges });
  }

  function openPopover(dKey, type, e) {
    const rect = e.currentTarget.getBoundingClientRect();
    setPopover({ dateKey: dKey, type, rect });
  }

  // 달력 격자
  const calendarGrid = useMemo(() => {
    const total = daysInMonth(year, month);
    const firstDow = new Date(year, month - 1, 1).getDay();
    const weeks = [];
    let week = Array(firstDow).fill(null);
    for (let d = 1; d <= total; d++) {
      week.push(d);
      if (week.length === 7) { weeks.push(week); week = []; }
    }
    if (week.length > 0) {
      while (week.length < 7) week.push(null);
      weeks.push(week);
    }
    return weeks;
  }, [year, month]);

  function prevMonth() {
    if (month === 1) { setYear(y => y-1); setMonth(12); }
    else setMonth(m => m-1);
  }
  function nextMonth() {
    if (month === 12) { setYear(y => y+1); setMonth(1); }
    else setMonth(m => m+1);
  }

  // 요약 통계 (boardData + calendarData 통합)
  const summaryStats = useMemo(() => {
    let totalAdmit = 0, totalDischarge = 0, totalNew = 0;
    const total = daysInMonth(year, month);
    for (let d = 1; d <= total; d++) {
      const key = `${year}-${String(month).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      const dd = getDisplayData(key);
      totalAdmit += (dd.admissions||[]).length;
      totalDischarge += (dd.discharges||[]).length;
      totalNew += (dd.admissions||[]).filter(a => a.isNew).length;
    }
    return { totalAdmit, totalDischarge, totalNew };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardData, calendarData, year, month]);

  const printStyle = `
    @media print {
      @page { size: A4 landscape; margin: 8mm; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
      .print-grid { font-size: 9px !important; }
      .print-title { display: block !important; }
    }
  `;

  const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,"0")}-${String(new Date().getDate()).padStart(2,"0")}`;

  return (
    <div style={{ minHeight:"100vh", background:"#f8fafc", fontFamily:"'Pretendard','Noto Sans KR',sans-serif" }}>
      <style>{printStyle}</style>

      {/* 헤더 */}
      <header className="no-print" style={{ background:"#0f2744", color:"#fff", padding:"12px 20px",
        display:"flex", alignItems:"center", gap:12, position:"sticky", top:0, zIndex:40, boxShadow:"0 2px 8px rgba(0,0,0,0.18)" }}>
        <span style={{ fontWeight:800, fontSize:16 }}>월간 입퇴원 예정표</span>
        <div style={{ marginLeft:"auto", display:"flex", gap:8, alignItems:"center" }}>
          {filterName && (
            <span style={{ display:"inline-flex", alignItems:"center", gap:4,
              background:"#fef3c7", color:"#92400e", borderRadius:6, padding:"3px 10px", fontSize:12, fontWeight:700 }}>
              "{filterName}" 하이라이트
              <button onClick={() => setFilterName("")} style={{ background:"none", border:"none", cursor:"pointer",
                color:"#92400e", fontSize:13, padding:0, lineHeight:1, fontWeight:800 }}>✕</button>
            </span>
          )}
          <button onClick={() => window.print()} style={{ ...NS.navBtn, background:"#1e3a5f" }}>🖨 인쇄</button>
        </div>
      </header>

      {/* 월 네비게이션 */}
      <div className="no-print" style={{ background:"#fff", borderBottom:"1px solid #e2e8f0",
        padding:"8px 16px", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
        <button onClick={prevMonth} style={NS.monthBtn}>◀</button>
        <span style={{ fontSize:22, fontWeight:900, color:"#0f2744", minWidth:120, textAlign:"center" }}>
          {year}년 {month}월
        </span>
        <button onClick={nextMonth} style={NS.monthBtn}>▶</button>
        <div style={{ display:"flex", gap:8, fontSize:14, marginLeft:8 }}>
          <span style={{ background:"#dcfce7", color:"#166534", borderRadius:4, padding:"3px 10px", fontWeight:700 }}>↑ 입원</span>
          <span style={{ background:"#fee2e2", color:"#991b1b", borderRadius:4, padding:"3px 10px", fontWeight:700 }}>↓ 퇴원</span>
          <span style={{ background:"#fef9c3", color:"#854d0e", borderRadius:4, padding:"3px 10px", fontWeight:700 }}>★ 신환</span>
          <span style={{ background:"#e0f2fe", color:"#0369a1", borderRadius:4, padding:"3px 10px", fontWeight:700 }}>🏥 재원수</span>
        </div>
      </div>

      {/* 공지/메모 */}
      <div style={{ background:"#fffbeb", borderBottom:"1px solid #fde68a", padding:"8px 20px", display:"flex", alignItems:"flex-start", gap:10 }}>
        <span style={{ fontSize:14, flexShrink:0, marginTop:2 }}>📌</span>
        {memoEditing ? (
          <div style={{ flex:1, display:"flex", gap:8, alignItems:"flex-start" }}>
            <textarea value={memoEdit} onChange={e => setMemoEdit(e.target.value)}
              placeholder={`${year}년 ${month}월 공지 및 메모를 입력하세요...`}
              rows={3}
              style={{ flex:1, border:"1px solid #fcd34d", borderRadius:6, padding:"6px 10px",
                fontSize:13, resize:"vertical", fontFamily:"inherit", background:"#fff" }} />
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              <button onClick={saveMemo} disabled={memoSaving}
                style={{ background:"#d97706", color:"#fff", border:"none", borderRadius:6,
                  padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:700 }}>
                {memoSaving ? "저장 중..." : "저장"}
              </button>
              <button onClick={() => { setMemoEditing(false); setMemoEdit(memo); }}
                style={{ background:"#e5e7eb", color:"#374151", border:"none", borderRadius:6,
                  padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:600 }}>
                취소
              </button>
            </div>
          </div>
        ) : (
          <div style={{ flex:1, display:"flex", alignItems:"flex-start", gap:8 }}>
            <span style={{ flex:1, fontSize:13, color: memo ? "#78350f" : "#a16207",
              whiteSpace:"pre-wrap", lineHeight:1.6, minHeight:20 }}>
              {memo || <span style={{ color:"#d97706", fontStyle:"italic" }}>이번 달 공지/메모 없음</span>}
            </span>
            <button className="no-print" onClick={() => setMemoEditing(true)}
              style={{ flexShrink:0, background:"#fef3c7", color:"#92400e", border:"1px solid #fcd34d",
                borderRadius:6, padding:"4px 12px", cursor:"pointer", fontSize:12, fontWeight:700 }}>
              ✏️ 편집
            </button>
          </div>
        )}
      </div>

      {/* 인쇄용 제목 */}
      <div style={{ display:"none" }} className="print-title">
        <h2 style={{ textAlign:"center", margin:"4mm 0 2mm", fontSize:14 }}>{year}년 {month}월 입퇴원 예정표</h2>
        {memo && <p style={{ textAlign:"center", fontSize:10, color:"#78350f", margin:"0 0 2mm" }}>📌 {memo}</p>}
      </div>

      {/* 달력 */}
      <div style={{ padding: isMobile ? "8px" : "16px 20px", overflowX:"auto" }}>
        <table className="print-grid" style={{ width:"100%", borderCollapse:"collapse",
          tableLayout:"fixed", minWidth: isMobile ? 700 : "auto" }}>
          <thead>
            <tr>
              {DOW.map((d, i) => (
                <th key={i} style={{
                  background: i===0 ? "#fef2f2" : i===6 ? "#eff6ff" : "#1e3a5f",
                  color: i===0 ? "#dc2626" : i===6 ? "#2563eb" : "#fff",
                  padding:"6px 4px", textAlign:"center", fontSize:13, fontWeight:800,
                  border:"1px solid #cbd5e1", width:"14.28%",
                }}>{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calendarGrid.map((week, wi) => (
              <tr key={wi}>
                {week.map((day, di) => {
                  if (!day) return <td key={di} style={{ border:"1px solid #e2e8f0", background:"#f8fafc", verticalAlign:"top", minHeight:90 }} />;
                  const key = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
                  const dayData = getDisplayData(key);
                  const isManual = dayData.isManual;
                  const isToday = key === todayKey;
                  const isSun = di === 0, isSat = di === 6;

                  return (
                    <td key={di} ref={el => { if (el) dayCellRefs.current[key] = el; }} style={{
                      border: isManual ? "2px solid #bae6fd" : "1px solid #e2e8f0",
                      verticalAlign:"top", padding:0,
                      background: isToday ? "#fffbeb" : "#fff",
                      minHeight:120, position:"relative",
                    }}>
                      {/* 날짜 헤더 */}
                      <div style={{
                        padding:"4px 6px", fontWeight:900,
                        fontSize: isMobile ? 16 : 18,
                        color: isToday ? "#d97706" : isSun ? "#dc2626" : isSat ? "#2563eb" : "#1e293b",
                        background: isToday ? "#fef3c7" : isSun ? "#fff5f5" : isSat ? "#eff6ff" : "#f8fafc",
                        borderBottom:"1px solid #e2e8f0",
                        display:"flex", alignItems:"center", gap:3,
                      }}>
                        <span>{day}</span>
                        {isToday && <span style={{ fontSize:11, background:"#f59e0b", color:"#fff", borderRadius:3, padding:"0 4px", fontWeight:700 }}>오늘</span>}
                        {isManual && <span style={{ fontSize:10, background:"#bae6fd", color:"#0369a1", borderRadius:3, padding:"0 4px", fontWeight:700 }}>✏</span>}
                        <span style={{ flex:1 }} />
                        {(censusData[key] || 0) > 0 && (
                          <span style={{ fontSize:10, background:"#dbeafe", color:"#1e40af", borderRadius:3, padding:"0 5px", fontWeight:800 }}>
                            🏥{censusData[key]}
                          </span>
                        )}
                        {/* 편집 버튼 */}
                        <button className="no-print" onClick={() => openEdit(key)}
                          title="이 날 편집"
                          style={{ background:"none", border:"none", cursor:"pointer",
                            fontSize:11, color:"#64748b", padding:"0 2px", lineHeight:1 }}>
                          ✏️
                        </button>
                      </div>

                      {/* 입원 섹션 */}
                      <div style={{ borderBottom:"1px dashed #bbf7d0", padding:"4px 5px", background:"#f0fdf4" }}>
                        {(dayData.admissions||[]).length > 0 && (
                          <>
                            <div style={{ fontSize:13, fontWeight:800, color:"#166534", marginBottom:3 }}>
                              ↑ 입원 {(dayData.admissions||[]).length}
                            </div>
                            {(dayData.admissions||[]).map((p, pi) => (
                              <PatientChip key={p.id||pi} p={p} type="admission"
                                highlight={filterName && p.name?.includes(filterName)}
                                onDelete={() => deleteEntry(key, "admission", p.id)}
                                onTimeChange={(t) => updateEntryTime(key, "admissions", p.id, t)} />
                            ))}
                          </>
                        )}
                        <button className="no-print" onClick={e => openPopover(key, "admission", e)}
                          style={{ background:"none", border:"none", color:"#16a34a", cursor:"pointer",
                            fontSize:12, padding:"1px 3px", fontWeight:700, lineHeight:1.4 }}>+ 입원</button>
                      </div>

                      {/* 퇴원 섹션 */}
                      <div style={{ padding:"4px 5px", background:"#fff5f5" }}>
                        {(dayData.discharges||[]).length > 0 && (
                          <>
                            <div style={{ fontSize:13, fontWeight:800, color:"#991b1b", marginBottom:3 }}>
                              ↓ 퇴원 {(dayData.discharges||[]).length}
                            </div>
                            {(dayData.discharges||[]).map((p, pi) => (
                              <PatientChip key={p.id||pi} p={p} type="discharge"
                                highlight={filterName && p.name?.includes(filterName)}
                                onDelete={() => deleteEntry(key, "discharge", p.id)}
                                onTimeChange={(t) => updateEntryTime(key, "discharges", p.id, t)} />
                            ))}
                          </>
                        )}
                        <button className="no-print" onClick={e => openPopover(key, "discharge", e)}
                          style={{ background:"none", border:"none", color:"#dc2626", cursor:"pointer",
                            fontSize:12, padding:"1px 3px", fontWeight:700, lineHeight:1.4 }}>+ 퇴원</button>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 하단 요약 */}
      <div className="no-print" style={{ padding:"10px 20px", background:"#fff",
        borderTop:"1px solid #e2e8f0", display:"flex", gap:20, fontSize:13, color:"#64748b" }}>
        <span style={{ fontSize:15 }}>이번 달 입원 예정: <strong style={{color:"#166534", fontSize:17}}>{summaryStats.totalAdmit}명</strong></span>
        <span style={{ fontSize:15 }}>퇴원 예정: <strong style={{color:"#991b1b", fontSize:17}}>{summaryStats.totalDischarge}명</strong></span>
        <span style={{ fontSize:15 }}>신환: <strong style={{color:"#854d0e", fontSize:17}}>{summaryStats.totalNew}명</strong></span>
      </div>

      {/* 날짜 편집 모달 */}
      {editModal && (
        <DayEditModal
          dateKey={editModal}
          admissions={editAdm}
          discharges={editDis}
          onChangeAdm={setEditAdm}
          onChangeDis={setEditDis}
          onSave={saveEdit}
          onClose={() => setEditModal(null)}
          saving={editSaving}
          allPatients={allPatients}
        />
      )}

      {/* 인라인 추가 팝오버 */}
      {popover && (
        <CellPopover
          popover={popover}
          onClose={() => setPopover(null)}
          onSave={addEntry}
          allPatients={allPatients}
        />
      )}
    </div>
  );
}

/* ── 인라인 추가 팝오버 ── */
function CellPopover({ popover, onClose, onSave, allPatients }) {
  const [form, setForm] = useState({ name:"", room:"", note:"", isNew:false, time:"" });
  const [saving, setSaving] = useState(false);
  const wrapRef = useRef(null);
  const isAdm = popover.type === "admission";

  useEffect(() => {
    function handler(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    function handler(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const r = popover.rect;
  const estH = 260;
  const top = (r.bottom + 4 + estH > window.innerHeight) ? Math.max(8, r.top - estH - 4) : r.bottom + 4;
  const left = Math.min(r.left, window.innerWidth - 320);

  async function handleSave() {
    if (!form.name.trim()) return;
    setSaving(true);
    await onSave(popover.dateKey, popover.type, {
      name: form.name.trim(),
      room: form.room.trim(),
      note: form.note.trim(),
      isNew: form.isNew,
      isReserved: false,
      time: form.time,
    });
    setSaving(false);
    onClose();
  }

  const inputSt = { border:"1px solid #e2e8f0", borderRadius:6, padding:"6px 9px",
    fontSize:14, fontFamily:"inherit", outline:"none", width:"100%", boxSizing:"border-box" };

  return (
    <div ref={wrapRef} style={{ position:"fixed", top, left, zIndex:500, width:310,
      background:"#fff", borderRadius:10, boxShadow:"0 8px 32px rgba(0,0,0,0.18)",
      border:"1px solid #e2e8f0", padding:14 }}>
      <div style={{ fontWeight:800, fontSize:14, color: isAdm ? "#166534" : "#991b1b", marginBottom:10 }}>
        {isAdm ? "↑ 입원 추가" : "↓ 퇴원 추가"}
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
        <PatientAutocomplete
          value={form.name}
          patients={allPatients}
          onChange={v => setForm(f => ({...f, name:v}))}
          onSelect={p => setForm(f => ({...f, name:p.name, room:f.room||p.room, note:f.note||p.note, isNew:isAdm?(p.isNew||f.isNew):f.isNew}))}
          placeholder="이름 검색 또는 직접 입력"
          inputStyle={inputSt}
        />
        <div style={{ display:"flex", gap:6 }}>
          <input value={form.room} onChange={e => setForm(f => ({...f, room:e.target.value}))}
            placeholder="호실 (예: 501-1)" style={{ ...inputSt, flex:1 }} />
          {(!form.time || TIME_OPTIONS.includes(form.time)) ? (
            <select value={form.time} onChange={e => { if(e.target.value==="__custom__") { const v=prompt("시간 입력 (예: 14시)"); setForm(f=>({...f,time:v?v.trim():""})); } else setForm(f=>({...f,time:e.target.value})); }}
              style={{ ...inputSt, width:95, color: form.time ? (isAdm?"#166534":"#991b1b") : "#94a3b8" }}>
              <option value="">시간</option>
              {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
              <option value="__custom__">✏️ 직접입력</option>
            </select>
          ) : (
            <input value={form.time} onChange={e => setForm(f => ({...f, time:e.target.value}))}
              style={{ ...inputSt, width:95, color: isAdm?"#166534":"#991b1b" }} />
          )}
        </div>
        <input value={form.note} onChange={e => setForm(f => ({...f, note:e.target.value}))}
          placeholder="비고" style={inputSt} />
        {isAdm && (
          <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:13, cursor:"pointer",
            background: form.isNew?"#fef9c3":"#f8fafc", borderRadius:6, padding:"5px 10px",
            border:"1px solid", borderColor: form.isNew?"#fcd34d":"#e2e8f0",
            color: form.isNew?"#713f12":"#64748b", fontWeight: form.isNew?700:500 }}>
            <input type="checkbox" checked={form.isNew} onChange={e => setForm(f => ({...f, isNew:e.target.checked}))} style={{ margin:0 }} />
            ★ 신환
          </label>
        )}
        <div style={{ display:"flex", gap:8, justifyContent:"flex-end", marginTop:2 }}>
          <button onClick={onClose}
            style={{ background:"#f1f5f9", color:"#374151", border:"none", borderRadius:6,
              padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:600 }}>취소</button>
          <button onClick={handleSave} disabled={saving || !form.name.trim()}
            style={{ background: isAdm ? "#059669" : "#dc2626", color:"#fff", border:"none", borderRadius:6,
              padding:"6px 16px", cursor:"pointer", fontSize:13, fontWeight:700,
              opacity: !form.name.trim() ? 0.5 : 1 }}>
            {saving ? "저장..." : "추가"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── 날짜 편집 모달 ── */
function DayEditModal({ dateKey, admissions, discharges, onChangeAdm, onChangeDis, onSave, onClose, saving, allPatients }) {
  const d = new Date(dateKey);
  const label = `${d.getMonth()+1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;

  function updateAdm(id, field, val) {
    onChangeAdm(rows => rows.map(r => r.id===id ? {...r, [field]:val} : r));
  }
  function updateDis(id, field, val) {
    onChangeDis(rows => rows.map(r => r.id===id ? {...r, [field]:val} : r));
  }
  function selectAdm(id, p) {
    onChangeAdm(rows => rows.map(r => r.id!==id ? r : {
      ...r,
      name: p.name,
      room: r.room || p.room,
      note: r.note || p.note,
      isNew: p.isNew,
      isReserved: p.isReserved,
    }));
  }
  function selectDis(id, p) {
    onChangeDis(rows => rows.map(r => r.id!==id ? r : {
      ...r,
      name: p.name,
      room: r.room || p.room,
    }));
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:200,
      display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
      onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:12, width:"100%", maxWidth:660,
        maxHeight:"92vh", overflow:"auto", boxShadow:"0 20px 60px rgba(0,0,0,0.3)" }}
        onClick={e => e.stopPropagation()}>

        {/* 모달 헤더 */}
        <div style={{ background:"#0f2744", color:"#fff", padding:"12px 20px",
          display:"flex", alignItems:"center", gap:10, borderRadius:"12px 12px 0 0" }}>
          <span style={{ fontWeight:800, fontSize:18 }}>📅 {label} 편집</span>
          <button onClick={onClose} style={{ marginLeft:"auto", background:"none", border:"none",
            color:"#94a3b8", cursor:"pointer", fontSize:20, lineHeight:1 }}>✕</button>
        </div>

        <div style={{ padding:16, display:"flex", flexDirection:"column", gap:16 }}>

          {/* 입원 섹션 */}
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <span style={{ fontWeight:800, fontSize:17, color:"#166534" }}>↑ 입원</span>
              <button onClick={() => onChangeAdm(r => [...r, EMPTY_ADM()])}
                style={MS.addBtn}>+ 추가</button>
            </div>
            {admissions.length === 0 && (
              <div style={{ color:"#94a3b8", fontSize:13, padding:"8px 0" }}>입원 항목 없음</div>
            )}
            {admissions.map(row => (
              <div key={row.id} style={{ display:"flex", gap:6, alignItems:"flex-start",
                marginBottom:8, background:"#f0fdf4", borderRadius:8, padding:"8px 10px" }}>
                <div style={{ flex:1, display:"flex", flexDirection:"column", gap:6 }}>
                  {/* 이름 자동완성 + 호실 */}
                  <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                    <PatientAutocomplete
                      value={row.name}
                      patients={allPatients}
                      onChange={v => updateAdm(row.id, "name", v)}
                      onSelect={p => selectAdm(row.id, p)}
                      placeholder="이름 검색 또는 직접 입력"
                      inputStyle={{ ...MS.input, width:180 }}
                    />
                    <input value={row.room} onChange={e => updateAdm(row.id,"room",e.target.value)}
                      placeholder="호실" style={{ ...MS.input, width:90 }} />
                    {(!row.time || TIME_OPTIONS.includes(row.time)) ? (
                      <select value={row.time||""} onChange={e => { if(e.target.value==="__custom__") updateAdm(row.id,"time",""); else updateAdm(row.id,"time",e.target.value); if(e.target.value==="__custom__") { const v=prompt("시간 입력 (예: 14시)"); if(v) updateAdm(row.id,"time",v.trim()); } }}
                        style={{ ...MS.input, width:85, color: row.time?"#166534":"#94a3b8", padding:"6px 4px" }}>
                        <option value="">시간</option>
                        {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                        <option value="__custom__">✏️ 직접입력</option>
                      </select>
                    ) : (
                      <input value={row.time} onChange={e => updateAdm(row.id,"time",e.target.value)}
                        style={{ ...MS.input, width:85, color:"#166534", padding:"6px 4px" }} />
                    )}
                  </div>
                  {/* 비고 + 뱃지 */}
                  <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                    <input value={row.note} onChange={e => updateAdm(row.id,"note",e.target.value)}
                      placeholder="비고 (나이, 진단, 병원 등)" style={{ ...MS.input, flex:1, minWidth:140 }} />
                    <label style={{ display:"flex", alignItems:"center", gap:3, fontSize:13, cursor:"pointer",
                      background: row.isNew ? "#fef08a":"#f1f5f9", borderRadius:5, padding:"3px 9px",
                      border:"1px solid", borderColor: row.isNew?"#fcd34d":"#e2e8f0",
                      color: row.isNew?"#713f12":"#64748b", fontWeight: row.isNew?700:500, whiteSpace:"nowrap" }}>
                      <input type="checkbox" checked={!!row.isNew}
                        onChange={e => updateAdm(row.id,"isNew",e.target.checked)} style={{ margin:0 }} />
                      ★신환
                    </label>
                  </div>
                </div>
                <button onClick={() => onChangeAdm(r => r.filter(x => x.id !== row.id))}
                  style={{ ...MS.delBtn, marginTop:6 }}>✕</button>
              </div>
            ))}
          </div>

          {/* 퇴원 섹션 */}
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <span style={{ fontWeight:800, fontSize:17, color:"#991b1b" }}>↓ 퇴원</span>
              <button onClick={() => onChangeDis(r => [...r, EMPTY_DIS()])}
                style={MS.addBtn}>+ 추가</button>
            </div>
            {discharges.length === 0 && (
              <div style={{ color:"#94a3b8", fontSize:13, padding:"8px 0" }}>퇴원 항목 없음</div>
            )}
            {discharges.map(row => (
              <div key={row.id} style={{ display:"flex", gap:6, alignItems:"flex-start",
                marginBottom:8, background:"#fff5f5", borderRadius:8, padding:"8px 10px" }}>
                <div style={{ flex:1, display:"flex", flexDirection:"column", gap:6 }}>
                  <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                    <PatientAutocomplete
                      value={row.name}
                      patients={allPatients}
                      onChange={v => updateDis(row.id, "name", v)}
                      onSelect={p => selectDis(row.id, p)}
                      placeholder="이름 검색 또는 직접 입력"
                      inputStyle={{ ...MS.input, width:180 }}
                    />
                    <input value={row.room} onChange={e => updateDis(row.id,"room",e.target.value)}
                      placeholder="호실" style={{ ...MS.input, width:90 }} />
                    {(!row.time || TIME_OPTIONS.includes(row.time)) ? (
                      <select value={row.time||""} onChange={e => { if(e.target.value==="__custom__") updateDis(row.id,"time",""); else updateDis(row.id,"time",e.target.value); if(e.target.value==="__custom__") { const v=prompt("시간 입력 (예: 14시)"); if(v) updateDis(row.id,"time",v.trim()); } }}
                        style={{ ...MS.input, width:85, color: row.time?"#991b1b":"#94a3b8", padding:"6px 4px" }}>
                        <option value="">시간</option>
                        {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                        <option value="__custom__">✏️ 직접입력</option>
                      </select>
                    ) : (
                      <input value={row.time} onChange={e => updateDis(row.id,"time",e.target.value)}
                        style={{ ...MS.input, width:85, color:"#991b1b", padding:"6px 4px" }} />
                    )}
                  </div>
                  <input value={row.note} onChange={e => updateDis(row.id,"note",e.target.value)}
                    placeholder="비고 (재입원: 3/28 재입원 등)" style={{ ...MS.input, width:"100%" }} />
                </div>
                <button onClick={() => onChangeDis(r => r.filter(x => x.id !== row.id))}
                  style={{ ...MS.delBtn, marginTop:6 }}>✕</button>
              </div>
            ))}
          </div>

          {/* 버튼 */}
          <div style={{ display:"flex", justifyContent:"flex-end", gap:10, paddingTop:4 }}>
            <button onClick={onClose}
              style={{ background:"#f1f5f9", color:"#374151", border:"none", borderRadius:8,
                padding:"8px 20px", cursor:"pointer", fontSize:14, fontWeight:600 }}>
              취소
            </button>
            <button onClick={onSave} disabled={saving}
              style={{ background:"#059669", color:"#fff", border:"none", borderRadius:8,
                padding:"8px 24px", cursor:"pointer", fontSize:14, fontWeight:700 }}>
              {saving ? "저장 중..." : "💾 저장"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PatientChip({ p, type, onDelete, highlight, onTimeChange }) {
  const [showTime, setShowTime] = useState(false);
  const [customInput, setCustomInput] = useState(false);
  const [customVal, setCustomVal] = useState("");
  const popRef = useRef(null);

  useEffect(() => {
    if (!showTime) return;
    const handler = (e) => { if (popRef.current && !popRef.current.contains(e.target)) { setShowTime(false); setCustomInput(false); } };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showTime]);

  const handleSelect = (val) => {
    if (onTimeChange) onTimeChange(val);
    setShowTime(false); setCustomInput(false);
  };

  return (
    <div style={{ display:"flex", alignItems:"center", gap:3, marginBottom:3, lineHeight:1.4,
      borderRadius:4, background: highlight ? "#fef3c7" : "transparent",
      outline: highlight ? "2px solid #f59e0b" : "none", position:"relative" }}>
      {p.isNew && <span style={{ fontSize:12, background:"#fef08a", color:"#713f12", borderRadius:3, padding:"1px 5px", fontWeight:800, flexShrink:0 }}>★신</span>}
      <span style={{ fontSize:16, fontWeight:700, color: type==="admission" ? "#000000" : "#991b1b", flexShrink:0 }}>{p.name}</span>
      {p.room && <span style={{ fontSize:13, color:"#64748b", flexShrink:0 }}>({p.room})</span>}
      {onTimeChange && (
        <span className="no-print" onClick={(e) => { e.stopPropagation(); setShowTime(s => !s); }}
          style={{ fontSize:11, borderRadius:3, padding:"0 4px", fontWeight:700, flexShrink:0, cursor:"pointer",
            background: p.time ? (type==="admission"?"#dcfce7":"#fee2e2") : "#f1f5f9",
            color: p.time ? (type==="admission"?"#166534":"#991b1b") : "#94a3b8",
            border: p.time ? "none" : "1px dashed #cbd5e1" }}>
          {p.time || "⏱"}
        </span>
      )}
      {!onTimeChange && p.time && (
        <span style={{ fontSize:11, background: type==="admission"?"#dcfce7":"#fee2e2",
          color: type==="admission"?"#166534":"#991b1b", borderRadius:3, padding:"0 4px",
          fontWeight:700, flexShrink:0 }}>{p.time}</span>
      )}
      {showTime && (
        <div ref={popRef} onClick={e => e.stopPropagation()}
          style={{ position:"absolute", top:"100%", left:0, zIndex:100, background:"#fff",
            borderRadius:8, boxShadow:"0 4px 16px rgba(0,0,0,0.18)", border:"1px solid #e2e8f0",
            padding:6, display:"flex", flexDirection:"column", gap:3, minWidth:100 }}>
          {TIME_OPTIONS.map(t => (
            <button key={t} onClick={() => handleSelect(t)}
              style={{ background: p.time===t?"#0f2744":"#f8fafc", color: p.time===t?"#fff":"#334155",
                border:"1px solid #e2e8f0", borderRadius:5, padding:"4px 10px", cursor:"pointer",
                fontSize:12, fontWeight:700, textAlign:"left" }}>{t}</button>
          ))}
          {!customInput ? (
            <button onClick={() => { setCustomInput(true); setCustomVal(p.time && !TIME_OPTIONS.includes(p.time) ? p.time : ""); }}
              style={{ background:"#f8fafc", color:"#64748b", border:"1px dashed #cbd5e1",
                borderRadius:5, padding:"4px 10px", cursor:"pointer", fontSize:12, fontWeight:600, textAlign:"left" }}>✏️ 직접입력</button>
          ) : (
            <div style={{ display:"flex", gap:3 }}>
              <input autoFocus value={customVal} onChange={e => setCustomVal(e.target.value)}
                onKeyDown={e => { if (e.key==="Enter" && customVal.trim()) handleSelect(customVal.trim()); }}
                placeholder="예: 14시" style={{ border:"1px solid #cbd5e1", borderRadius:4,
                  padding:"3px 6px", fontSize:12, width:70, outline:"none" }} />
              <button onClick={() => { if (customVal.trim()) handleSelect(customVal.trim()); }}
                style={{ background:"#059669", color:"#fff", border:"none", borderRadius:4,
                  padding:"3px 8px", cursor:"pointer", fontSize:11, fontWeight:700 }}>확인</button>
            </div>
          )}
          {p.time && (
            <button onClick={() => handleSelect("")}
              style={{ background:"#fff5f5", color:"#dc2626", border:"1px solid #fecaca",
                borderRadius:5, padding:"4px 10px", cursor:"pointer", fontSize:12, fontWeight:600, textAlign:"left" }}>✕ 삭제</button>
          )}
        </div>
      )}
      {onDelete && (
        <button className="no-print" onClick={onDelete}
          style={{ background:"none", border:"none", cursor:"pointer", color:"#ef4444",
            fontSize:13, padding:"0 2px", lineHeight:1, marginLeft:"auto", flexShrink:0 }}>✕</button>
      )}
    </div>
  );
}

/* ── 환자 이름 자동완성 ── */
function PatientAutocomplete({ value, onChange, onSelect, patients, placeholder, inputStyle }) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef(null);

  const filtered = useMemo(() => {
    if (!value.trim()) return [];
    const q = value.toLowerCase();
    return patients.filter(p => p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [value, patients]);

  // 필터 결과 바뀔 때 드롭다운 열기
  useEffect(() => {
    setOpen(filtered.length > 0);
    setActiveIdx(0);
  }, [filtered.length]);

  function select(p) {
    onChange(p.name);
    onSelect(p);
    setOpen(false);
  }

  function handleKey(e) {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i+1, filtered.length-1)); }
    else if (e.key === "ArrowUp")   { e.preventDefault(); setActiveIdx(i => Math.max(i-1, 0)); }
    else if (e.key === "Enter")     { e.preventDefault(); if (filtered[activeIdx]) select(filtered[activeIdx]); }
    else if (e.key === "Escape")    { setOpen(false); }
  }

  const SOURCE_STYLE = {
    current:      { bg:"#d1fae5", color:"#065f46" },
    reservation:  { bg:"#ede9fe", color:"#5b21b6" },
    consultation: { bg:"#fef9c3", color:"#854d0e" },
  };

  return (
    <div ref={wrapRef} style={{ position:"relative" }}>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
        onFocus={() => { if (filtered.length > 0) setOpen(true); }}
        placeholder={placeholder}
        style={inputStyle}
        autoComplete="off"
      />
      {open && (
        <div style={{ position:"absolute", top:"calc(100% + 3px)", left:0, zIndex:400,
          background:"#fff", border:"1px solid #e2e8f0", borderRadius:10,
          boxShadow:"0 8px 28px rgba(0,0,0,0.14)", minWidth:260, maxWidth:360, overflow:"hidden" }}>
          {filtered.map((p, i) => {
            const ss = SOURCE_STYLE[p.source] || SOURCE_STYLE.consultation;
            return (
              <div key={i} onMouseDown={() => select(p)}
                style={{ padding:"9px 14px", cursor:"pointer",
                  borderBottom:"1px solid #f1f5f9",
                  background: i === activeIdx ? "#eff6ff" : "#fff",
                  display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontWeight:700, fontSize:16, color:"#1e293b" }}>{p.name}</span>
                    {p.room && <span style={{ fontSize:13, color:"#64748b" }}>({p.room})</span>}
                  </div>
                  {p.note && (
                    <div style={{ fontSize:12, color:"#94a3b8", marginTop:2,
                      whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", maxWidth:220 }}>
                      {p.note}
                    </div>
                  )}
                </div>
                <span style={{ fontSize:11, borderRadius:4, padding:"2px 7px", fontWeight:700,
                  flexShrink:0, background:ss.bg, color:ss.color }}>
                  {p.sourceBadge}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const NS = {
  navBtn: { background:"rgba(255,255,255,0.1)", color:"#e2e8f0", border:"1px solid rgba(255,255,255,0.2)",
    borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:600 },
  monthBtn: { background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:6,
    padding:"4px 12px", cursor:"pointer", fontSize:14, fontWeight:700, color:"#374151" },
};
const MS = {
  input: { border:"1px solid #e2e8f0", borderRadius:6, padding:"7px 10px", fontSize:16,
    fontFamily:"inherit", outline:"none", background:"#fff" },
  addBtn: { background:"#f0fdf4", color:"#166534", border:"1px solid #bbf7d0",
    borderRadius:6, padding:"5px 14px", cursor:"pointer", fontSize:15, fontWeight:700 },
  delBtn: { background:"none", border:"none", cursor:"pointer", color:"#ef4444",
    fontSize:20, lineHeight:1, flexShrink:0, padding:"0 4px" },
};
