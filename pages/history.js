import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set, get } from "firebase/database";
import { db } from "../lib/firebaseConfig";

// ── 상수 ──────────────────────────────────────────────────────────────────────
const WARD_ROOMS = {
  "201": 4, "202": 1, "203": 4, "204": 2, "205": 6, "206": 6,
  "301": 4, "302": 1, "303": 4, "304": 2, "305": 2, "306": 6,
  "501": 4, "502": 1, "503": 4, "504": 2, "505": 6, "506": 6,
  "601": 6, "602": 1, "603": 6,
};

// 치료 항목 이름 → ID 매핑
const TREATMENT_NAME_TO_ID = {
  "고주파": "hyperthermia", "고주파온열치료": "hyperthermia",
  "자닥신": "zadaxin",
  "이뮤알파": "imualpha",
  "싸이원": "scion", "싸이원주": "scion",
  "이스카도": "iscador_m", "이스카도m": "iscador_m", "이스카도q": "iscador_q",
  "메시마": "meshima", "메시마f": "meshima",
  "셀레나제": "selenase_l", "셀레나제액상": "selenase_l",
  "셀레나제정": "selenase_t", "셀레나제필름": "selenase_f",
  "페인": "pain", "페인스크렘블러": "pain",
  "림프도수": "manip1",
  "도수치료": "manip2", "도수": "manip2",
  "고압산소치료": "hyperbaric",
  "글루타치온": "glutathione",
  "비타민c": "vitc", "비타민d": "vitd",
  "셀레늄": "selenium_iv",
};

const ACTION_LABELS = {
  discharge_update: "퇴원일 업데이트",
  transfer: "전실",
  admit_plan: "입원 예약",
  update: "정보 업데이트",
  ignore: "무시",
};

const ACTION_COLOR = {
  discharge_update: "#d97706",
  transfer: "#7c3aed",
  admit_plan: "#059669",
  update: "#0ea5e9",
  ignore: "#94a3b8",
};

// ── 유틸 ──────────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금 전";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return new Date(ts).toLocaleDateString("ko-KR");
}

function mapTreatmentsToIds(treatments) {
  if (!treatments?.length) return [];
  return treatments
    .map((t) => {
      const key = t.toLowerCase().replace(/\s/g, "");
      const id = TREATMENT_NAME_TO_ID[key] || TREATMENT_NAME_TO_ID[t.toLowerCase()];
      return id ? { id, qty: "1", label: t } : null;
    })
    .filter(Boolean);
}

function findPatientInRoom(slots, roomId, patientName) {
  const capacity = WARD_ROOMS[roomId] || 1;
  for (let i = 1; i <= capacity; i++) {
    const slotKey = `${roomId}-${i}`;
    const slot = slots[slotKey];
    if (!slot) continue;
    if (slot.current?.name === patientName) return { slotKey, mode: "current", resIndex: -1 };
    const ri = (slot.reservations || []).findIndex((r) => r.name === patientName);
    if (ri >= 0) return { slotKey, mode: "reservation", resIndex: ri };
  }
  return null;
}

function findEmptyBed(slots, roomId) {
  const capacity = WARD_ROOMS[roomId] || 1;
  for (let i = 1; i <= capacity; i++) {
    const sk = `${roomId}-${i}`;
    if (!slots[sk]?.current?.name) return sk;
  }
  return `${roomId}-1`;
}

function buildNote(p, existing = "") {
  const parts = [];
  if (p.treatments?.length) parts.push(p.treatments.join(", "));
  if (p.dischargeNote) parts.push(`퇴원약: ${p.dischargeNote}`);
  if (p.note) parts.push(p.note);
  const newNote = parts.join(" / ");
  if (!newNote) return existing;
  return existing ? `${existing} / ${newNote}` : newNote;
}

