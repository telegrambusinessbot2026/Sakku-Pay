package `in`.sakkupay.companion

data class Payment(
    val amount: Double,
    val utr: String,
    val customerUpi: String?
)

object PaymentParser {
    // Rejection keywords: ignore debits, transfers sent, or withdrawals
    private val debitKeywords = Regex(
        """\b(?:debited|paid\s+to|sent\s+to|transferred\s+to|withdrawn|spent|charged)\b""",
        RegexOption.IGNORE_CASE
    )

    // Credit keywords: must indicate incoming money
    private val creditKeywords = Regex(
        """\b(?:received|credited|deposit(?:ed)?|added|payment\s+from|accepted|credit|cr)\b""",
        RegexOption.IGNORE_CASE
    )

    // Amount regex: ₹ 100, Rs. 100.50, INR 1,250.00, or 100.00 INR
    private val amountRegex = Regex(
        """(?:₹|Rs\.?|INR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:₹|Rs\.?|INR)""",
        RegexOption.IGNORE_CASE
    )

    // UTR / Reference patterns
    private val utrPatterns = listOf(
        // Bank SMS UPI slash format: UPI/429612345678 or UPI/CR/429612345678
        Regex("""\bUPI/(?:CR/)?([A-Za-z0-9]{6,})""", RegexOption.IGNORE_CASE),
        // UTR: 429612345678, UTR No: 429612345678, UTR-429612345678
        Regex("""\bUTR(?:\s*No\.?)?\s*[:#-]?\s*([A-Za-z0-9]{6,})""", RegexOption.IGNORE_CASE),
        // UPI Ref no: 429612345678, UPI Reference: 429612345678, UPI Txn ID: 429612345678
        Regex("""\bUPI\s*(?:Ref(?:erence)?|Txn|Transaction)?\s*(?:ID|No\.?|Num)?\s*[:#-]?\s*([A-Za-z0-9]{6,})""", RegexOption.IGNORE_CASE),
        // Txn ID: T241026..., Transaction ID: ...
        Regex("""\b(?:Txn|Transaction)\s*(?:ID|Ref(?:erence)?|No\.?)?\s*[:#-]?\s*([A-Za-z0-9]{6,})""", RegexOption.IGNORE_CASE),
        // Ref no: 429612345678, Ref: 429612345678
        Regex("""\bRef(?:\s*No\.?)?\s*[:#-]?\s*([A-Za-z0-9]{6,})""", RegexOption.IGNORE_CASE)
    )

    // Customer UPI ID pattern (e.g., user@okhdfcbank, buyer@ybl)
    private val upiRegex = Regex("""\b([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)\b""")

    fun parse(text: String): Payment? {
        if (text.isBlank()) return null

        // 1. If notification indicates money sent/debited, reject immediately
        if (debitKeywords.containsMatchIn(text)) return null

        // 2. Must contain credit indicator
        if (!creditKeywords.containsMatchIn(text)) return null

        // 3. Extract amount
        val amtMatch = amountRegex.find(text) ?: return null
        val amtStr = (amtMatch.groups[1]?.value ?: amtMatch.groups[2]?.value)?.replace(",", "") ?: return null
        val amount = amtStr.toDoubleOrNull() ?: return null
        if (amount <= 0.0) return null

        // 4. Extract UTR / Reference
        var utr: String? = null
        for (pattern in utrPatterns) {
            val match = pattern.find(text)
            if (match != null) {
                val candidate = match.groupValues[1].trim()
                if (candidate.length >= 6 && !candidate.equals("account", true) && !candidate.equals("transfer", true)) {
                    utr = candidate
                    break
                }
            }
        }
        if (utr == null) return null

        // 5. Extract customer UPI ID if available
        val customerUpi = upiRegex.find(text)?.groupValues?.get(1)?.trim()

        return Payment(amount, utr, customerUpi)
    }
}
