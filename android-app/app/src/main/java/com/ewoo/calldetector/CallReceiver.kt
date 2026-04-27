package com.ewoo.calldetector

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.telephony.TelephonyManager
import android.util.Log
import android.widget.Toast
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.launch

/**
 * 전화 RINGING 감지 → 잠시 후(500ms) CallLog 에서 가장 최근 INCOMING 항목 조회 → 백엔드 POST.
 *
 * Android 10+ 에서는 EXTRA_INCOMING_NUMBER 가 사라져 CallLog 우회가 표준.
 * READ_CALL_LOG 권한 필요. RINGING 후 매우 짧은 시간 (~수백 ms) 내에 CallLog 에 기록됨.
 */
class CallReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "EwooCallReceiver"
        private var lastReportedNumber: String? = null
        private var lastReportedAt: Long = 0
    }

    override fun onReceive(context: Context, intent: Intent) {
        val appCtx = try { context.applicationContext } catch (e: Throwable) { context }
        try {
            val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: "(null)"
            safeToast(appCtx, "1/ state=$state")

            if (intent.action != "android.intent.action.PHONE_STATE") return
            if (state != TelephonyManager.EXTRA_STATE_RINGING) {
                safeToast(appCtx, "2/ not RINGING")
                return
            }
            safeToast(appCtx, "3/ RINGING")

            if (!hasPerm(appCtx, Manifest.permission.READ_CALL_LOG)) {
                safeToast(appCtx, "4/ NO perm")
                return
            }
            safeToast(appCtx, "4/ perm ok")

            // goAsync — receiver 수명 연장 (최대 ~10초). postDelayed/coroutine 이 안전하게 완료.
            val pending = goAsync()
            GlobalScope.launch(Dispatchers.IO) {
                try {
                    kotlinx.coroutines.delay(600)
                    val phone = readLatestIncomingNumber(appCtx)
                    if (phone.isNullOrBlank()) {
                        toastOnMain(appCtx, "5/ CallLog empty")
                        return@launch
                    }
                    val digits = phone.replace(Regex("\\D"), "")
                    if (digits.isBlank()) {
                        toastOnMain(appCtx, "5/ digits empty")
                        return@launch
                    }
                    toastOnMain(appCtx, "5/ phone=$digits")

                    val now = System.currentTimeMillis()
                    if (lastReportedNumber == digits && now - lastReportedAt < 5_000) {
                        toastOnMain(appCtx, "6/ dedup")
                        return@launch
                    }
                    lastReportedNumber = digits
                    lastReportedAt = now

                    toastOnMain(appCtx, "6/ POST")
                    val ok = try { Api.postIncomingCall(appCtx, digits) } catch (e: Throwable) {
                        toastOnMain(appCtx, "ERR post: ${e.javaClass.simpleName}: ${e.message?.take(40)}")
                        false
                    }
                    toastOnMain(appCtx, if (ok) "7/ OK ✅" else "7/ POST fail ❌")
                } catch (e: Throwable) {
                    toastOnMain(appCtx, "ERR async: ${e.javaClass.simpleName}: ${e.message?.take(40)}")
                } finally {
                    try { pending.finish() } catch (_: Throwable) {}
                }
            }
        } catch (e: Throwable) {
            safeToast(appCtx, "ERR onReceive: ${e.javaClass.simpleName}: ${e.message?.take(40)}")
        }
    }

    private fun safeToast(ctx: Context, msg: String) {
        try {
            Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()
        } catch (e: Throwable) {
            Log.w(TAG, "Toast 실패: ${e.message} (msg=$msg)")
        }
    }

    private fun toastOnMain(ctx: Context, msg: String) {
        Handler(Looper.getMainLooper()).post { safeToast(ctx, msg) }
    }

    private fun hasPerm(ctx: Context, perm: String): Boolean =
        ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED

    private fun readLatestIncomingNumber(ctx: Context): String? {
        val cur = ctx.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE),
            "${CallLog.Calls.TYPE}=?",
            arrayOf(CallLog.Calls.INCOMING_TYPE.toString()),
            "${CallLog.Calls.DATE} DESC LIMIT 1"
        ) ?: return null
        cur.use {
            if (it.moveToFirst()) {
                val numIdx = it.getColumnIndex(CallLog.Calls.NUMBER)
                if (numIdx >= 0) return it.getString(numIdx)
            }
        }
        return null
    }
}
