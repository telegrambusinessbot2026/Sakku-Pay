package `in`.sakkupay.companion

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var statusText: TextView
    private lateinit var appCodeDisplay: TextView
    private lateinit var appCodeCard: LinearLayout

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)

        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 48, 40, 40)
        }

        // Header Title
        val title = TextView(this).apply {
            text = getString(R.string.app_name)
            textSize = 22f
            paint.isFakeBoldText = true
            setPadding(0, 0, 0, 4)
        }
        val subtitle = TextView(this).apply {
            text = "Official merchant cashier pairing & automated UPI verification service."
            textSize = 13f
            setPadding(0, 0, 0, 20)
        }

        // Status Card
        statusText = TextView(this).apply {
            textSize = 13.5f
            setPadding(24, 24, 24, 24)
            setBackgroundColor(0xFF1E293B.toInt())
            setTextColor(0xFFE2E8F0.toInt())
        }

        // ── SECTION: PAIR CASHIER (TWO-STAGE PROTOCOL) ────────────────────────
        val pairHeading = TextView(this).apply {
            text = "Step 1: Pair with Server Code"
            textSize = 16f
            paint.isFakeBoldText = true
            setPadding(0, 24, 0, 6)
        }

        val pairDesc = TextView(this).apply {
            text = "Enter the 12-digit Server Code generated in your SakkuPay Merchant Dashboard (Collect Apps → Connect by App)."
            textSize = 12.5f
            setPadding(0, 0, 0, 12)
        }

        val serverUrlInput = EditText(this).apply {
            hint = "Server URL (default: https://sakkupay.onrender.com)"
            val existing = Prefs.serverUrl(this@MainActivity)
            setText(if (existing.isNotBlank()) existing else "https://sakkupay.onrender.com")
        }

        val serverCodeInput = EditText(this).apply {
            hint = "12-Digit Server Code (e.g. 8492 1048 3920)"
            textSize = 17f
            paint.isFakeBoldText = true
        }

        // Auto format 12 digits into 3 groups of 4: XXXX XXXX XXXX
        serverCodeInput.addTextChangedListener(object : TextWatcher {
            var formatting = false
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                if (formatting || s == null) return
                formatting = true
                val digitsOnly = s.toString().replace("[^0-9]".toRegex(), "").take(12)
                val formatted = digitsOnly.chunked(4).joinToString(" ")
                s.replace(0, s.length, formatted)
                formatting = false
            }
        })

        val pairBtn = Button(this).apply {
            text = "Check & Pair Cashier"
            setOnClickListener {
                val url = serverUrlInput.text.toString().trim().trimEnd('/')
                val rawCode = serverCodeInput.text.toString().replace("[^0-9]".toRegex(), "")
                if (url.isBlank()) {
                    Toast.makeText(this@MainActivity, "Server URL is required.", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                if (rawCode.length != 12) {
                    Toast.makeText(this@MainActivity, "Please enter all 12 digits of the Server Code.", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }

                Toast.makeText(this@MainActivity, "Verifying Server Code with SakkuPay…", Toast.LENGTH_SHORT).show()
                worker.execute {
                    verifyServerCode(url, rawCode)
                }
            }
        }

        // App Code Result Card (Step 2)
        appCodeCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 24, 24, 24)
            setBackgroundColor(0xFF0F172A.toInt())
            visibility = View.GONE
        }

        val appCodeTitle = TextView(this).apply {
            text = "Step 2: Enter App Code in Dashboard"
            textSize = 15f
            paint.isFakeBoldText = true
            setTextColor(0xFF38BDF8.toInt())
            setPadding(0, 0, 0, 4)
        }

        val appCodeSub = TextView(this).apply {
            text = "Server Code verified! Enter this single-use 6-digit App Code in your merchant dashboard to activate cashier:"
            textSize = 12.5f
            setTextColor(0xFF94A3B8.toInt())
            setPadding(0, 0, 0, 10)
        }

        appCodeDisplay = TextView(this).apply {
            text = "—"
            textSize = 28f
            paint.isFakeBoldText = true
            setTextColor(0xFF34D399.toInt())
            textAlignment = View.TEXT_ALIGNMENT_CENTER
            setPadding(0, 10, 0, 10)
        }

        appCodeCard.addView(appCodeTitle)
        appCodeCard.addView(appCodeSub)
        appCodeCard.addView(appCodeDisplay)

        // Notification Settings Button
        val accessBtn = Button(this).apply {
            text = "Open Notification Access Settings"
            setOnClickListener {
                startActivity(Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"))
            }
        }

        // Test Connection Button
        val testBtn = Button(this).apply {
            text = "Test Webhook Verification"
            setOnClickListener {
                val url = Prefs.serverUrl(this@MainActivity)
                val key = Prefs.apiKey(this@MainActivity)
                if (url.isBlank() || key.isBlank()) {
                    Toast.makeText(this@MainActivity, "App is not paired yet. Please pair cashier first.", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                Toast.makeText(this@MainActivity, "Testing connection…", Toast.LENGTH_SHORT).show()
                worker.execute {
                    testConnection(url, key)
                }
            }
        }

        // Populate Views
        root.addView(title)
        root.addView(subtitle)
        root.addView(statusText)
        root.addView(pairHeading)
        root.addView(pairDesc)
        root.addView(serverUrlInput)
        root.addView(serverCodeInput)
        root.addView(pairBtn)
        root.addView(appCodeCard)
        root.addView(accessBtn)
        root.addView(testBtn)

        scroll.addView(root)
        setContentView(scroll)

        // Restore active App Code if previously generated
        val existingAppCode = Prefs.appCode(this)
        if (existingAppCode.isNotBlank()) {
            displayAppCode(existingAppCode)
        }
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
        val merchantName = Prefs.merchantName(this)
        val cashierId = Prefs.cashierId(this)
        val provider = Prefs.provider(this)
        val isPaired = cashierId.isNotBlank() && Prefs.apiKey(this).isNotBlank()

        val text = buildString {
            if (granted) {
                append("● Notification Access: GRANTED\n")
            } else {
                append("▲ Notification Access: NEEDED (tap settings below)\n")
            }
            if (isPaired) {
                append("● Cashier Status: PAIRED & ACTIVE\n")
                append("  Merchant: $merchantName\n")
                append("  Provider: ${provider.uppercase()}\n")
                append("  Cashier ID: $cashierId")
            } else {
                append("▲ Cashier Status: Not paired. Enter 12-digit Server Code below.")
            }
        }
        statusText.text = text
    }

    private fun displayAppCode(code: String) {
        val formatted = if (code.length == 6) "${code.take(3)} ${code.takeLast(3)}" else code
        appCodeDisplay.text = formatted
        appCodeCard.visibility = View.VISIBLE
    }

    private fun verifyServerCode(serverUrl: String, serverCode: String) {
        var conn: HttpURLConnection? = null
        try {
            val endpoint = "$serverUrl/api/cashier/pair-server-code"
            val url = URL(endpoint)
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
                connectTimeout = 10000
                readTimeout = 10000
            }

            val body = JSONObject().apply {
                put("serverCode", serverCode)
                put("deviceModel", "${Build.MANUFACTURER} ${Build.MODEL}")
                put("appVersion", "1.0")
            }.toString()

            conn.outputStream.use { os ->
                os.write(body.toByteArray(Charsets.UTF_8))
            }

            val code = conn.responseCode
            val responseText = if (code in 200..299) {
                conn.inputStream.bufferedReader().use { it.readText() }
            } else {
                conn.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
            }

            if (code == 200) {
                val json = JSONObject(responseText)
                val appCode = json.optString("appCode", "")
                val merchantId = json.optString("merchantId", "")
                val merchantName = json.optString("merchantName", "SakkuPay Merchant")
                val cashierId = json.optString("cashierId", "")
                val provider = json.optString("provider", "phonepe")
                val cashierApiKey = json.optString("cashierApiKey", "")

                Prefs.savePairing(
                    this@MainActivity,
                    serverUrl,
                    merchantId,
                    merchantName,
                    cashierId,
                    provider,
                    cashierApiKey,
                    appCode
                )

                mainHandler.post {
                    displayAppCode(appCode)
                    updateStatus()
                    Toast.makeText(this@MainActivity, "✅ Server Code accepted! App Code generated.", Toast.LENGTH_LONG).show()
                }
            } else {
                val errorMsg = try {
                    JSONObject(responseText).optString("error", "Server returned HTTP $code")
                } catch (_: Exception) {
                    "Pairing failed with HTTP $code"
                }
                mainHandler.post {
                    Toast.makeText(this@MainActivity, "❌ $errorMsg", Toast.LENGTH_LONG).show()
                }
            }
        } catch (e: Exception) {
            mainHandler.post {
                Toast.makeText(this@MainActivity, "❌ Connection error: ${e.localizedMessage ?: "Failed to connect"}", Toast.LENGTH_LONG).show()
            }
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
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
                "❌ Authentication failed: Invalid cashier API key."
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
