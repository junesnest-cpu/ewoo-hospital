package com.ewoo.calldetector

import android.content.ContentProviderOperation
import android.content.Context
import android.provider.ContactsContract
import android.util.Log

/**
 * Firebase 환자 데이터 → 폰 주소록 동기화.
 *
 * 전략: 단순 wipe+insert.
 *   - "이우병원" Account 의 모든 Contact RawContact 삭제
 *   - patients-sync 결과를 새로 insert
 *   - 환자 수 ~수백 규모라 충분히 빠름 (수 초 이내)
 *
 * Account 등록은 AccountAuthenticator 없이 implicit 사용 — Android 가 알아서 별도 그룹으로 분리.
 * 폰 표시 이름: "이름 나이 진단명 (병원)" 형식 — 가능한 항목만 결합
 */
object ContactsSync {
    private const val TAG = "EwooContactsSync"
    const val ACCOUNT_TYPE = "com.ewoo.hospital"
    const val ACCOUNT_NAME = "이우병원"

    fun syncAll(ctx: Context, patients: List<Api.Patient>): Int {
        val resolver = ctx.contentResolver
        // 1) 기존 이우병원 Account RawContact 모두 삭제
        try {
            val deleted = resolver.delete(
                ContactsContract.RawContacts.CONTENT_URI.buildUpon()
                    .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
                    .build(),
                "${ContactsContract.RawContacts.ACCOUNT_TYPE}=? AND ${ContactsContract.RawContacts.ACCOUNT_NAME}=?",
                arrayOf(ACCOUNT_TYPE, ACCOUNT_NAME),
            )
            Log.i(TAG, "기존 RawContact 삭제: $deleted")
        } catch (e: Exception) {
            Log.w(TAG, "기존 삭제 실패: ${e.message}")
        }

        if (patients.isEmpty()) return 0

        // 2) Batch 로 insert (성능)
        val ops = ArrayList<ContentProviderOperation>()
        var inserted = 0
        for (p in patients) {
            if (p.phone.isBlank()) continue
            val displayName = buildDisplayName(p)
            if (displayName.isBlank()) continue

            val rawContactIdx = ops.size
            ops.add(
                ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                    .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, ACCOUNT_TYPE)
                    .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, ACCOUNT_NAME)
                    .build()
            )
            // StructuredName
            ops.add(
                ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawContactIdx)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, displayName)
                    .build()
            )
            // Phone
            ops.add(
                ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                    .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawContactIdx)
                    .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                    .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, p.phone)
                    .withValue(ContactsContract.CommonDataKinds.Phone.TYPE, ContactsContract.CommonDataKinds.Phone.TYPE_MOBILE)
                    .build()
            )
            // Notes — 차트번호·전체 정보
            val notes = buildNotes(p)
            if (notes.isNotBlank()) {
                ops.add(
                    ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                        .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawContactIdx)
                        .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Note.CONTENT_ITEM_TYPE)
                        .withValue(ContactsContract.CommonDataKinds.Note.NOTE, notes)
                        .build()
                )
            }
            inserted++
            // 200건 단위로 batch flush (provider 한도 회피)
            if (ops.size >= 400) {
                applyBatch(ctx, ops)
                ops.clear()
            }
        }
        if (ops.isNotEmpty()) applyBatch(ctx, ops)
        Log.i(TAG, "동기화 완료: $inserted 건 insert")
        return inserted
    }

    private fun applyBatch(ctx: Context, ops: ArrayList<ContentProviderOperation>) {
        try {
            ctx.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
        } catch (e: Exception) {
            Log.w(TAG, "applyBatch 실패: ${e.message}")
        }
    }

    private fun buildDisplayName(p: Api.Patient): String {
        val parts = ArrayList<String>(4)
        if (p.name.isNotBlank()) parts.add(p.name)
        p.age?.let { parts.add("$it") }
        if (p.diagnosis.isNotBlank()) parts.add(p.diagnosis)
        val base = parts.joinToString(" ")
        return if (p.hospital.isNotBlank()) "$base (${p.hospital})" else base
    }

    private fun buildNotes(p: Api.Patient): String {
        val lines = ArrayList<String>(4)
        if (p.chartNo.isNotBlank()) lines.add("차트: ${p.chartNo}")
        if (p.diagnosis.isNotBlank()) lines.add("진단: ${p.diagnosis}")
        if (p.hospital.isNotBlank()) lines.add("병원: ${p.hospital}")
        if (p.age != null) lines.add("나이: ${p.age}세")
        return lines.joinToString("\n")
    }
}
