/**
 * 환자 검색 및 신규 등록 유틸리티
 * 검색 우선순위: 전화번호(즉시) > 이름+생년월일 > 이름만
 */

import { ref, get, set, update } from "firebase/database";
import { db } from "./firebaseConfig";

export function normalizePhone(raw) {
  if (!raw) return "";
  return String(raw).replace(/\D/g, "");
}

function padId(n) {
  return "P" + String(n).padStart(5, "0");
}

/** 전화번호로 환자 즉시 조회 */
export async function findPatientByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (normalized.length < 10) return null;
  const snap = await get(ref(db, `patientByPhone/${normalized}`));
  if (!snap.val()) return null;
  const internalId = snap.val();
  return getPatientByInternalId(internalId);
}

/** 차트번호로 환자 조회 */
export async function findPatientByChartNo(chartNo) {
  const snap = await get(ref(db, `patientByChartNo/${chartNo}`));
  if (!snap.val()) return null;
  return getPatientByInternalId(snap.val());
}

/** internalId로 환자 조회 */
export async function getPatientByInternalId(internalId) {
  // patients는 chartNo가 키이므로 internalId로 직접 접근 불가
  // patientById 인덱스를 쓰거나, 전체에서 찾기
  const snap = await get(ref(db, "patients"));
  const all = snap.val() || {};
  const found = Object.values(all).find(p => p.internalId === internalId);
  return found || null;
}

/** 이름 + 생년월일로 환자 검색 (클라이언트 필터) */
export async function findPatientByNameAndBirth(name, birthDate) {
  const snap = await get(ref(db, "patients"));
  const all = snap.val() || {};
  return Object.values(all).find(p =>
    p.name === name.trim() && p.birthDate === birthDate
  ) || null;
}

/** 이름으로 환자 검색 (부분 일치, 복수 반환) */
export async function searchPatientsByName(name) {
  if (!name?.trim()) return [];
  const snap = await get(ref(db, "patients"));
  const all = snap.val() || {};
  return Object.values(all)
    .filter(p => p.name?.includes(name.trim()))
    .sort((a, b) => (a.name > b.name ? 1 : -1));
}

/** 이름 또는 전화번호로 통합 검색 (부분 일치) */
export async function searchPatients(query) {
  if (!query?.trim()) return [];
  const snap = await get(ref(db, "patients"));
  const all = snap.val() || {};
  const q = query.trim();
  const normalized = normalizePhone(q);
  return Object.values(all)
    .filter(p => {
      if (p.name?.includes(q)) return true;
      if (normalized.length >= 7 && normalizePhone(p.phone)?.includes(normalized)) return true;
      return false;
    })
    .sort((a, b) => (a.name > b.name ? 1 : -1));
}

/**
 * 신규 환자 등록
 * @param {{ name, birthDate, gender, phone, chartNo, address, doctor, diagnosis }} data
 * @returns {Promise<patient>} 생성된 환자 객체
 */
export async function registerNewPatient(data) {
  // 1) 전화번호 중복 체크
  const phone = normalizePhone(data.phone);
  if (phone) {
    const existing = await findPatientByPhone(phone);
    if (existing) return { ...existing, _duplicate: true };
  }

  // 2) 이름+생년월일 중복 체크
  if (data.name && data.birthDate) {
    const existing = await findPatientByNameAndBirth(data.name, data.birthDate);
    if (existing) return { ...existing, _duplicate: true };
  }

  // 3) 새 internalId 발급
  const counterRef = ref(db, "patientCounter/lastSeq");
  const snap = await get(counterRef);
  const nextSeq = (snap.val() || 0) + 1;
  const internalId = padId(nextSeq);

  const patient = {
    internalId,
    name:          data.name?.trim() || "",
    birthDate:     data.birthDate    || "",
    gender:        data.gender       || "",
    phone,
    address:       data.address      || "",
    doctor:        data.doctor       || "",
    diagnosis:     data.diagnosis    || "",
    chartNo:       data.chartNo      || "",
    lastAdmitDate: data.lastAdmitDate || "",
    createdAt:     new Date().toISOString(),
  };

  // chartNo가 있으면 그걸 키로, 없으면 internalId를 키로 사용
  const dbKey = data.chartNo || internalId;

  const updates = {};
  updates[`patients/${dbKey}`]           = patient;
  updates[`patientCounter/lastSeq`]      = nextSeq;
  if (phone) updates[`patientByPhone/${phone}`] = internalId;
  if (data.chartNo) updates[`patientByChartNo/${data.chartNo}`] = internalId;

  await update(ref(db), updates);
  return patient;
}