// ── 변경 적용 (슬롯 업데이트) ───────────────────────────────────────────────
async function applySlotChange(form) {
  const snap = await get(ref(db, "slots"));
  const slots = snap.val() || {};

  // 타겟 슬롯키 결정
  let targetSlotKey = form.slotKeyOverride || form.slotKey || null;
  let targetMode = "current";
  let targetResIndex = -1;

  if (!targetSlotKey && form.room) {
    if (form.bedNumber) {
      targetSlotKey = `${form.room}-${form.bedNumber}`;
    } else if (form.name) {
      const found = findPatientInRoom(slots, form.room, form.name);
      if (found) {
        targetSlotKey = found.slotKey;
        targetMode = found.mode;
        targetResIndex = found.resIndex;
      } else {
        targetSlotKey = findEmptyBed(slots, form.room);
      }
    }
  }

  if (!targetSlotKey) throw new Error("병상을 특정할 수 없습니다. '적용 병상' 필드를 직접 입력해 주세요.");

  // 이미 슬롯키가 있는데 mode/resIndex가 결정 안 된 경우 → 슬롯에서 환자 탐색
  if (targetMode === "current" && targetResIndex === -1 && form.name) {
    const slot = slots[targetSlotKey];
    if (slot?.current?.name && slot.current.name !== form.name) {
      const ri = (slot.reservations || []).findIndex((r) => r.name === form.name);
      if (ri >= 0) { targetMode = "reservation"; targetResIndex = ri; }
    }
  }

  const beforeSnapshot = {};
  beforeSnapshot[targetSlotKey] = JSON.parse(JSON.stringify(slots[targetSlotKey] || null));

  const newSlots = JSON.parse(JSON.stringify(slots));
  if (!newSlots[targetSlotKey]) newSlots[targetSlotKey] = { current: null, reservations: [] };
  const slot = newSlots[targetSlotKey];
  let changeDescription = "";
  let finalSlotKey = targetSlotKey;

  // ── action별 처리 ────────────────────────────────────────────────────────
  if (form.action === "transfer" && form.transferToRoom) {
    const patient =
      targetMode === "current" ? slot.current : (slot.reservations || [])[targetResIndex];
    if (!patient) throw new Error(`${form.name} 환자를 ${targetSlotKey}에서 찾을 수 없습니다.`);

    if (targetMode === "current") slot.current = null;
    else slot.reservations.splice(targetResIndex, 1);

    const newSlotKey = findEmptyBed(newSlots, form.transferToRoom);
    beforeSnapshot[newSlotKey] = JSON.parse(JSON.stringify(slots[newSlotKey] || null));
    if (!newSlots[newSlotKey]) newSlots[newSlotKey] = { current: null, reservations: [] };

    if (form.roomFeeType) patient.roomFeeType = form.roomFeeType;
    const extra = buildNote({ note: form.note });
    if (extra) patient.note = patient.note ? `${patient.note} / ${extra}` : extra;

    newSlots[newSlotKey].current = patient;
    changeDescription = `[전실] ${form.name}: ${targetSlotKey} → ${newSlotKey}`;
    finalSlotKey = newSlotKey;

  } else if (form.action === "admit_plan") {
    const reservation = {
      name: form.name,
      admitDate: form.admitDate || "",
      discharge: form.dischargeDate || "미정",
      note: buildNote(form),
      scheduleAlert: form.scheduleAlert || false,
    };
    if (form.roomFeeType) reservation.roomFeeType = form.roomFeeType;
    if (!slot.reservations) slot.reservations = [];
    slot.reservations.push(reservation);
    changeDescription = `[입원예약] ${form.name} → ${targetSlotKey} (입원: ${reservation.admitDate || "미정"})`;

  } else {
    // discharge_update / update
    let patient =
      targetMode === "current"
        ? slot.current
        : targetResIndex >= 0
        ? (slot.reservations || [])[targetResIndex]
        : null;

    if (!patient) {
      patient = { name: form.name };
      slot.current = patient;
      targetMode = "current";
    }

    if (form.dischargeDate) patient.discharge = form.dischargeDate;
    if (form.admitDate) patient.admitDate = form.admitDate;
    if (form.roomFeeType) patient.roomFeeType = form.roomFeeType;
    if (form.scheduleAlert) patient.scheduleAlert = true;

    const noteAdd = buildNote({
      treatments: form.treatments,
      dischargeNote: form.dischargeNote,
      note: form.note,
    });
    if (noteAdd) patient.note = patient.note ? `${patient.note} / ${noteAdd}` : noteAdd;

    if (targetMode === "current") slot.current = patient;
    else slot.reservations[targetResIndex] = patient;

    const updates = [];
    if (form.dischargeDate) updates.push(`퇴원: ${form.dischargeDate}`);
    if (form.admitDate) updates.push(`입원예정: ${form.admitDate}`);
    if (form.roomFeeType) updates.push(`병실료: ${form.roomFeeType}`);
    changeDescription = `[업데이트] ${form.name} (${targetSlotKey}): ${updates.join(", ") || "정보 갱신"}`;
  }

  await set(ref(db, "slots"), newSlots);
  return { changeDescription, targetSlotKey, finalSlotKey, beforeSnapshot };
}

