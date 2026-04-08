import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";

const WARD_STRUCTURE = {
  2: { name:"2병동", rooms:[{id:"201",type:"4인실",capacity:4},{id:"202",type:"1인실",capacity:1},{id:"203",type:"4인실",capacity:4},{id:"204",type:"2인실",capacity:2},{id:"205",type:"6인실",capacity:6},{id:"206",type:"6인실",capacity:6}]},
  3: { name:"3병동", rooms:[{id:"301",type:"4인실",capacity:4},{id:"302",type:"1인실",capacity:1},{id:"303",type:"4인실",capacity:4},{id:"304",type:"2인실",capacity:2},{id:"305",type:"2인실",capacity:2},{id:"306",type:"6인실",capacity:6}]},
  5: { name:"5병동", rooms:[{id:"501",type:"4인실",capacity:4},{id:"502",type:"1인실",capacity:1},{id:"503",type:"4인실",capacity:4},{id:"504",type:"2인실",capacity:2},{id:"505",type:"6인실",capacity:6},{id:"506",type:"6인실",capacity:6}]},
  6: { name:"6병동", rooms:[{id:"601",type:"6인실",capacity:6},{id:"602",type:"1인실",capacity:1},{id:"603",type:"6인실",capacity:6}]},
};
const TYPE_COLOR = {"1인실":"#6366f1","2인실":"#0ea5e9","4인실":"#10b981","6인실":"#f59e0b"};
const TYPE_BG    = {"1인실":"#eef2ff","2인실":"#e0f2fe","4인실":"#d1fae5","6인실":"#fef3c7"};

function parseDateStr(str) {
  if (!str || str === "미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return new Date(new Date().getFullYear(), parseInt(m[1])-1, parseInt(m[2]));
  const d = new Date(str); return isNaN(d) ? null : d;
}
function dateOnly(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }

function isoToMD(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr + "T00:00:00");
  return `${d.getMonth()+1}/${d.getDate()}`;
}

