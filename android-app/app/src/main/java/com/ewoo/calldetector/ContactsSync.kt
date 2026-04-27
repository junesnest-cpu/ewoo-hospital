package com.ewoo.calldetector

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentProviderOperation
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.provider.ContactsContract
import android.util.Log

/**
 * Firebase 환자 데이터 → 폰 주소록 동기화.
 *
 * 전략: 단순 wipe+insert. ensureAccount → DELETE → batched INSERT.
 *
 * Account 등록은 EwooAuthenticator(Service) 통해 정식 등록 — phantom Account 면 표준
 * 연락처 앱에서 "그룹 지정없음" 으로 흩어지거나 안 보일 수 있어 (2026-04-27 핫픽스).
 * 폰 표시 이름: "이름 나이 진단명 (병원)" 형식 — 가능한 항목만 결합
 */
object ContactsSync {
    private const val TAG = "EwooContactsSync"
    const val ACCOUNT_TYPE = "com.ewoo.hospital"
    const val ACCOUNT_NAME = "이우병원"
    private const val GROUP_TITLE = "이우병원"

    fun syncAll(ctx: Context, patients: List<Api.Patient>): Int {
        val resolver = ctx.contentResolver
        // 0) "이우병원" Account + Group 등록 보장.
        //    Account 만으론 Samsung 연락처 앱의 "그룹" 보기에서 안 보임 — Groups 행 + 각
        //    RawContact 의 GroupMembership Data 행 둘 다 필요.
        ensureAccount(ctx, resolver)
        val groupId = ensureGroup(resolver)
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
            // GroupMembership — "이우병원" 그룹에 묶이도록. groupId<=0 이면 (생성 실패) skip.
            if (groupId > 0) {
                ops.add(
                    ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
                        .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, rawContactIdx)
                        .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.GroupMembership.CONTENT_ITEM_TYPE)
                        .withValue(ContactsContract.CommonDataKinds.GroupMembership.GROUP_ROW_ID, groupId)
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

    private fun ensureAccount(ctx: Context, resolver: ContentResolver) {
        val am = AccountManager.get(ctx)
        val account = Account(ACCOUNT_NAME, ACCOUNT_TYPE)
        val existed = am.getAccountsByType(ACCOUNT_TYPE).any { it.name == ACCOUNT_NAME }
        if (!existed) {
            try {
                val ok = am.addAccountExplicitly(account, null, null)
                Log.i(TAG, "Account 신규 등록: ok=$ok")
            } catch (e: SecurityException) {
                Log.w(TAG, "Account 등록 실패 (권한): ${e.message}")
            }
        }
        // ContactsContract.Settings — ungrouped_visible=1 로 표준 연락처 앱에서 항상 보이게
        // (앱이 group 미사용해도 기본 표시)
        try {
            val values = ContentValues().apply {
                put(ContactsContract.Settings.ACCOUNT_NAME, ACCOUNT_NAME)
                put(ContactsContract.Settings.ACCOUNT_TYPE, ACCOUNT_TYPE)
                put(ContactsContract.Settings.UNGROUPED_VISIBLE, 1)
                put(ContactsContract.Settings.SHOULD_SYNC, 1)
            }
            resolver.insert(
                ContactsContract.Settings.CONTENT_URI.buildUpon()
                    .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
                    .build(),
                values,
            )
        } catch (e: Exception) {
            // 이미 행이 있으면 insert 가 실패할 수 있음 (ContactsContract.Settings 는 update 권장).
            // 무시해도 첫 등록 시점에 만들어졌으면 충분.
            Log.d(TAG, "Settings insert skipped: ${e.message}")
        }
    }

    /**
     * "이우병원" Group 행 보장 후 _ID 반환. 이미 있으면 기존 _ID, 없으면 신규 insert.
     * 실패 시 -1 반환 (호출 측에서 GroupMembership 추가 skip).
     */
    private fun ensureGroup(resolver: ContentResolver): Long {
        try {
            resolver.query(
                ContactsContract.Groups.CONTENT_URI,
                arrayOf(ContactsContract.Groups._ID),
                "${ContactsContract.Groups.ACCOUNT_TYPE}=? AND ${ContactsContract.Groups.ACCOUNT_NAME}=? AND ${ContactsContract.Groups.TITLE}=?",
                arrayOf(ACCOUNT_TYPE, ACCOUNT_NAME, GROUP_TITLE),
                null,
            )?.use { c ->
                if (c.moveToFirst()) return c.getLong(0)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Group 조회 실패: ${e.message}")
        }
        return try {
            val values = ContentValues().apply {
                put(ContactsContract.Groups.ACCOUNT_TYPE, ACCOUNT_TYPE)
                put(ContactsContract.Groups.ACCOUNT_NAME, ACCOUNT_NAME)
                put(ContactsContract.Groups.TITLE, GROUP_TITLE)
                put(ContactsContract.Groups.GROUP_VISIBLE, 1)
            }
            val uri = resolver.insert(
                ContactsContract.Groups.CONTENT_URI.buildUpon()
                    .appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
                    .build(),
                values,
            )
            val id = uri?.lastPathSegment?.toLongOrNull() ?: -1L
            Log.i(TAG, "Group 신규 등록: id=$id")
            id
        } catch (e: Exception) {
            Log.w(TAG, "Group 등록 실패: ${e.message}")
            -1L
        }
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