// ── 치료일정 등록 ──────────────────────────────────────────────────────────
async function addTreatmentPlan(slotKey, treatmentIds, dateStr) {
  if (!slotKey || !treatmentIds?.length) return;
  const date = new Date(dateStr + "T00:00:00");
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const dayKey = String(day);

  const snap = await get(ref(db, `treatmentPlans/${slotKey}`));
  const plan = snap.val() || {};
  const existing = plan[monthKey]?.[dayKey] || [];
  const newItems = [
    ...existing.filter((e) => !treatmentIds.find((t) => t.id === e.id)),
    ...treatmentIds.map((t) => ({ id: t.id, qty: t.qty })),
  ];

  await set(ref(db, `treatmentPlans/${slotKey}`), {
    ...plan,
    [monthKey]: { ...(plan[monthKey] || {}), [dayKey]: newItems },
  });
}

// ── 메인 페이지 ──────────────────────────────────────────────────────────────
export default function HistoryPage() {
  const router = useRouter();
  const [changes, setChanges] = useState({});
  const [webhookLogs, setWebhookLogs] = useState({});
  const [activeTab, setActiveTab] = useState("pending");

  useEffect(() => {
    const unsub1 = onValue(ref(db, "pendingChanges"), (snap) => {
      setChanges(snap.val() || {});
    });
    const unsub2 = onValue(ref(db, "webhookLogs"), (snap) => {
      setWebhookLogs(snap.val() || {});
    });
    return () => { unsub1(); unsub2(); };
  }, []);

  const handleApprove = useCallback(async (changeId, form, addTreat, treatDate) => {
    const { changeDescription, finalSlotKey } = await applySlotChange(form);

    // 치료일정 등록
    if (addTreat && form.treatments?.length) {
      const mapped = mapTreatmentsToIds(form.treatments);
      if (mapped.length) await addTreatmentPlan(finalSlotKey, mapped, treatDate);
    }

    // 승인 처리
    const changeSnap = await get(ref(db, `pendingChanges/${changeId}`));
    await set(ref(db, `pendingChanges/${changeId}`), {
      ...changeSnap.val(),
      status: "approved",
      resolvedAt: new Date().toISOString(),
      appliedDescription: changeDescription,
      appliedSlotKey: finalSlotKey,
      appliedData: form,
    });

    // 로그 기록
    const logSnap = await get(ref(db, "logs"));
    const raw = logSnap.val();
    const logs = raw ? (Array.isArray(raw) ? raw : Object.values(raw)) : [];
    await set(ref(db, "logs"), [
      {
        ts: new Date().toISOString(),
        action: "webhook-approved",
        source: "naver-works",
        changeId,
        description: changeDescription,
        name: form.name,
        slotKey: finalSlotKey,
      },
      ...logs,
    ].slice(0, 200));
  }, []);

  const handleReject = useCallback(async (changeId) => {
    if (!confirm("이 변경을 거절하시겠습니까?")) return;
    const changeSnap = await get(ref(db, `pendingChanges/${changeId}`));
    await set(ref(db, `pendingChanges/${changeId}`), {
      ...changeSnap.val(),
      status: "rejected",
      resolvedAt: new Date().toISOString(),
    });
  }, []);

  const allList = Object.entries(changes)
    .map(([id, c]) => ({ ...c, id }))
    .sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const pendingList = allList.filter((c) => c.status === "pending");
  const resolvedList = allList.filter((c) => c.status !== "pending");

  return (
    <div style={H.page}>
      <header style={H.header}>
        <button onClick={() => router.push("/")} style={H.btnBack}>← 현황판</button>
        <span style={H.title}>📋 웹훅 변경 이력</span>
        {pendingList.length > 0 && (
          <span style={H.badge}>{pendingList.length}건 대기</span>
        )}
      </header>

      <div style={H.tabBar}>
        <button style={{ ...H.tab, ...(activeTab === "pending"  ? H.tabActive : {}) }} onClick={() => setActiveTab("pending")}>
          대기중{pendingList.length > 0 ? ` (${pendingList.length})` : ""}
        </button>
        <button style={{ ...H.tab, ...(activeTab === "resolved" ? H.tabActive : {}) }} onClick={() => setActiveTab("resolved")}>
          처리완료{resolvedList.length > 0 ? ` (${resolvedList.length})` : ""}
        </button>
        <button style={{ ...H.tab, ...(activeTab === "logs"     ? H.tabActive : {}) }} onClick={() => setActiveTab("logs")}>
          🔍 진단
        </button>
      </div>

      <main style={{ padding: "12px", maxWidth: 720, margin: "0 auto" }}>
        {activeTab === "pending" && (
          pendingList.length === 0
            ? <div style={H.empty}>대기 중인 변경이 없습니다.</div>
            : pendingList.map((change) => (
                <PendingCard
                  key={change.id}
                  change={change}
                  onApprove={(form, addTreat, treatDate) =>
                    handleApprove(change.id, form, addTreat, treatDate)
                  }
                  onReject={() => handleReject(change.id)}
                />
              ))
        )}
        {activeTab === "resolved" && (
          resolvedList.length === 0
            ? <div style={H.empty}>처리된 이력이 없습니다.</div>
            : resolvedList.map((change) => (
                <ResolvedCard key={change.id} change={change} />
              ))
        )}
        {activeTab === "logs" && (
          <WebhookLogsTab logs={webhookLogs} />
        )}
      </main>
    </div>
  );
}

