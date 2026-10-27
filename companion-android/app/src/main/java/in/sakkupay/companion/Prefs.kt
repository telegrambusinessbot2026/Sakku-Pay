package `in`.sakkupay.companion

import android.content.Context

object Prefs {
    private const val PREF_NAME = "sakkupay_companion"
    private const val KEY_URL = "server_url"
    private const val KEY_MERCHANT = "merchant_id"
    private const val KEY_API_KEY = "api_key"
    private const val KEY_ALLOW_ALL = "allow_all_apps"

    fun serverUrl(c: Context): String =
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getString(KEY_URL, "") ?: ""

    fun merchantId(c: Context): String =
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getString(KEY_MERCHANT, "") ?: ""

    fun apiKey(c: Context): String =
        c.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getString(KEY_API_KEY, "") ?: ""

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
}
