/**
 * 치료 계획 경로 헬퍼 (patient-keyed 스키마)
 * ================================================================
 * 2026-04-21 마이그레이션: slotKey 기준 → patientId + admissionKey 기준
 *
 * 구 스키마 (2026-04-21 이전):
 *   treatmentPlans/{slotKey}/{YYYY-MM}/{day}  = [{id, qty, emr?, room?}, ...]
 *   weeklyPlans/{slotKey}                     = {itemId: {count, price}}
 *   admissionPlans/{slotKey}                  = {itemId: {count, price}}
 *
 * 신 스키마:
 *   treatmentPlansV2/{patientId}/{admissionKey}/{YYYY-MM}/{day}
 *   weeklyPlansV2/{patientId}/{admissionKey}
 *   admissionPlansV2/{patientId}/{admissionKey}
 *
 * admissionKey = admitDate를 YYYY-MM-DD로 정규화한 값.
 *   재입원 시 각 에피소드별로 plan이 분리됨. 이전 입원 plan이 새 입원에 섞이지 않음.
 *
 * 환자 이동 시: slotKey만 바뀌고 patientId·admitDate 동일하므로 plan 그대로 따라옴.
 * 같은 slot에 다른 환자 입원 시: 전혀 다른 경로이므로 섞이지 않음.
 * ================================================================
 */

export function admissionKey(admitDate) {
  if (!admitDate) return null;
  const s = String(admitDate).trim();

  // ISO YYYY-MM-DD 또는 YYYY-MM-DDTHH...
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // M/D — 현재 연도로 보간
  const md = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (md) {
    const y = new Date().getFullYear();
    return `${y}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
  }

  return null;
}

/**
 * 환자의 치료 계획 3종 경로 생성.
 * patientId 또는 admitDate가 없으면 null 반환 (호출자가 empty state 표시).
 */
export function planPaths(patientId, admitDate) {
  if (!patientId) return null;
  const aKey = admissionKey(admitDate);
  if (!aKey) return null;
  return {
    daily:     `treatmentPlansV2/${patientId}/${aKey}`,
    weekly:    `weeklyPlansV2/${patientId}/${aKey}`,
    admission: `admissionPlansV2/${patientId}/${aKey}`,
    patientId,
    admissionKey: aKey,
  };
}