// ── 대기 카드 ─────────────────────────────────────────────────────────────────
function PendingCard({ change, onApprove, onReject }) {
  const p = change.parsed || {};
  const [form, setForm] = useState({
    action: p.action || "update",
    room: p.room || "",
    bedNumber: p.bedNumber || "",
    slotKey: p.slotKey || "",
    slotKeyOverride: change.suggestedSlotKey || p.slotKey || "",
    name: p.name || "",
    dischargeDate: p.dischargeDate || "",
    admitDate: p.admitDate || "",
    transferToRoom: p.transferToRoom || "",
    treatments: p.treatments || [],
    dischargeNote: p.dischargeNote || "",
    roomFeeType: p.roomFeeType || "",
    note: p.note || "",
    scheduleAlert: p.scheduleAlert || false,
  });
  const [newTreat, setNewTreat] = useState("");
  const [addTreat, setAddTreat] = useState((p.treatments || []).length > 0);
  const [treatDate, setTreatDate] = useState(todayStr());
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const mappedTreatments = mapTreatmentsToIds(form.treatments);

  const handleApprove = async () => {
    if (!form.name.trim()) { setError("환자명을 입력해 주세요."); return; }
    if (!form.slotKeyOverride && !form.room) { setError("병실 또는 적용 병상을 입력해 주세요."); return; }
    setError("");
    setProcessing(true);
    try {
      await onApprove(form, addTreat && mappedTreatments.length > 0, treatDate);
    } catch (err) {
      setError(err.message);
      setProcessing(false);
    }
  };

  const addTreatItem = () => {
    const t = newTreat.trim();
    if (t && !form.treatments.includes(t)) {
      setF("treatments", [...form.treatments, t]);
    }
    setNewTreat("");
  };

  return (
    <div style={H.card}>
      {/* 카드 헤더 */}
      <div style={H.cardHead}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={H.sourceTag}>📱 네이버 웍스</span>
          <span style={{
            ...H.actionTag,
            background: ACTION_COLOR[form.action] + "20",
            color: ACTION_COLOR[form.action],
          }}>
            {ACTION_LABELS[form.action] || form.action}
          </span>
        </div>
        <span style={H.timeAgo}>{relativeTime(change.ts)}</span>
      </div>

      {/* 원본 메시지 */}
      <div style={H.msgBox}>
        <div style={H.msgLabel}>원본 메시지</div>
        <div style={H.msgText}>"{change.message}"</div>
        {change.userId && <div style={H.userId}>보낸 사람: {change.userId}</div>}
      </div>

      {/* AI 파싱 결과 — 편집 가능 */}
      <div style={{ padding: "12px 14px" }}>
        <div style={H.sectionTitle}>🤖 AI 파싱 결과 <span style={H.editHint}>직접 수정 가능</span></div>

        <div style={H.grid}>
          {/* 액션 */}
          <div style={H.field}>
            <label style={H.label}>액션</label>
            <select value={form.action} onChange={(e) => setF("action", e.target.value)} style={H.select}>
              <option value="discharge_update">퇴원일 업데이트</option>
              <option value="transfer">전실</option>
              <option value="admit_plan">입원 예약</option>
              <option value="update">정보 업데이트</option>
            </select>
          </div>

          {/* 환자명 */}
          <div style={H.field}>
            <label style={H.label}>환자명 ★</label>
            <input
              value={form.name}
              onChange={(e) => setF("name", e.target.value)}
              style={H.input}
              placeholder="환자명"
            />
          </div>

          {/* 병실 */}
          <div style={H.field}>
            <label style={H.label}>병실</label>
            <input
              value={form.room}
              onChange={(e) => setF("room", e.target.value)}
              style={H.input}
              placeholder="예: 306"
            />
          </div>

          {/* 적용 병상 (suggestedSlotKey) */}
          <div style={H.field}>
            <label style={H.label}>
              적용 병상
              {change.suggestedSlotKey && (
                <span style={{ color: "#059669", fontWeight: 400, marginLeft: 4 }}>
                  (추천: {change.suggestedSlotKey})
                </span>
              )}
            </label>
            <input
              value={form.slotKeyOverride}
              onChange={(e) => setF("slotKeyOverride", e.target.value)}
              style={H.input}
              placeholder="예: 306-2"
            />
          </div>

          {/* 퇴원예정일 */}
          {form.action !== "transfer" && (
            <div style={H.field}>
              <label style={H.label}>퇴원예정일</label>
              <input
                value={form.dischargeDate}
                onChange={(e) => setF("dischargeDate", e.target.value)}
                style={H.input}
                placeholder="예: 3/15"
              />
            </div>
          )}

          {/* 입원예정일 (예약 시) */}
          {form.action === "admit_plan" && (
            <div style={H.field}>
              <label style={H.label}>입원예정일</label>
              <input
                value={form.admitDate}
                onChange={(e) => setF("admitDate", e.target.value)}
                style={H.input}
                placeholder="예: 3/20"
              />
            </div>
          )}

          {/* 전실 대상 병실 */}
          {form.action === "transfer" && (
            <div style={H.field}>
              <label style={H.label}>전실할 병실</label>
              <input
                value={form.transferToRoom}
                onChange={(e) => setF("transferToRoom", e.target.value)}
                style={H.input}
                placeholder="예: 501"
              />
            </div>
          )}

          {/* 병실료 */}
          <div style={H.field}>
            <label style={H.label}>병실료 유형</label>
            <select
              value={form.roomFeeType || ""}
              onChange={(e) => setF("roomFeeType", e.target.value || null)}
              style={H.select}
            >
              <option value="">미설정</option>
              <option value="F">F (Free)</option>
              <option value="O">O (일반)</option>
            </select>
          </div>

          {/* 특이사항 */}
          <div style={{ ...H.field, gridColumn: "1 / -1" }}>
            <label style={H.label}>특이사항 / 메모</label>
            <input
              value={form.note || ""}
              onChange={(e) => setF("note", e.target.value)}
              style={H.input}
              placeholder="특이사항"
            />
          </div>

          {/* 스케줄 확인 */}
          <div style={{ ...H.field, gridColumn: "1 / -1" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={form.scheduleAlert}
                onChange={(e) => setF("scheduleAlert", e.target.checked)}
              />
              ⚠ 스케줄 확인 필요
            </label>
          </div>
        </div>

        {/* 치료 항목 */}
        <div style={{ marginTop: 10 }}>
          <label style={H.label}>치료 항목</label>
          {form.treatments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8, marginTop: 4 }}>
              {form.treatments.map((t, i) => (
                <span key={i} style={H.treatChip}>
                  {t}
                  <button
                    onClick={() => setF("treatments", form.treatments.filter((_, j) => j !== i))}
                    style={H.chipDel}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={newTreat}
              onChange={(e) => setNewTreat(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTreatItem()}
              style={{ ...H.input, flex: 1 }}
              placeholder="치료명 입력 후 Enter (예: 이뮤알파)"
            />
            <button onClick={addTreatItem} style={H.btnAdd}>추가</button>
          </div>
        </div>

        {/* 치료일정 등록 옵션 */}
        {mappedTreatments.length > 0 && (
          <div style={H.treatBox}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", fontWeight: 700 }}>
              <input
                type="checkbox"
                checked={addTreat}
                onChange={(e) => setAddTreat(e.target.checked)}
              />
              💊 치료일정표에도 등록
            </label>
            {addTreat && (
              <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "#64748b" }}>등록 날짜:</span>
                <input
                  type="date"
                  value={treatDate}
                  onChange={(e) => setTreatDate(e.target.value)}
                  style={{ ...H.input, width: "auto" }}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {mappedTreatments.map((t) => (
                    <span key={t.id} style={H.mappedChip}>
                      {t.label} → <strong>{t.id}</strong>
                    </span>
                  ))}
                  {form.treatments.length !== mappedTreatments.length && (
                    <span style={{ fontSize: 11, color: "#f59e0b" }}>
                      ⚠ {form.treatments.length - mappedTreatments.length}개 항목 미매핑
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 에러 */}
      {error && (
        <div style={{ margin: "0 14px 10px", background: "#fef2f2", color: "#dc2626", borderRadius: 7, padding: "8px 12px", fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}

      {/* 액션 버튼 */}
      <div style={H.cardFoot}>
        <button
          onClick={handleApprove}
          disabled={processing}
          style={{ ...H.btnApprove, opacity: processing ? 0.6 : 1 }}
        >
          {processing ? "처리중..." : "✓ 승인 — 현황판에 반영"}
        </button>
        <button onClick={onReject} disabled={processing} style={H.btnReject}>
          ✗ 거절
        </button>
      </div>
    </div>
  );
}

// ── 완료 카드 ─────────────────────────────────────────────────────────────────
function ResolvedCard({ change }) {
  const [open, setOpen] = useState(false);
  const approved = change.status === "approved";
  return (
    <div style={{
      ...H.card,
      borderLeft: `4px solid ${approved ? "#10b981" : "#ef4444"}`,
    }}>
      <div
        style={{ padding: "10px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
        onClick={() => setOpen((v) => !v)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 700, color: approved ? "#059669" : "#dc2626", fontSize: 14 }}>
            {approved ? "✓ 승인" : "✗ 거절"}
          </span>
          <span style={{ fontSize: 14, color: "#0f2744", fontWeight: 600 }}>
            {change.parsed?.name && `${change.parsed.name}`}
          </span>
          {change.parsed?.action && (
            <span style={{ fontSize: 12, color: "#64748b" }}>
              ({ACTION_LABELS[change.parsed.action] || change.parsed.action})
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "#94a3b8" }}>
            {relativeTime(change.resolvedAt || change.ts)}
          </span>
          <span style={{ fontSize: 12, color: "#94a3b8" }}>{open ? "▲" : "▼"}</span>
        </div>
      </div>

      {open && (
        <div style={{ padding: "0 14px 12px", borderTop: "1px solid #f1f5f9" }}>
          <div style={{ ...H.msgBox, margin: "10px 0 8px" }}>
            <div style={H.msgLabel}>원본 메시지</div>
            <div style={H.msgText}>"{change.message}"</div>
          </div>
          {approved && change.appliedDescription && (
            <div style={{ fontSize: 13, color: "#059669", fontWeight: 700, marginTop: 6 }}>
              → {change.appliedDescription}
            </div>
          )}
          {change.resolvedAt && (
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
              처리 시각: {new Date(change.resolvedAt).toLocaleString("ko-KR")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 진단 탭 ──────────────────────────────────────────────────────────────────
function WebhookLogsTab({ logs }) {
  const list = Object.entries(logs)
    .map(([id, v]) => ({ ...v, id }))
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, 30);

  if (list.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "40px 20px", color: "#94a3b8" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📭</div>
        <div style={{ fontSize: 15, fontWeight: 700 }}>수신된 웹훅 없음</div>
        <div style={{ fontSize: 13, marginTop: 8 }}>
          네이버 웍스에서 메시지를 보내면 여기에 수신 기록이 표시됩니다.
        </div>
        <div style={{ marginTop: 16, background: "#f8fafc", borderRadius: 10, padding: "14px 16px", textAlign: "left", fontSize: 13, color: "#475569" }}>
          <b>웹훅 URL 확인:</b><br/>
          <code style={{ background: "#e2e8f0", padding: "2px 6px", borderRadius: 4, fontSize: 12 }}>
            https://ewoo-hospital.vercel.app/api/naver-works-webhook
          </code>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10 }}>최근 {list.length}건 수신 기록 (진단용)</div>
      {list.map((log) => (
        <div key={log.id} style={{ background: "#fff", borderRadius: 10, padding: "10px 14px", marginBottom: 8, boxShadow: "0 1px 4px rgba(0,0,0,0.07)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{
              fontSize: 12, fontWeight: 700, borderRadius: 8, padding: "2px 8px",
              background: log.status === "saved" ? "#d1fae5" : log.status === "ignored" ? "#fef9c3" : "#fee2e2",
              color:      log.status === "saved" ? "#065f46" : log.status === "ignored" ? "#854d0e" : "#dc2626",
            }}>{log.status || "unknown"}</span>
            <span style={{ fontSize: 11, color: "#94a3b8" }}>{log.ts ? new Date(log.ts).toLocaleString("ko-KR") : ""}</span>
          </div>
          <div style={{ fontSize: 12, color: "#475569", marginBottom: 4 }}>
            <b>Content-Type:</b> {log.contentType || "없음"} &nbsp;|&nbsp;
            <b>type:</b> {log.payloadType || "없음"} &nbsp;|&nbsp;
            <b>content.type:</b> {log.contentSubType || "없음"}
          </div>
          {log.reason && <div style={{ fontSize: 12, color: "#f59e0b" }}>무시 사유: {log.reason}</div>}
          {log.error  && <div style={{ fontSize: 12, color: "#dc2626" }}>오류: {log.error}</div>}
          {log.rawPayload && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 11, color: "#94a3b8", cursor: "pointer" }}>raw payload 보기</summary>
              <pre style={{ fontSize: 10, background: "#f8fafc", padding: "6px 8px", borderRadius: 6, overflow: "auto", marginTop: 4, maxHeight: 200 }}>
                {log.rawPayload}
              </pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

// ── 스타일 ────────────────────────────────────────────────────────────────────
const H = {
  page: { fontFamily: "'Noto Sans KR','Pretendard',sans-serif", background: "#f0f4f8", minHeight: "100vh", color: "#0f172a" },
  header: { background: "#0f2744", color: "#fff", padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 40, boxShadow: "0 2px 8px rgba(0,0,0,0.15)" },
  btnBack: { background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", color: "#fff", borderRadius: 7, padding: "5px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, flexShrink: 0 },
  title: { fontSize: 18, fontWeight: 800 },
  badge: { background: "#ef4444", color: "#fff", borderRadius: 12, padding: "2px 10px", fontSize: 13, fontWeight: 700, marginLeft: "auto" },
  tabBar: { background: "#fff", borderBottom: "1px solid #e2e8f0", display: "flex" },
  tab: { flex: 1, padding: "12px 0", background: "none", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600, color: "#64748b" },
  tabActive: { color: "#0f2744", borderBottom: "2px solid #0f2744" },
  empty: { textAlign: "center", color: "#94a3b8", padding: "60px 20px", fontSize: 15 },

  card: { background: "#fff", borderRadius: 12, boxShadow: "0 1px 6px rgba(0,0,0,0.08)", marginBottom: 12, overflow: "hidden" },
  cardHead: { background: "#f8fafc", padding: "8px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #e2e8f0" },
  sourceTag: { fontSize: 12, fontWeight: 700, color: "#0ea5e9", background: "#e0f2fe", borderRadius: 12, padding: "2px 8px" },
  actionTag: { fontSize: 12, fontWeight: 700, borderRadius: 12, padding: "2px 8px" },
  timeAgo: { fontSize: 12, color: "#94a3b8" },

  msgBox: { padding: "10px 14px", background: "#fafafa", borderBottom: "1px solid #f1f5f9" },
  msgLabel: { fontSize: 11, fontWeight: 700, color: "#94a3b8", marginBottom: 4 },
  msgText: { fontSize: 15, fontWeight: 700, color: "#0f2744", lineHeight: 1.5 },
  userId: { fontSize: 11, color: "#94a3b8", marginTop: 4 },

  sectionTitle: { fontSize: 14, fontWeight: 800, color: "#0f2744", marginBottom: 10 },
  editHint: { fontSize: 11, fontWeight: 400, color: "#94a3b8", marginLeft: 6 },

  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))", gap: 8 },
  field: {},
  label: { display: "block", fontSize: 11, fontWeight: 700, color: "#64748b", marginBottom: 3 },
  input: { width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 7, padding: "7px 10px", fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit" },
  select: { width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 7, padding: "7px 10px", fontSize: 13, outline: "none", boxSizing: "border-box", background: "#fff", fontFamily: "inherit" },

  treatChip: { display: "inline-flex", alignItems: "center", gap: 4, background: "#fef3c7", color: "#92400e", borderRadius: 12, padding: "3px 10px", fontSize: 13, fontWeight: 600 },
  chipDel: { background: "none", border: "none", cursor: "pointer", color: "#d97706", fontSize: 12, padding: "0 1px", lineHeight: 1 },
  btnAdd: { background: "#0f2744", color: "#fff", border: "none", borderRadius: 7, padding: "7px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" },

  treatBox: { marginTop: 10, background: "#f0fdf4", borderRadius: 8, padding: "10px 12px", border: "1px solid #bbf7d0" },
  mappedChip: { background: "#d1fae5", color: "#065f46", borderRadius: 8, padding: "2px 8px", fontSize: 12 },

  cardFoot: { padding: "12px 14px", borderTop: "1px solid #f1f5f9", display: "flex", gap: 8 },
  btnApprove: { flex: 1, background: "#059669", color: "#fff", border: "none", borderRadius: 8, padding: "12px", cursor: "pointer", fontSize: 14, fontWeight: 800 },
  btnReject: { background: "#fef2f2", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 8, padding: "12px 18px", cursor: "pointer", fontSize: 14, fontWeight: 700 },
};