export default function AvailPanel({ onClose }) {
  const router = useRouter();
  const [slots,          setSlots]          = useState({});
  const [availAdmit,     setAvailAdmit]     = useState("");
  const [availDischarge, setAvailDischarge] = useState("");
  const [availTypes,     setAvailTypes]     = useState([]);
  const [availResults,   setAvailResults]   = useState(null);
  const [availAdj,       setAvailAdj]       = useState([]);
  const [applyingMove,   setApplyingMove]   = useState(false);

  useEffect(() => {
    const unsub = onValue(ref(db, "slots"), snap => setSlots(snap.val() || {}));
    return () => unsub();
  }, []);

  const slotFreeForPeriod = (slotsData, slotKey, fromD, toD) => {
    const slot = slotsData[slotKey];
    if (!slot) return true;
    if (slot.current?.name) {
      const d = parseDateStr(slot.current.discharge);
      if (!d || dateOnly(d) >= fromD) return false;
      // 자리보존 기간 체크: 현재 환자 퇴원 다음날 ~ 예약 입원 전날
      const curDisOnly = dateOnly(d);
      for (const r of (slot.reservations || [])) {
        if (!r?.name || !r?.preserveSeat || !r?.admitDate) continue;
        const rA = parseDateStr(r.admitDate);
        if (!rA) continue;
        const presStart = new Date(curDisOnly.getTime() + 86400000);
        const presEnd   = new Date(dateOnly(rA).getTime() - 86400000);
        if (presStart > presEnd) continue;
        if (toD) { if (presStart <= toD && presEnd >= fromD) return false; }
        else      { if (presEnd >= fromD) return false; }
      }
    }
    for (const r of (slot.reservations || [])) {
      if (!r?.name) continue;
      const rA = parseDateStr(r.admitDate);
      if (!rA) return false;
      const rD = parseDateStr(r.discharge);
      const rEnd = rD ? dateOnly(rD) : null;
      if (rEnd && toD) { if (dateOnly(rA) <= toD && rEnd >= fromD) return false; }
      else if (rEnd)   { if (rEnd >= fromD) return false; }
      else             { if (!toD || dateOnly(rA) <= toD) return false; }
    }
    return true;
  };

  const findAltSlots = (slotsData, excludeKey, roomType, fromD, toD) => {
    const alts = [];
    Object.entries(WARD_STRUCTURE).forEach(([, ward]) => {
      ward.rooms.forEach(room => {
        if (room.type !== roomType) return;
        for (let b = 1; b <= room.capacity; b++) {
          const sk = `${room.id}-${b}`;
          if (sk === excludeKey) continue;
          if (slotFreeForPeriod(slotsData, sk, fromD, toD))
            alts.push({ slotKey: sk, roomId: room.id, bedNum: b, wardName: ward.name });
        }
      });
    });
    return alts;
  };

  const computeAvail = (slotsData, admitD, dischargeD, types) => {
    const allRooms = Object.entries(WARD_STRUCTURE).flatMap(([, ward]) =>
      ward.rooms.map(r => ({ ...r, wardName: ward.name }))
    );
    const results = [], adjustments = [];
    allRooms.forEach(room => {
      if (types.length > 0 && !types.includes(room.type)) return;
      for (let bedNum = 1; bedNum <= room.capacity; bedNum++) {
        const slotKey = `${room.id}-${bedNum}`;
        if (slotFreeForPeriod(slotsData, slotKey, admitD, dischargeD)) {
          results.push({ slotKey, roomId: room.id, bedNum, roomType: room.type, wardName: room.wardName });
          continue;
        }
        const slot = slotsData[slotKey];
        (slot?.reservations || []).forEach((r, resIdx) => {
          const rA = parseDateStr(r.admitDate);
          if (!rA) return;
          const rD = parseDateStr(r.discharge);
          const rEnd = rD ? dateOnly(rD) : null;
          let overlaps = false;
          if (rEnd && dischargeD) overlaps = dateOnly(rA) <= dischargeD && rEnd >= admitD;
          else if (rEnd)          overlaps = rEnd >= admitD;
          else                    overlaps = !dischargeD || dateOnly(rA) <= dischargeD;
          if (!overlaps) return;
          const alts = findAltSlots(slotsData, slotKey, room.type, dateOnly(rA), rEnd);
          if (alts.length === 0) return;
          const scoredAlts = alts
            .map(alt => ({ ...alt, score: (alt.bedNum===bedNum?10:0)+(alt.roomId===room.id?5:0)+(alt.wardName===room.wardName?2:0) }))
            .sort((x, y) => y.score - x.score);
          adjustments.push({
            slotKey, roomId: room.id, bedNum, roomType: room.type, wardName: room.wardName,
            blocker: { name: r.name, admitDate: r.admitDate, discharge: r.discharge, resIndex: resIdx },
            alternatives: scoredAlts, bestScore: scoredAlts[0].score,
          });
        });
      }
    });
    adjustments.sort((x, y) => y.bestScore - x.bestScore);
    return { results, adjustments: adjustments.slice(0, 5) };
  };

  const doAvailCheck = (slotsOverride) => {
    if (!availAdmit) return;
    const admitD     = dateOnly(new Date(availAdmit + "T00:00:00"));
    const dischargeD = availDischarge ? dateOnly(new Date(availDischarge + "T00:00:00")) : null;
    const { results, adjustments } = computeAvail(slotsOverride || slots, admitD, dischargeD, availTypes);
    setAvailResults(results);
    setAvailAdj(adjustments);
  };

  const applyReservationMove = async (fromSlot, resIndex, toSlot, patientName) => {
    if (!confirm(`${patientName}님 예약을 ${toSlot.replace("-", "호 ")}번으로 이동하시겠습니까?`)) return;
    setApplyingMove(true);
    try {
      const fromData    = slots[fromSlot] || {};
      const reservation = (fromData.reservations || [])[resIndex];
      if (!reservation) return;
      const newFromRes = (fromData.reservations || []).filter((_, i) => i !== resIndex);
      const toData     = slots[toSlot] || { current: null, reservations: [] };
      const newToRes   = [...(toData.reservations || []), reservation]
        .sort((a, b) => { const da = parseDateStr(a.admitDate), db2 = parseDateStr(b.admitDate); return (!da||!db2)?0:da-db2; });
      await set(ref(db, `slots/${fromSlot}`), { ...fromData, reservations: newFromRes });
      await set(ref(db, `slots/${toSlot}`),   { ...toData,   reservations: newToRes  });
      const updated = { ...slots, [fromSlot]: { ...fromData, reservations: newFromRes }, [toSlot]: { ...toData, reservations: newToRes } };
      doAvailCheck(updated);
    } finally {
      setApplyingMove(false);
    }
  };

  const gotoRoom = (roomId) => {
    window.dispatchEvent(new CustomEvent("avail-goto-room", { detail: { roomId } }));
  };

  return (
    <div style={S.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={S.panel}>
        {/* 헤더 */}
        <div style={S.header}>
          <span style={S.title}>가용 병실 조회</span>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* 조회 조건 */}
        <div style={S.body}>
          <div style={S.row}>
            <div style={S.col}>
              <label style={S.lbl}>입원 예정일</label>
              <input type="date" value={availAdmit} onChange={e => setAvailAdmit(e.target.value)}
                style={S.inp} />
            </div>
            <span style={S.sep}>~</span>
            <div style={S.col}>
              <label style={S.lbl}>퇴원 예정일 (선택)</label>
              <input type="date" value={availDischarge} onChange={e => setAvailDischarge(e.target.value)}
                style={S.inp} />
            </div>
          </div>

          <div style={S.typeRow}>
            <label style={S.lbl}>병실 종류 (복수 선택)</label>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:4 }}>
              {["1인실","2인실","4인실","6인실"].map(t => (
                <button key={t}
                  onClick={() => setAvailTypes(prev => prev.includes(t) ? prev.filter(x=>x!==t) : [...prev, t])}
                  style={{ border:`1.5px solid ${TYPE_COLOR[t]}`, borderRadius:6, padding:"5px 14px",
                    cursor:"pointer", fontSize:13, fontWeight:700,
                    background: availTypes.includes(t) ? TYPE_COLOR[t] : TYPE_BG[t],
                    color:       availTypes.includes(t) ? "#fff"        : TYPE_COLOR[t] }}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          <button onClick={() => doAvailCheck()} disabled={!availAdmit}
            style={{ background:availAdmit?"#0f2744":"#94a3b8", color:"#fff", border:"none",
              borderRadius:9, padding:"10px 28px", fontSize:14, fontWeight:700,
              cursor:availAdmit?"pointer":"not-allowed", marginTop:4, alignSelf:"flex-start" }}>
            조회
          </button>

          {/* 결과 */}
          {availResults !== null && (
            <div style={{ marginTop:12 }}>
              {availResults.length > 0 ? (
                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:"#16a34a", marginBottom:8 }}>
                    직접 가용 병상 {availResults.length}개
                    {availTypes.length>0 && <span style={{ fontWeight:400, color:"#64748b", marginLeft:4 }}>({availTypes.join("·")})</span>}
                  </div>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                    {availResults.map((r, i) => (
                      <button key={i}
                        onClick={() => {
                          const admitMD    = isoToMD(availAdmit);
                          const dischargeMD = availDischarge ? isoToMD(availDischarge) : "미정";
                          router.push(`/ward-timeline?openRes=${encodeURIComponent(r.slotKey)}&admitDate=${encodeURIComponent(admitMD)}&discharge=${encodeURIComponent(dischargeMD)}`);
                          onClose();
                        }}
                        style={{ background:TYPE_BG[r.roomType], border:`1.5px solid ${TYPE_COLOR[r.roomType]}`,
                          borderRadius:7, padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:700,
                          color:TYPE_COLOR[r.roomType], display:"flex", alignItems:"center", gap:5 }}>
                        <span style={{ fontSize:11, color:"#64748b" }}>{r.wardName}</span>
                        {r.roomId}호 {r.bedNum}번
                        <span style={{ fontSize:10, background:TYPE_COLOR[r.roomType], color:"#fff",
                          borderRadius:3, padding:"1px 5px" }}>{r.roomType}</span>
                        <span style={{ fontSize:10, color:"#059669" }}>+ 예약</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ color:"#ef4444", fontWeight:700, fontSize:13, marginBottom:10 }}>직접 가용한 병상 없음</div>
              )}

              {availAdj.length > 0 && (
                <div style={{ borderTop:"1.5px solid #e9d5ff", paddingTop:12 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:"#7c3aed", marginBottom:10 }}>
                    예약 조정으로 확보 가능 (상위 {availAdj.length}건)
                    <span style={{ fontSize:11, fontWeight:400, color:"#64748b", marginLeft:6 }}>— 예약자를 같은 조건의 다른 병상으로 이동 시</span>
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {availAdj.map((adj, i) => (
                      <div key={i} style={{ background:"#faf5ff", border:"1px solid #e9d5ff", borderRadius:9, padding:"10px 14px" }}>
                        <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginBottom:6 }}>
                          <span style={{ fontSize:11, color:"#94a3b8", fontWeight:700 }}>#{i+1}</span>
                          <span style={{ background:"#7c3aed", color:"#fff", borderRadius:5, padding:"2px 9px", fontSize:12, fontWeight:700 }}>{adj.roomId}호 {adj.bedNum}번</span>
                          <span style={{ fontSize:11, background:TYPE_BG[adj.roomType], color:TYPE_COLOR[adj.roomType], borderRadius:4, padding:"2px 7px", fontWeight:700 }}>{adj.roomType}</span>
                          <span style={{ fontSize:13, color:"#374151" }}><strong>{adj.blocker.name}</strong>님 예약 {adj.blocker.admitDate}~{adj.blocker.discharge||"미정"}</span>
                        </div>
                        <div style={{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
                          <span style={{ fontSize:12, color:"#7c3aed", fontWeight:700, flexShrink:0 }}>이동 →</span>
                          {adj.alternatives.slice(0, 3).map((alt, ai) => (
                            <button key={ai} disabled={applyingMove}
                              onClick={() => applyReservationMove(adj.slotKey, adj.blocker.resIndex, alt.slotKey, adj.blocker.name)}
                              style={{ border:"1.5px solid #7c3aed", borderRadius:6, padding:"4px 11px",
                                fontSize:12, fontWeight:700, background:"#fff", color:"#7c3aed",
                                cursor:"pointer", opacity:applyingMove?0.6:1 }}>
                              {alt.wardName} {alt.roomId}호 {alt.bedNum}번 ✓ 적용
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {availResults.length===0 && availAdj.length===0 && (
                <div style={{ color:"#94a3b8", fontSize:13, marginTop:4 }}>조정 가능한 예약도 없습니다.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const S = {
  backdrop: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
    zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
  },
  panel: {
    background: "#fff", borderRadius: 16, width: "100%", maxWidth: 680,
    maxHeight: "85vh", display: "flex", flexDirection: "column",
    boxShadow: "0 24px 64px rgba(0,0,0,0.3)",
    fontFamily: "'Noto Sans KR','Pretendard',sans-serif",
  },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "18px 24px 14px", borderBottom: "1px solid #e2e8f0",
  },
  title: { fontSize: 16, fontWeight: 800, color: "#0f2744" },
  closeBtn: {
    background: "none", border: "none", cursor: "pointer",
    fontSize: 18, color: "#94a3b8", padding: "0 4px", lineHeight: 1,
  },
  body: {
    padding: "18px 24px 24px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14,
  },
  row: { display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" },
  col: { display: "flex", flexDirection: "column", gap: 4 },
  sep: { fontSize: 18, color: "#94a3b8", paddingBottom: 6 },
  lbl: { fontSize: 11, fontWeight: 700, color: "#64748b" },
  inp: { border: "1.5px solid #e2e8f0", borderRadius: 8, padding: "7px 10px", fontSize: 13, outline: "none", fontFamily: "inherit" },
  typeRow: { display: "flex", flexDirection: "column", gap: 4 },
};
