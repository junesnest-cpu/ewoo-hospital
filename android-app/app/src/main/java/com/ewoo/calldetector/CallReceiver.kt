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
        // [DEBUG 2026-04-27] 화면이 좁아 상세 잘림 → state 값만 짧게 별도 토스트
        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: "(null)"
        Toast.makeText(context, "1/ state=$state", Toast.LENGTH_LONG).show()

        if (intent.action != "android.intent.action.PHONE_STATE") {
            Toast.makeText(context, "2/ wrong action", Toast.LENGTH_LONG).show()
            return
        }
        if (state != TelephonyManager.EXTRA_STATE_RINGING) {
            Toast.makeText(context, "2/ skip (not RINGING)", Toast.LENGTH_LONG).show()
            return
        }
        Toast.makeText(context, "3/ RINGING ok, perm 체크", Toast.LENGTH_LONG).show()

        if (!hasPerm(context, Manifest.permission.READ_CALL_LOG)) {
            Toast.makeText(context, "4/ NO READ_CALL_LOG", Toast.LENGTH_LONG).show()
            return
        }
        Toast.makeText(context, "4/ perm ok, 600ms 후", Toast.LENGTH_LONG).show()

        val appCtx = context.applicationContext
        Handler(Looper.getMainLooper()).postDelayed({
            try {
                val phone = readLatestIncomingNumber(appCtx)
                if (phone.isNullOrBlank()) {
                    Toast.makeText(appCtx, "5/ CallLog empty", Toast.LENGTH_LONG).show()
                    return@postDelayed
                }
                val digits = phone.replace(Regex("\\D"), "")
                if (digits.isBlank()) {
                    Toast.makeText(appCtx, "5/ digits empty", Toast.LENGTH_LONG).show()
                    return@postDelayed
                }
                Toast.makeText(appCtx, "5/ phone=$digits", Toast.LENGTH_LONG).show()

                val now = System.currentTimeMillis()
                if (lastReportedNumber == digits && now - lastReportedAt < 5_000) {
                    Toast.makeText(appCtx, "6/ dedup skip", Toast.LENGTH_SHORT).show()
                    return@postDelayed
                }
                lastReportedNumber = digits
                lastReportedAt = now

                Toast.makeText(appCtx, "6/ POST start", Toast.LENGTH_LONG).show()
                GlobalScope.launch(Dispatchers.IO) {
                    val ok = try { Api.postIncomingCall(appCtx, digits) } catch (e: Exception) { false }
                    Handler(Looper.getMainLooper()).post {
                        Toast.makeText(appCtx, if (ok) "7/ ok" else "7/ POST fail", Toast.LENGTH_LONG).show()
                    }
                }
            } catch (e: Exception) {
                Toast.makeText(appCtx, "ERR: ${e.message?.take(50)}", Toast.LENGTH_LONG).show()
            }
        }, 600)
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
