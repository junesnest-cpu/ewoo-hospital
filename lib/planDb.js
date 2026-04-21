/**
 * 치료 계획 DB 접근 헬퍼 (slot → patient 해결 자동 처리)
 * ================================================================
 * 역할: slotKey만 알고 있는 호출자가 기존처럼 쓸 수 있도록 새 스키마로 변환.
 * 내부적으로 slots/{slotKey}/current에서 patientId + admitDate 조회 후
 * planPaths()로 신 경로 구성하여 읽기·쓰기.
 *
 * 환자·입원일 미해결 시 get* 함수는 {}, set* 함수는 예외 throw.
 * ================================================================
 */
import { ref, get, set } from 'firebase/database';
import { db } from './firebaseConfig';
import { planPaths } from './planPaths';

async function resolveFromSlot(slotKey) {
  const snap = await get(ref(db, `slots/${slotKey}`));
  const cur  = snap.val()?.current;
  return planPaths(cur?.patientId, cur?.admitDate);
}

export async function getPlanBySlot(slotKey) {
  const p = await resolveFromSlot(slotKey);
  if (!p) return {};
  const snap = await get(ref(db, p.daily));
  return snap.val() || {};
}

export async function setPlanBySlot(slotKey, newPlan) {
  const p = await resolveFromSlot(slotKey);
  if (!p) throw new Error(`plan save failed — slotKey=${slotKey} has no patientId+admitDate`);
  await set(ref(db, p.daily), newPlan);
}

export async function getWeeklyPlanBySlot(slotKey) {
  const p = await resolveFromSlot(slotKey);
  if (!p) return {};
  const snap = await get(ref(db, p.weekly));
  return snap.val() || {};
}

export async function setWeeklyPlanBySlot(slotKey, newPlan) {
  const p = await resolveFromSlot(slotKey);
  if (!p) throw new Error(`weekly plan save failed — slotKey=${slotKey} has no patientId+admitDate`);
  await set(ref(db, p.weekly), newPlan);
}
