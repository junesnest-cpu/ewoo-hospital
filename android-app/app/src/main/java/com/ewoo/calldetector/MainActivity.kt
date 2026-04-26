package com.ewoo.calldetector

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.text.format.DateFormat
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.util.Date

/**
 * 단일 화면 설정 + 권한 부여 + 수동 동기화 UI.
 * 코드만으로 layout 구성 (xml 최소화 — 빌드 단순).
 */
class MainActivity : AppCompatActivity() {
    private lateinit var statusView: TextView
    private lateinit var lastSyncView: TextView

    private val requiredPerms = arrayOf(
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.READ_CALL_LOG,
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.WRITE_CONTACTS,
    )

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val granted = result.values.all { it }
        if (granted) {
            Toast.makeText(this, "권한 부여 완료", Toast.LENGTH_SHORT).show()
            SyncScheduler.schedulePeriodic(this)
        } else {
            Toast.makeText(this, "일부 권한 거부됨 — 설정에서 직접 허용 필요", Toast.LENGTH_LONG).show()
        }
        refreshStatus()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "이우 전화 감지기"

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
        }

        // 베이스 URL
        val urlLbl = TextView(this).apply { text = "백엔드 URL"; textSize = 13f }
        val urlInput = EditText(this).apply {
            setText(Prefs.baseUrl(this@MainActivity))
            hint = "https://ewoo-hospital.vercel.app"
        }
        // 시크릿
        val secLbl = TextView(this).apply { text = "공유 시크릿 (관리자에게 받음)"; textSize = 13f; setPadding(0, 24, 0, 0) }
        val secInput = EditText(this).apply {
            setText(Prefs.secret(this@MainActivity))
            hint = "시크릿 키 붙여넣기"
        }

        val saveBtn = Button(this).apply {
            text = "설정 저장"
            setOnClickListener {
                Prefs.setBaseUrl(this@MainActivity, urlInput.text.toString())
                Prefs.setSecret(this@MainActivity, secInput.text.toString())
                Toast.makeText(this@MainActivity, "저장됨", Toast.LENGTH_SHORT).show()
                refreshStatus()
            }
        }

        val permBtn = Button(this).apply {
            text = "권한 요청"
            setOnClickListener { permLauncher.launch(requiredPerms) }
        }

        val syncBtn = Button(this).apply {
            text = "지금 환자 동기화"
            setOnClickListener {
                if (Prefs.secret(this@MainActivity).isBlank()) {
                    Toast.makeText(this@MainActivity, "시크릿을 먼저 입력하세요", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                SyncScheduler.runOnce(this@MainActivity)
                Toast.makeText(this@MainActivity, "동기화 요청됨 (잠시 후 반영)", Toast.LENGTH_SHORT).show()
            }
        }

        statusView = TextView(this).apply {
            textSize = 13f
            setPadding(0, 32, 0, 0)
            gravity = Gravity.START
        }
        lastSyncView = TextView(this).apply {
            textSize = 12f
            setPadding(0, 8, 0, 0)
        }

        listOf(urlLbl, urlInput, secLbl, secInput, saveBtn, permBtn, syncBtn, statusView, lastSyncView)
            .forEach { root.addView(it) }
        setContentView(root)

        SyncScheduler.schedulePeriodic(this)
        refreshStatus()
    }

    override fun onResume() { super.onResume(); refreshStatus() }

    private fun refreshStatus() {
        val perms = requiredPerms.joinToString("\n") { p ->
            val ok = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
            "${if (ok) "✓" else "✗"} ${p.substringAfterLast(".")}"
        }
        val secretSet = Prefs.secret(this).isNotBlank()
        statusView.text = "권한 상태:\n$perms\n\n시크릿: ${if (secretSet) "설정됨" else "미설정"}"
        val ts = Prefs.lastSync(this)
        lastSyncView.text = if (ts > 0)
            "최근 동기화: ${DateFormat.format("yyyy-MM-dd HH:mm:ss", Date(ts))}"
        else "최근 동기화: (아직 없음)"
    }
}
