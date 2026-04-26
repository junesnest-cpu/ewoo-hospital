package com.ewoo.calldetector

import android.content.Context

object Prefs {
    private const val NAME = "ewoo_call_detector"
    private const val KEY_BASE_URL = "base_url"
    private const val KEY_SECRET = "secret"
    private const val KEY_LAST_SYNC = "last_sync"

    private const val DEFAULT_BASE_URL = "https://ewoo-hospital.vercel.app"

    fun baseUrl(ctx: Context): String =
        prefs(ctx).getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL

    fun setBaseUrl(ctx: Context, v: String) {
        prefs(ctx).edit().putString(KEY_BASE_URL, v.ifBlank { DEFAULT_BASE_URL }).apply()
    }

    fun secret(ctx: Context): String =
        prefs(ctx).getString(KEY_SECRET, "") ?: ""

    fun setSecret(ctx: Context, v: String) {
        prefs(ctx).edit().putString(KEY_SECRET, v.trim()).apply()
    }

    fun lastSync(ctx: Context): Long =
        prefs(ctx).getLong(KEY_LAST_SYNC, 0L)

    fun setLastSync(ctx: Context, v: Long) {
        prefs(ctx).edit().putLong(KEY_LAST_SYNC, v).apply()
    }

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE)
}
