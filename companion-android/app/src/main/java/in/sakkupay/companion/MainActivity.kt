package `in`.sakkupay.companion

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.*
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var statusText: TextView

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 56, 48, 40)
        }

        // Header Title
        val title = TextView(this).apply {
            text = "SakkuPay Companion"
            textSize = 22f
            paint.isFakeBoldText = true
            setPadding(0, 0, 0, 8)
        }
        val subtitle = TextView(this).apply {
            text = "Automated UPI payment verification service. Detects incoming business payments & bank SMS locally."
            textSize = 13f
            setPadding(0, 0, 0, 24)
        }

        // Permission & Status indicator
        statusText = TextView(this).apply {
            textSize = 14f
            setPadding(0, 0, 0, 20)
        }

        // Input Fields
        val urlInput = EditText(this).apply {
            hint = "Server URL (e.g. https://your-domain.com)"
            setText(Prefs.serverUrl(this@MainActivity))
        }

        val merchantInput = EditText(this).apply {
            hint = "Merchant ID (e.g. mer_1a2b3c)"
            setText(Prefs.merchantId(this@MainActivity))
        }

        val keyInput = EditText(this).apply {
            hint = "Companion API Key (sk_live_...)"
            setText(Prefs.apiKey(this@MainActivity))
        }

        val allowAllCheck = CheckBox(this).apply {
            text = "Parse notifications from all apps (fallback)"
            isChecked = Prefs.allowAllApps(this@MainActivity)
        }

        // Save Button
        val saveBtn = Button(this).apply {
            text = "Save Configuration"
            setOnClickListener {
                Prefs.save(
                    this@MainActivity,
                    urlInput.text.toString(),
                    merchantInput.text.toString(),
                    keyInput.text.toString(),
                    allowAllCheck.isChecked
                )
                Toast.makeText(this@MainActivity, "Settings saved securely.", Toast.LENGTH_SHORT).show()
                updateStatus()
            }
        }

        // Test Connection Button
        val testBtn = Button(this).apply {
            text = "Test Server Connection"
            setOnClickListener {
                val url = urlInput.text.toString().trim().trimEnd('/')
                val key = keyInput.text.toString().trim()
                if (url.isBlank() || key.isBlank()) {
                    Toast.makeText(this@MainActivity, "Please enter Server URL and API Key first.", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                Toast.makeText(this@MainActivity, "Testing connection…", Toast.LENGTH_SHORT).show()
                worker.execute {
                    testConnection(url, key)
                }
            }
        }

        // Permission Action Button
        val accessBtn = Button(this).apply {
            text = "Open Notification Settings"
            setOnClickListener {
                startActivity(Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"))
            }
        }

        root.addView(title)
        root.addView(subtitle)
        root.addView(statusText)
        root.addView(urlInput)
        root.addView(merchantInput)
        root.addView(keyInput)
        root.addView(allowAllCheck)
        root.addView(saveBtn)
        root.addView(testBtn)
        root.addView(accessBtn)

        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
    }

    private fun isNotificationAccessGranted(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
        return flat != null && flat.contains(packageName)
    }

    private fun updateStatus() {
        val granted = isNotificationAccessGranted()
        val configured = Prefs.serverUrl(this).isNotBlank() && Prefs.apiKey(this).isNotBlank()

        val text = buildString {
            if (granted) {
                append("● Notification Access: GRANTED\n")
            } else {
                append("▲ Notification Access: NEEDED (tap below)\n")
            }
            if (configured) {
                append("● Service Status: Ready & Configured")
            } else {
                append("▲ Service Status: Incomplete credentials")
            }
        }
        statusText.text = text
    }

    private fun testConnection(serverUrl: String, apiKey: String) {
        var conn: HttpURLConnection? = null
        try {
            val endpoint = "$serverUrl/api/v1/webhook/verify-payment"
            val url = URL(endpoint)
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("X-API-Key", apiKey)
                connectTimeout = 8000
                readTimeout = 8000
            }
            val code = conn.responseCode
            val msg = if (code == 200) {
                "✅ Connected successfully to SakkuPay server!"
            } else if (code == 401) {
                "❌ Authentication failed: Invalid API key."
            } else {
                "❌ Server returned HTTP $code."
            }
            mainHandler.post {
                Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
            }
        } catch (e: Exception) {
            mainHandler.post {
                Toast.makeText(this, "❌ Connection error: ${e.localizedMessage ?: "Failed to connect"}", Toast.LENGTH_LONG).show()
            }
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }
}
