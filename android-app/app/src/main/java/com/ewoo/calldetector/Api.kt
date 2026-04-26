package com.ewoo.calldetector

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object Api {
    private const val TAG = "EwooApi"

    data class Patient(
        val phone: String,
        val name: String,
        val age: Int?,
        val diagnosis: String,
        val hospital: String,
        val chartNo: String,
    )

    /** Android 앱 → /api/incoming-call 호출 */
    fun postIncomingCall(ctx: Context, phoneDigits: String): Boolean {
        val baseUrl = Prefs.baseUrl(ctx)
        val secret = Prefs.secret(ctx)
        if (secret.isBlank()) {
            Log.w(TAG, "secret missing — settings 화면에서 입력 필요")
            return false
        }
        val url = URL("$baseUrl/api/incoming-call")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 5000
            readTimeout = 7000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("X-Incoming-Secret", secret)
        }
        return try {
            val body = JSONObject().put("phone", phoneDigits).toString()
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code in 200..299) {
                Log.i(TAG, "incoming-call posted: $phoneDigits ($code)")
                true
            } else {
                val err = conn.errorStream?.bufferedReader()?.readText() ?: ""
                Log.w(TAG, "incoming-call failed ($code): $err")
                false
            }
        } catch (e: Exception) {
            Log.e(TAG, "incoming-call exception: ${e.message}")
            false
        } finally {
            conn.disconnect()
        }
    }

    /** /api/patients-sync → 환자 리스트 */
    fun fetchPatients(ctx: Context): List<Patient>? {
        val baseUrl = Prefs.baseUrl(ctx)
        val secret = Prefs.secret(ctx)
        if (secret.isBlank()) return null
        val url = URL("$baseUrl/api/patients-sync")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 7000
            readTimeout = 30000
            setRequestProperty("X-Incoming-Secret", secret)
        }
        return try {
            val code = conn.responseCode
            if (code !in 200..299) {
                Log.w(TAG, "patients-sync failed: $code")
                return null
            }
            val text = conn.inputStream.bufferedReader().readText()
            val json = JSONObject(text)
            val arr: JSONArray = json.optJSONArray("patients") ?: JSONArray()
            val out = ArrayList<Patient>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                out.add(Patient(
                    phone = o.optString("phone", ""),
                    name = o.optString("name", ""),
                    age = if (o.isNull("age")) null else o.optInt("age", 0).takeIf { it > 0 },
                    diagnosis = o.optString("diagnosis", ""),
                    hospital = o.optString("hospital", ""),
                    chartNo = o.optString("chartNo", ""),
                ))
            }
            Log.i(TAG, "patients-sync ok: ${out.size}")
            out
        } catch (e: Exception) {
            Log.e(TAG, "patients-sync exception: ${e.message}")
            null
        } finally {
            conn.disconnect()
        }
    }
}
