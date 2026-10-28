package `in`.sakkupay.companion

import android.content.Context

object Prefs {
    private const val PREF_NAME = "sakkupay_companion"
    private const val KEY_URL = "server_url"
    private const val KEY_MERCHANT = "merchant_id"
    private const val KEY_MERCHANT_NAME = "merchant_name"
    private const val KEY_CASHIER_ID = "cashier_id"
    private const val KEY_PROVIDER = "provider"
    private const val KEY_API_KEY = "api_key"
    private const val KEY_APP_CODE = "app_code"
    private const val KEY_ALLOW_ALL = "allow_all_apps"

    fun serverUrl(c: Context): String =
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getString(KEY_URL, "") ?: ""

    fun merchantId(c: Context): String =
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getString(KEY_MERCHANT, "") ?: ""

    fun merchantName(c: Context): String =
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getString(KEY_MERCHANT_NAME, "") ?: ""

    fun cashierId(c: Context): String =
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getString(KEY_CASHIER_ID, "") ?: ""

    fun provider(c: Context): String =
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getString(KEY_PROVIDER, "phonepe") ?: "phonepe"

    fun apiKey(c: Context): String =
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getString(KEY_API_KEY, "") ?: ""

    fun appCode(c: Context): String =
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getString(KEY_APP_CODE, "") ?: ""

    fun allowAllApps(c: Context): Boolean =
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getBoolean(KEY_ALLOW_ALL, false)

    fun save(c: Context, url: String, merchantId: String, apiKey: String, allowAll: Boolean = false) {
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).edit()
            .putString(KEY_URL, url.trim().trimEnd('/'))
            .putString(KEY_MERCHANT, merchantId.trim())
            .putString(KEY_API_KEY, apiKey.trim())
            .putBoolean(KEY_ALLOW_ALL, allowAll)
            .apply()
    }

    fun savePairing(c: Context, url: String, merchantId: String, merchantName: String, cashierId: String, provider: String, apiKey: String, appCode: String) {
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).edit()
            .putString(KEY_URL, url.trim().trimEnd('/'))
            .putString(KEY_MERCHANT, merchantId.trim())
            .putString(KEY_MERCHANT_NAME, merchantName.trim())
            .putString(KEY_CASHIER_ID, cashierId.trim())
            .putString(KEY_PROVIDER, provider.trim())
            .putString(KEY_API_KEY, apiKey.trim())
            .putString(KEY_APP_CODE, appCode.trim())
            .apply()
    }
}
