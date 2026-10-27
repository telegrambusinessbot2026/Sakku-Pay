# SakkuPay - Multi-UPI Payment Gateway & Verification Engine

SakkuPay is a production-ready, full-stack multi-UPI payment gateway, custom payment link generator, and automated payment verification engine built with pure Node.js, standard web technologies, and a native Android Companion background service.

---

## ⚡ Core Features

- **Google Account Authentication:** 1-click merchant sign-in with zero OTP or KYC friction.
- **Multi-UPI Management:** Connect, verify, and manage multiple receiving UPI IDs per merchant with mandatory linked phone numbers and primary default selection.
- **Dynamic Payment Links:** Generate custom slugs for fixed amounts (e.g. ₹499 for products) or open amounts (customer enters amount).
- **Responsive Checkout Page (`/pay/:slug`):**
  - **Dynamic Realistic QR Code:** Scannable in any UPI app with pre-filled amount and recipient details, plus image download.
  - **1-Tap UPI Intent Buttons:** Instant redirects to Google Pay, PhonePe, Paytm, and BHIM (`upi://pay?...`).
  - **Real-Time Payment Status Polling:** Automatically detects confirmation and updates to a verified success state.
- **Dual Automated Payment Verification Engine:**
  - **Direct Business Account Linking:** Connect **PhonePe Business** and **Paytm Business** accounts with encrypted credential vaulting (AES-256-GCM) and direct server-to-server webhook callbacks.
  - **Universal Fallback (Android Companion App):** A lightweight background Android service (`companion-android`) that reads incoming payment alerts from GPay for Business, PhonePe Business, Paytm Business, and Bank SMS (SBI, HDFC, ICICI, etc.) and forwards them securely to the SakkuPay webhook.
- **Real-Time SSE Sync:** Live Server-Sent Events (`transaction.updated`) update the merchant dashboard instantly the second a payment arrives.
- **Developer API & Webhooks:** Generate secret API keys (`sk_live_...`) to programmatically create payment links from external e-commerce stores, websites, or Telegram bots.
- **Restricted Admin Dashboard (`/admin`):**
  - Platform-wide volume, transaction statistics, and active link metrics.
  - User management (search, suspend/unsuspend, delete merchants).
  - Diagnostic error tracking for client-side issues.
  - Admin WhatsApp QR session integration (Baileys) for automated merchant notifications.

---

## 🚀 Quick Start

### 1. Requirements
- **Node.js:** `>= 20.0.0`
- **Android Studio / JDK 17+** *(optional, only needed for compiling the Android companion app)*

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Create a `.env` file from `.env.example`:
```bash
cp .env.example .env
```
Configure your credentials in `.env` (Google OAuth, Session Secret, Vault Secret, Admin password).

