package com.ewoo.calldetector

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * AccountAuthenticator 노출용 bound service.
 * AndroidManifest 에서 android.accounts.AccountAuthenticator 인텐트로 등록.
 */
class EwooAuthenticatorService : Service() {
    private lateinit var authenticator: EwooAuthenticator

    override fun onCreate() {
        super.onCreate()
        authenticator = EwooAuthenticator(this)
    }

    override fun onBind(intent: Intent?): IBinder? = authenticator.iBinder
}
