package `in`.sakkupay.companion

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.concurrent.Executors

class PaymentNotificationListener : NotificationListenerService() {
    private val worker = Executors.newSingleThreadExecutor()

    private val acceptedPackages = setOf(
        // Google Pay (Business & Personal)
        "com.google.android.apps.nbu.paisa.merchant",
        "com.google.android.apps.nbu.paisa.user",
        // PhonePe (Business & Personal)
        "com.phonepe.app.business",
        "com.phonepe.app",
        // Paytm (Business & Personal)
        "com.paytm.business",
        "net.one97.paytm",
        // BHIM
        "in.org.npci.upiapp",
        // Major SMS apps for Bank Credit SMS notifications
        "com.google.android.apps.messaging",
        "com.samsung.android.messaging",
        "com.android.mms",
        "com.xiaomi.midrop",
        "com.miui.sms",
        "com.oneplus.mms",
        "com.truecaller"
    )

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        val pkg = sbn.packageName ?: return

        // Verify if package is accepted (or merchant enabled allowAllApps)
        if (pkg !in acceptedPackages && !Prefs.allowAllApps(this)) return

        val extras = sbn.notification?.extras ?: return
        val title = extras.getCharSequence("android.title")?.toString() ?: ""
        val text = extras.getCharSequence("android.text")?.toString() ?: ""
        val bigText = extras.getCharSequence("android.bigText")?.toString() ?: ""

        val fullText = "$title $text $bigText".trim()
        val payment = PaymentParser.parse(fullText) ?: return

        val serverUrl = Prefs.serverUrl(this)
        val merchantId = Prefs.merchantId(this)
        val apiKey = Prefs.apiKey(this)

        if (serverUrl.isBlank() || merchantId.isBlank() || apiKey.isBlank()) return

        worker.execute {
            sendPayment(serverUrl, merchantId, apiKey, payment)
        }
    }

    private fun sendPayment(serverUrl: String, merchantId: String, apiKey: String, p: Payment) {
        var conn: HttpURLConnection? = null
        try {
            val endpoint = serverUrl.trimEnd('/') + "/api/v1/webhook/verify-payment"
            val cashierId = Prefs.cashierId(this)
            val body = JSONObject().apply {
                put("merchantId", merchantId.trim())
                if (cashierId.isNotBlank()) put("cashierId", cashierId.trim())
                put("amount", p.amount)
                put("utr", p.utr)
                put("timestamp", Instant.now().toString())
                put("customerUpi", p.customerUpi ?: "")
            }.toString()

            val url = URL(endpoint)
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("X-API-Key", apiKey.trim())
                doOutput = true
                connectTimeout = 10000
                readTimeout = 10000
            }

            conn.outputStream.use { os ->
                os.write(body.toByteArray(Charsets.UTF_8))
            }

            // Trigger request execution and get response code
            val code = conn.responseCode
            // Connection finished successfully
        } catch (_: Exception) {
            // Keep logs clean & never expose sensitive customer payment or SMS data in logcat
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Exception) {}
        }
    }
}