### 4. Run the Server
```bash
# Development / Production
npm start
```
The server will start listening at:
- **Home Landing Page:** [http://localhost:3000](http://localhost:3000)
- **Merchant Login Page:** [http://localhost:3000/login](http://localhost:3000/login)
- **User Dashboard:** [http://localhost:3000/dashboard](http://localhost:3000/dashboard)
- **Admin Dashboard:** [http://localhost:3000/admin](http://localhost:3000/admin)

---

## 🛠 Project Structure

```
SakkuPay/
├── server.js               # Pure Node.js backend: REST API, Webhooks, SSE, AES-256 Vault
├── src/                    # Backend modular architecture
│   └── db/
│       ├── connection.js   # SQLite DatabaseSync connection with WAL mode & foreign keys
│       ├── schema.js       # Relational DDL tables, indexes, and constraints
│       ├── migrate.js      # Atomic, transactional JSON-to-SQLite data migrator
│       └── repository.js   # Repository/DAO pattern with prepared statements & integer paise
├── test-milestone1.js      # Automated Security & Payment Verification test suite
├── test-milestone2.js      # Automated SQLite Migration & Repository test suite
├── home.html               # Public Home landing page with features, comparison & Privacy Policy
├── home.css                # Modern responsive styles for the Home landing page
├── login.html              # Dedicated Login page with Google OAuth button & status checks
├── dashboard.html          # User Dashboard for authenticated merchants
├── app-live.js             # Merchant dashboard client logic & state management
├── admin.html              # Restricted Admin Dashboard SPA
├── admin.js                # Admin management, WhatsApp session, error monitoring logic
├── admin.css               # Admin portal styles
├── checkout.html           # Customer payment page template with official branding
├── checkout.js             # Customer checkout logic, QR rendering & live status polling
├── assets/                 # Brand assets
│   ├── logo.svg            # Official vector SVG logo
│   └── logo-icon.svg       # Favicon and icon badge vector
├── data.json               # Legacy JSON store (preserved as rollback backup & sync source)
├── sakkupay.db             # Primary SQLite WAL database
├── .env.example            # Environment configuration template
│
└── companion-android/      # Native Kotlin Android Companion App
    └── app/src/main/
        ├── AndroidManifest.xml
        └── java/in/sakkupay/companion/
            ├── MainActivity.kt               # Setup UI, status card & connection tester
            ├── PaymentNotificationListener.kt # NotificationListenerService background hook
            ├── PaymentParser.kt               # Debit rejection & universal UPI regex engine
            └── Prefs.kt                       # Secure SharedPreferences manager
```

---

## 🔄 Automated Verification Engine (Dual Mode)

SakkuPay provides two complementary verification methods to guarantee zero manual reconciliation:

### Mode 1: Direct Business Gateway Linking
1. Open the **"Link Business Accounts"** tab in the merchant dashboard.
2. Click **"+ Link Account"** and select **PhonePe Business** or **Paytm Business**.
3. Enter your Registered Mobile Number, Merchant ID (MID), and API Secret / Salt Key.
4. Secrets are encrypted using **AES-256-GCM** before writing to disk; only masked representations (e.g. `secr••••••••z789`) are returned via API.
5. Direct webhooks receive callbacks from providers:
   - `POST /api/v1/webhook/phonepe`
   - `POST /api/v1/webhook/paytm`
6. Transactions verified this way receive the badge `⚡ PhonePe Direct` or `⚡ Paytm Direct`.

### Mode 2: Android Companion App (Universal Fallback)
For bank accounts, personal UPI handles, or apps without direct gateway APIs:
1. Open `companion-android` in Android Studio and build/install the APK on the merchant's business phone.
2. In the app:
   - Enter your **Server URL** (`https://your-domain.com`).
   - Enter your **Merchant ID** (found under the Developers or Link Business Accounts tab).
   - Enter your secret **API Key** (`sk_live_...`).
   - Tap **"Test Server Connection"** to verify credentials.
   - Tap **"Open Notification Settings"** and grant Notification Access to the companion app.
3. When customer payments arrive:
   - [`PaymentParser.kt`](file:///companion-android/app/src/main/java/in/sakkupay/companion/PaymentParser.kt) filters out debits/outgoing notifications, extracts the exact amount and UTR, and sends a secure POST to `/api/v1/webhook/verify-payment`.
   - The backend matches recent pending transactions (within 30 mins) or creates a direct record if paid without a checkout link.
   - The transaction is marked `🤖 Companion Verified`.

---

## 📡 REST API Reference

### Public & Checkout Endpoints
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/pay/:slug` | Customer checkout interface. |
| `GET` | `/api/checkout/:slug` | Public payment link metadata. |
| `POST` | `/api/checkout/:slug/attempt` | Records initial payment attempt from a customer. |
| `POST` | `/api/checkout/:slug/confirm` | Customer submits optional UTR reference. |
| `GET` | `/api/checkout/:slug/status` | Polling endpoint for real-time customer status. |

### Automated Webhooks (No Session Required)
| Method | Endpoint | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/webhook/verify-payment` | `X-API-Key` | Companion connection ping & credential check. |
| `POST` | `/api/v1/webhook/verify-payment` | `X-API-Key` | Companion app payment payload forwarding. |
| `POST` | `/api/v1/webhook/phonepe` | Webhook / Signature | Direct PhonePe Business server-to-server callback. |
| `POST` | `/api/v1/webhook/paytm` | Webhook / Signature | Direct Paytm Business server-to-server callback. |

### Merchant Endpoints (Requires `Authorization: Bearer <token>`)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/events` | Server-Sent Events stream for real-time dashboard updates. |
| `GET` | `/api/dashboard` | Aggregated dashboard stats (volume, successful, pending, active links). |
| `GET`, `PUT` | `/api/profile` | View or update business profile & WhatsApp contact. |
| `GET`, `POST` | `/api/upis` | List or register receiving UPI destinations. |
| `PATCH`, `DELETE`| `/api/upis/:id` | Set default UPI or remove account. |
| `GET`, `POST` | `/api/links` | List or create custom payment links. |
| `GET` | `/api/transactions` | Searchable transaction ledger with date-range filters. |
| `GET`, `POST` | `/api/keys` | List or generate developer API keys (`sk_live_...`). |
| `GET`, `POST` | `/api/business-accounts` | List or link PhonePe / Paytm business gateway accounts. |
| `POST` | `/api/business-accounts/:id/test` | Test connectivity & sync status with gateway. |
| `POST` | `/api/business-accounts/direct-verify`| Instantly verify a pending transaction using linked gateway credentials. |
| `DELETE` | `/api/business-accounts/:id` | Disconnect a linked business account. |

### Integration API (`X-API-Key: sk_live_...`)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/integration/payment-links` | Programmatically generate a payment link from an external store/bot. |

### Admin Endpoints (`Authorization: Bearer <admin_token>`)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/admin/login` | Administrator authentication. |
| `GET` | `/api/admin/overview` | Platform-wide volume, transaction, and user statistics. |
| `GET`, `DELETE` | `/api/admin/merchants` | Manage registered merchants & accounts. |
| `GET` | `/api/admin/transactions` | Global platform transaction ledger. |
| `GET` | `/api/admin/errors` | Diagnostic client error monitor. |
| `GET`, `POST` | `/api/admin/whatsapp/*` | Manage Baileys WhatsApp QR code connection & status. |

---

## ⚙ Environment Variables

| Variable | Required | Default | Purpose |
| :--- | :---: | :--- | :--- |
| `PORT` | Optional | `3000` | Port for the HTTP server. |
| `SAKKUPAY_TOKEN_SECRET` | Recommended | `development-only-change-this-secret` | HMAC-SHA256 signature key for session tokens. |
| `VAULT_SECRET` | Recommended | `sakkupay-vault-secret-key-2026` | 32-byte secret used for AES-256-GCM encryption of PhonePe/Paytm keys. |
| `GOOGLE_CLIENT_ID` | Yes (for Auth) | None | Google Cloud OAuth 2.0 Client ID for merchant sign-in. |
| `GOOGLE_CLIENT_SECRET` | Yes (for Auth) | None | Google Cloud OAuth 2.0 Client Secret. |
| `GOOGLE_REDIRECT_URI` | Optional | `${origin}/api/auth/google/callback` | OAuth redirect URI registered in Google Cloud Console. |
| `ADMIN_USERNAME` | Optional | `admin` | Username for accessing the restricted Admin Dashboard at `/admin`. |
| `ADMIN_PASSWORD` | Optional | `changeme123` | Password for accessing the restricted Admin Dashboard at `/admin`. |
| `DB_PATH` | Optional | `./sakkupay.db` | Path to SQLite database file. |

---

## 🧪 Automated Testing

SakkuPay includes five comprehensive automated test suites verifying payment cryptography, database persistence, state transitions, administrative control, and UI/UX integration:

```bash
# Run all test suites (455 automated tests)
npm test

# Run Milestone 1 Security & Cryptography suite
npm run test:m1

# Run Milestone 2 SQLite Migration & Repository suite
npm run test:m2

# Run Milestone 3 Payment Lifecycle & Reconciliation Hardening suite
npm run test:m3

# Run Milestone 4 Admin Control Center & Audit Trail suite
npm run test:m4

# Run Milestone 5 UI/UX Redesign & Static/API Integration suite
npm run test:m5
```


---

## 🌐 Production Deployment

SakkuPay is a lightweight Node.js application with zero heavy external database dependencies:

- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Recommended Node Version:** `>= 20.0.0`
- **Persistent Disk:** If deploying on containerized platforms (such as Render, Railway, Fly.io, or VPS), attach a persistent volume to preserve `data.json`.
- **Reverse Proxy / SSL:** If running behind Nginx or Cloudflare, ensure headers `X-Forwarded-Proto: https` are passed for proper callback generation.
