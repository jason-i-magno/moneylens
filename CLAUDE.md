# CLAUDE.md — MoneyLens Personal Finance Tracker

## Project Overview

MoneyLens is a personal finance tracker web app — a local-first alternative to apps like Rocket Money. It tracks spending, income, subscriptions, budgets, a mortgage, and net worth without paid APIs. Transactions come in as **CSV files downloaded from the bank's website** or, optionally, through **Bank Sync** (Plaid's free Trial plan, via a small local server); balances and mortgage payments can also be read from **statement PDFs**. App data is stored locally in the browser.

Built-in support: CSV profiles for **US Bank checking, American Express, and Discover**; statement PDF parsers for **Lakeview/LoanCare** and **Rocket Mortgage** (mortgage payments) and **US Bank** (account balances). Other banks work through manual column mapping or Bank Sync.

**This repo is public. Never commit personal data** — see [Personal Data](#personal-data).

## Tech Stack

- **Framework:** React 18 with Vite 6
- **Language:** JavaScript (JSX), no TypeScript unless asked
- **Styling:** single global `src/App.css` with CSS custom properties (dark theme)
- **Storage:** localStorage, one key (`moneylens-data`), versioned and migrated on load
- **Routing:** React Router v6 (`BrowserRouter`, v7 future flags on); pages are lazy-loaded
- **Charts:** Recharts
- **CSV parsing:** PapaParse
- **PDF parsing:** pdfjs-dist (loaded on demand — only the Mortgage and Net Worth pages import it)
- **Tests:** Vitest (unit tests for `src/utils` and `server/`, run with `TZ=Etc/GMT+10` (UTC−10) so UTC-vs-local date bugs show up)
- **Lint:** ESLint 9 flat config with `react-hooks` and `react-refresh`
- **Backend:** none, except the Bank Sync API (`server/plaidApi.js`), a Vite plugin that runs inside `npm run dev` / `npm run preview`. Everything else is client-side and deploys as a static site (Vercel/Netlify); Bank Sync just shows setup instructions there.

## Commands

```bash
npm install        # Install deps
npm run dev        # Start dev server (with the Bank Sync API)
npm test           # Run unit tests once (npm run test:watch to watch)
npm run lint       # ESLint
npm run build      # Production build
npm run preview    # Serve the build locally (with the Bank Sync API)
```

Run `npm run lint && npm test && npm run build` before calling a change done.

## Design Direction

- **Theme:** Dark UI (`#1A1A1F` background, `#222228` cards, `#E8E4DD` text)
- **Accent colors:** Warm gradient (`#E8927C` coral → `#C97CE8` purple) for primary actions
- **Category colors:** each spending and income category has its own color (see [Categories](#categories))
- **Typography:** DM Sans (Google Fonts). No generic system fonts.
- **Tone:** Clean, modern, slightly warm. Not corporate. Premium personal tool.
- **Rounded corners:** 10-14px on cards and buttons
- **Animations:** subtle transitions on bar charts, tab switches, modal open/close
- **Translucent colors in CSS:** use `color-mix(in srgb, var(--x) 13%, transparent)`. Appending hex alpha to a variable (`var(--x)22`) is invalid CSS and silently drops the whole declaration. (Appending alpha to a hex *string* in JS, e.g. `cat.color + '22'`, is fine.)

## How Money Is Counted (read this first)

All rules live in `src/utils/transactions.js` — use these helpers, never re-implement the filters inline:

| Helper | Rule |
|---|---|
| `isCredit(tx)` | `tx.type === 'credit'` (manual transactions have no `type` → debits) |
| `isTransfer(tx)` | `tx.category === 'transfers'` |
| `isIncome(tx)` | credit **and not** a transfer |
| `isSpending(tx)` | not a credit **and not** a transfer |

- **Transfers** are credit card payments and moves between the user's own accounts. A card payment appears twice — as a debit on checking ("AMEX EPAYMENT") and a credit on the card ("MOBILE PAYMENT - THANK YOU") — so it must be neither income nor spending.
- **Income is derived** from credit transactions; there is no manual income setting.
- **Manual subscriptions are informational.** Imported bank transactions already include those charges, so they're never added to spending totals, the dashboard chart, or "Remaining".
- List pages show everything (Spending lists transfer debits, Income lists transfer credits) so items can be found and recategorized, but totals exclude transfers.

## Pages

| Route | Page | What it does |
|---|---|---|
| `/dashboard` | Dashboard | Current month: income, spending, remaining (= income − spending); recurring-costs card (manual subscriptions, informational); spending-by-category bar chart with budget markers; 5 most recent transactions (read-only) |
| `/subscriptions` | Subscriptions | Manual subscriptions (add/edit/delete, normalized monthly cost) plus "Detected from Imports": imported transactions with `isSubscription`, grouped by merchant |
| `/spending` | Spending | Debits by month with category and subscription filters; add/edit/delete; header total excludes transfers unless the Transfers filter is selected |
| `/income` | Income | Credits by month; edit/delete; header splits income from transfers-in (not counted) |
| `/trends` | Trends | Spending by category, income by category and net (income / spending / net), each with series toggles, monthly or daily; each period's own total as bars, or the running total (Cumulative) as lines. Builders in `src/utils/trends.js` |
| `/budgets` | Budgets | Monthly cap per category with progress bars (red when over); shows categories with a budget or spending |
| `/mortgage` | Mortgage | Properties, loans, payments; amortization vs. actual; extra-payment impact; combined view across a refi; statement PDF import; JSON import/export; delete payments/loans/properties |
| `/net-worth` | Net Worth | Accounts (assets/liabilities) with balance snapshots; live balances for accounts linked to a bank profile; mortgage loans and properties included automatically; US Bank statement PDF import |
| `/import` | Import | CSV import wizard (below) |
| `/bank-sync` | Bank Sync | Connect banks through Plaid, choose where each account syncs, sync, reconnect, disconnect (below) |
| `/settings` | Settings | Delete saved bank profiles; edit category keywords; re-categorize imported and synced transactions; export/import JSON; reset |

## CSV Import (`/import`) — primary data entry

1. **Upload** — drop one or more `.csv`/`.tsv` files. Each is parsed immediately; its bank profile is auto-detected from the filename (`detectProfileFromFilename` in `constants/bankProfiles.js`) or chosen from a dropdown ("New Bank (manual mapping)" for unknown banks).
2. **Map Columns** — only for files without a profile, one at a time. Columns are pre-guessed from header names; date format is detected from the mapped date column (DD/MM is chosen when a first number exceeds 12). Optional "Save as bank profile" name makes it reusable and tags its transactions with the new profile ID.
3. **Preview** — rows are auto-categorized (see keywords) and tagged `isSubscription`; each row has a category dropdown and a skip checkbox; unparseable rows are red. **Suspected duplicates** (same date + amount + description as an existing transaction) start out skipped and can be included per row.
4. **Confirm** — "Import duplicates anyway" / "Skip all duplicates"; lists profiles that will be saved. Importing also auto-creates a linked Net Worth account the first time a built-in bank is imported (`PROFILE_ACCOUNT_MAP`). Redirects to `/spending`.

Credits and debits are both imported (credits become income unless categorized as transfers).

Wizard state rule: when a handler both updates `fileEntries` and builds the preview, build from the new array you just computed — never from state captured by the render (that was a real bug: manual mappings produced 0 rows).

### Bank profiles

Built-in profiles live in `src/constants/bankProfiles.js` (`BUILTIN_BANK_PROFILES`, marked `builtin: true`); user-saved ones in `data.bankProfiles`. The two are merged, user entries winning.

```json
{
  "name": "US Bank Checking",
  "builtin": true,
  "dateColumn": "Date",
  "descriptionColumn": "Name",
  "amountColumn": "Amount",
  "amountFormat": "negative_is_debit",
  "dateFormat": "YYYY-MM-DD",
  "categoryColumn": null,
  "debitColumn": null,
  "creditColumn": null,
  "skipHeaderRows": 0
}
```

`amountFormat`: `negative_is_debit` (US Bank), `positive_is_debit` (Amex, Discover), or `two_columns` (uses `debitColumn`/`creditColumn`). A bank-provided category column is used only if its value matches one of our category IDs or names.

## Bank Sync (`/bank-sync`) — Plaid

**Where things live.** The Plaid keys are in `.env.local` (gitignored; template in `.env.example`; loaded in `vite.config.js` with `loadEnv(…, 'PLAID_')` — never give them a `VITE_` prefix, or Vite ships them to the browser): one `PLAID_CLIENT_ID`, one secret per environment (`PLAID_SECRET_SANDBOX`, `PLAID_SECRET_PRODUCTION`), and `PLAID_ENV` choosing between them. `resolvePlaidConfig` turns these into the API's config or a setup problem to show (a missing variable, or the retired single `PLAID_SECRET`, which is never guessed at). Per-bank access tokens are in `~/.config/moneylens/plaid-tokens.json` (override with `PLAID_TOKEN_FILE`), outside the repo so they can't be committed, served by Vite, or wiped by `git clean -x`. The browser stores only `data.plaid.items` (account mapping + sync cursor) and never sees a token or the secret.

**Local API** (`server/plaidApi.js`, mounted at `/api/plaid/*` by `plaidApiPlugin`): POST + JSON only; refuses non-localhost `Host` headers (DNS rebinding) and foreign `Origin`s, because plugin middleware runs before Vite's own CORS/host checks. Actions: `status`, `link-token` (with `itemId` = update mode), `exchange`, `accounts`, `sync`, `remove`. `PLAID_ENV` is `sandbox` or `production`; tokens are stored per environment.

**Plaid specifics that shaped the code:**
- Link products: `['transactions']` with `days_requested: 730`. Plaid Link must load from `cdn.plaid.com` (`src/utils/plaidClient.js`); desktop web needs no redirect URI (OAuth opens a popup).
- The Trial plan allows **10 connections ever**; removing one doesn't free it. The token file keeps `createdCount` (never decremented), the page shows it, and connecting a bank that's already connected asks first.
- `/transactions/sync` pages are followed until `has_more` is false; on `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` the whole loop restarts from the first cursor. Pending transactions are dropped (once posted they come back under a new ID). Names use `original_description` so they match CSV rows and keyword rules.
- Plaid amounts are positive for money out → `type: 'debit'`; negative → `'credit'`.
- No webhooks (localhost): the app syncs on open when a connection's last sync is over 6 hours old (`usePlaidSync`), plus "Sync Now" / "Sync All".

**Mapping.** Each Plaid account gets a `target` — the `importedFrom` value for its transactions and the `linkedBankProfile` of its Net Worth account: a bank profile ID (continues that bank's CSV history; `PLAID_INSTITUTION_PATTERNS` suggests one in production), `plaid_<accountId>` (its own source), or `null` (not synced — the default for loan and investment accounts). Sandbox items can only use their own sources, and disconnecting one deletes its data.

**Sync rules** (`applySyncResult` in `src/utils/plaidSync.js`, pure and unit-tested):
- A result applies only if its `fromCursor` equals the item's current cursor, so a duplicate or stale sync is a no-op.
- For an account continuing CSV history, the CSVs cover the earliest CSV date for that source (computed at sync time) through `startDate`, the latest (set when the mapping is saved). Plaid rows inside that range are skipped; rows on its first and last day are skipped one-for-one against CSV rows with the same type and amount; rows before it are older history (Plaid has up to 2 years) and are added, like rows after it.
- Modified transactions update name/amount/date/type but keep the user's category. Removed ones are deleted.
- Categories: keywords first (matched against the name plus Plaid's merchant name), then Plaid's `personal_finance_category` via `src/constants/plaidCategories.js` (its `INCOME_*` categories map to income categories, `TRAVEL_*` to Travel except rental cars (Transport), and `LOAN_DISBURSEMENTS_*` to Transfers: loan proceeds aren't income, and Plaid files payments received on a credit card there), following the money-in/money-out rules under Auto-Categorization. Ambiguous transfers (deposits, generic account transfers) stay unmapped so they aren't hidden as transfers.
- **Transfers between the connection's own accounts** (`pairOwnTransfers`): after each sync, a debit and a same-amount credit in two different synced accounts of the same connection, at most 3 days apart (closest first), both become `transfers` and get `pairedTransfer: true`. Both sides must be uncategorized (`other` / `other_income`) with a `TRANSFER_*` Plaid category, or already transfers, and neither may have `categorySetByUser`, so keyword and user categories are never overridden. Rows from earlier syncs take part (the other side can post later); a row is paired at most once, so a user's later change sticks. Re-categorizing keeps a paired row a transfer unless a keyword matches.
- Balances become a `source: 'plaid'` snapshot for today on the Net Worth account linked to the target (created if missing), replacing an earlier Plaid snapshot that day; a manual or PDF snapshot for the same day wins.
- "Change Accounts" deletes the item's synced transactions and the Net Worth accounts it created, then shows the setup again (no new Plaid connection needed).

## Auto-Categorization (`src/utils/categorizer.js`)

- Matching is case-insensitive, and a keyword must **start at a word boundary** (`rent` matches "RENT PMT", not "PARENT"; `gas` doesn't match "VEGAS"). A space in a keyword matches any run of whitespace, because banks pad descriptions ("IRS  TREAS 310").
- When several keywords match, the **longest keyword wins** (`uber eats` beats `uber`; `internet payment - thank you` beats `internet`). Ties go to the category listed first in `CATEGORIES`.
- **Direction decides the kind of category** (`categorizeBatch`): money out (debits, manual entries) gets spending categories only, and an income keyword on a debit is ignored (`interest` doesn't turn "INTEREST CHARGE" into income). Money in (credits) gets income categories: an income or transfer keyword first, then Plaid's category if it says income or transfer, then a store keyword means **Refunds** (a credit from Amazon is a refund), then Plaid's store category (also Refunds), else **Other Income**. Transfers fit both directions.
- Keyword lists: `DEFAULT_CATEGORY_KEYWORDS` and `DEFAULT_SUBSCRIPTION_KEYWORDS` in `src/constants/defaultKeywords.js` = generic base lists + the private keywords file (below). Prefer specific multi-word keywords; short generic ones cause false matches.
- **Private keywords:** merchants, banks, and services specific to the user go in `src/constants/privateKeywords.local.js` (gitignored via `*.local.js`), never in `defaultKeywords.js`. It's loaded with `import.meta.glob` when present and skipped when absent or under Vitest, so a fresh clone and the tests run without it. Format:
  ```js
  export const PRIVATE_CATEGORY_KEYWORDS = { groceries: ['my local market'], transfers: ['my other bank'] };
  export const PRIVATE_SUBSCRIPTION_KEYWORDS = ['some service'];
  ```
  A local `npm run build` bundles these keywords into `dist/`. Deploy from CI (where the file doesn't exist), not from a locally built `dist/`.
- **Only the user's overrides are stored:** `data.categoryKeywords` = user-added keywords per category, `data.removedKeywords` = defaults the user turned off. `getEffectiveKeywords(added, removed)` merges them with the code defaults, so improving the defaults reaches existing users. Settings shows the effective map and saves `diffKeywords(edited)`.
- Changing keywords only affects new imports. Settings → **Re-categorize Imported Transactions** previews changes for existing `csv_import` and `plaid` transactions (`proposeRecategorization` → `recategorizeStored`, which also applies the Plaid fallback) and applies the ones left ticked.
- **Categories set by hand are kept.** `categorySetByUser: true` marks them: set when the user changes the category of an imported or synced transaction in the edit form (`applyTransactionEdit`) or the import preview, or leaves a row unticked in the Re-categorize preview. Re-categorize never proposes those rows again, and Bank Sync's transfer matching skips them.
- If you retire a default keyword, add it to `RETIRED_DEFAULT_KEYWORDS` in `src/utils/migrate.js` so v1 migration doesn't mistake it for a user addition.

## Categories

Defined in `src/constants/categories.js` (`SPENDING_CATEGORIES`, `INCOME_CATEGORIES`, both in `CATEGORIES`); use these IDs everywhere. Pickers use `categoriesFor(isCredit)`: money in gets the income categories and Transfers, money out the spending ones. Budgets, subscriptions and the dashboard chart are spending-only.

### Spending categories

| ID             | Name                 | Icon | Color     |
|----------------|----------------------|------|-----------|
| housing        | Housing              | 🏠   | `#E8927C` |
| transport      | Transport            | 🚗   | `#7CB5E8` |
| groceries      | Groceries            | 🛒   | `#E8C97C` |
| dining         | Dining Out           | 🍽️   | `#E8A64C` |
| utilities      | Utilities            | ⚡   | `#7CE8A3` |
| entertainment  | Entertainment        | 🎬   | `#C97CE8` |
| health         | Health               | 💊   | `#E87C9A` |
| shopping       | Shopping             | 🛍️   | `#7CE8D6` |
| insurance      | Insurance            | 🛡️   | `#A3E87C` |
| subscriptions  | Subscriptions        | 🔄   | `#E87CE8` |
| betting        | Gambling             | 🎲   | `#E8D44C` |
| travel         | Travel               | ✈️   | `#4A6CF0` |
| transfers      | Transfers            | 🔁   | `#6B7280` |
| other          | Other                | 📦   | `#9CA3AF` |

`subscriptions` has no default keywords. Subscription charges are categorized by what they are (e.g. Netflix → entertainment) and flagged with `isSubscription` instead.

A new category needs a color that stays distinct from the existing ones on the dark card surface, for normal and color-blind vision; Travel's `#4A6CF0` was picked that way (the palette is crowded, so most blues and pinks fail).

### Income categories

| ID             | Name                 | Icon | Color     |
|----------------|----------------------|------|-----------|
| salary         | Salary               | 💼   | `#5FD99B` |
| interest       | Interest             | 🏦   | `#6FB8F0` |
| refunds        | Refunds              | ↩️   | `#F0C05A` |
| benefits       | Benefits             | 🛟   | `#A99CF5` |
| gifts          | Gifts                | 🎁   | `#F58C8C` |
| other_income   | Other Income         | 💰   | `#9CA3AF` |

The five colored ones are in fixed order and were checked for telling apart on the dark card surface (adjacent pairs, normal and color-blind vision); Other Income is gray like Other. Income categories only label income: the money rules above are unchanged, so a refund still counts as income. Credits stored as `other` before income categories existed are re-categorized to an income category by Settings → Re-categorize.

## Net Worth

- Account categories (page-local): `bank`, `investment`, `property` (assets), `debt` (liability).
- **Snapshots** are end-of-day balances (`{ accountId, date, balance, source }`). A statement's *beginning* balance is stored on the day **before** the period starts.
- **Live balances** (`buildBalanceTimeline` in `src/utils/netWorth.js`): for an account with `linkedBankProfile`, transactions whose `importedFrom` equals that profile fill in daily balances — forward from every snapshot up to the next one, and backward from the earliest. Effect depends on account type: credits raise assets / lower liabilities; debits lower assets / raise liabilities. No snapshot → no balance.
- Mortgage properties (asset) and active loans (liability) are derived automatically from mortgage data and shown with an AUTO badge (not editable here).
- **History chart** (`buildNetWorthHistory` in `src/utils/netWorth.js`): on every date any balance changes, each account's latest known balance. Mortgage loans and properties are placed on their real dates (closing date, each payment's `date`, payoff date, purchase date), never a whole month, so a house purchase lands on the same day as the cash that paid for it. A refinance (`refinancesLoanId`) swaps the loans on one day: the new loan starts at the old one's payoff date (funding happens a few days after closing), or the old one ends when the new one starts, so both are never owed at once.

## Mortgage

- Loans have `servicerType` (`lakeview` | `rocket`) used to match statement PDFs (by loan number first, then servicer type).
- `generateAmortization` builds the original schedule; actual payments overlay it; `extrapolateFromBalance` projects payoff from the latest actual balance at the loan's `monthlyPI`.
- PDF import (`src/utils/mortgagePdfParser.js`) flags a statement as duplicate when the loan already has a payment for that `forMonth` (or the same statement appears twice in one upload). Rocket statements report one principal figure; `splitRocketPrincipal` splits it into scheduled vs. extra using the matched loan's `monthlyPI` (falling back to the statement's Amount Due).
- Don't hardcode personal figures (payment amounts, account numbers) in parsers, tests, or comments — derive them from the matched loan or use obviously fake placeholders.

## Data Model

Single localStorage key `moneylens-data`:

```json
{
  "version": 3,
  "transactions": [
    {
      "id": "tx_1711234567890_0",
      "name": "WHOLE FOODS #1234",
      "amount": 42.5,
      "category": "groceries",
      "type": "debit",
      "isSubscription": false,
      "date": "2026-03-18",
      "source": "csv_import",
      "importedFrom": "usbank_checking",
      "importedAt": "2026-03-22T00:00:00Z",
      "createdAt": "2026-03-18T00:00:00Z"
    },
    {
      "id": "tx_1711234567892_0",
      "name": "SQ *CORNER MARKET",
      "merchantName": "Corner Market",
      "amount": 18.25,
      "category": "groceries",
      "type": "debit",
      "isSubscription": false,
      "date": "2026-03-21",
      "source": "plaid",
      "importedFrom": "plaid_<plaidAccountId>",
      "plaidTransactionId": "…",
      "plaidAccountId": "…",
      "plaidCategory": "FOOD_AND_DRINK_GROCERIES",
      "importedAt": "2026-03-22T08:00:00.000Z",
      "createdAt": "2026-03-21T00:00:00Z"
    },
    {
      "id": "tx_1711234567891",
      "name": "Farmers market",
      "amount": 32.0,
      "category": "groceries",
      "date": "2026-03-20",
      "source": "manual",
      "createdAt": "2026-03-20T15:04:05.000Z"
    }
  ],
  "subscriptions": [
    { "id": "sub_1711234567890", "name": "Netflix", "amount": 15.49, "frequency": "monthly", "category": "entertainment", "nextDate": "2026-04-15", "createdAt": "..." }
  ],
  "budgets": { "dining": 300, "groceries": 600 },
  "bankProfiles": { "my_credit_union": { "name": "My Credit Union", "...": "see Bank profiles" } },
  "categoryKeywords": { "groceries": ["corner market"] },
  "removedKeywords": { "transport": ["toll"] },
  "mortgages": {
    "properties": [{ "id": "prop_…", "address": "", "purchasePrice": 0, "purchaseDate": "YYYY-MM-DD", "estimatedValue": 0 }],
    "loans": [{ "id": "loan_…", "label": "", "lender": "", "servicer": "", "servicerType": "rocket", "loanNumber": "", "loanAmount": 0, "interestRate": 6.5, "termYears": 30, "monthlyPI": 0, "startDate": "YYYY-MM-DD", "maturityDate": "", "closingDate": "", "loanType": "", "closingCosts": 0, "cashToClose": 0, "lenderCredits": 0, "status": "active | paid_off", "payoffDate": null, "payoffBalance": null, "propertyId": "", "refinancesLoanId": "optional" }],
    "payments": [{ "id": "mpay_…", "loanId": "loan_…", "date": "YYYY-MM-DD", "forMonth": "YYYY-MM", "principal": 0, "interest": 0, "escrow": 0, "extraPrincipal": 0, "balanceAfter": 0, "source": "manual | pdf_import", "statementDate": "YYYY-MM-DD" }]
  },
  "netWorth": {
    "accounts": [{ "id": "acct_…", "name": "US Bank Checking", "type": "asset | liability", "category": "bank | investment | property | debt", "linkedBankProfile": "usbank_checking" }],
    "snapshots": [{ "id": "snap_…", "accountId": "acct_…", "date": "YYYY-MM-DD", "balance": 0, "source": "manual | pdf_import | plaid" }]
  },
  "plaid": {
    "items": [{
      "itemId": "…", "institutionName": "", "env": "sandbox | production",
      "cursor": "", "lastSyncAt": null, "lastError": null, "lastSummary": null, "historyStatus": null,
      "accounts": [{ "id": "<plaidAccountId>", "name": "", "mask": "", "type": "depository", "subtype": "checking", "target": "usbank_checking | plaid_<id> | null", "startDate": "YYYY-MM-DD | null" }]
    }]
  }
}
```

- `type` exists only on imported and synced transactions; `isSubscription` is set on import (and by re-categorize).
- `importedFrom` is the profile ID of the file the row came from, `"manual"` for an unsaved manual mapping, or a Bank Sync account's `target`.
- `merchantName` and `plaidCategory` are present only when Plaid supplied them; `pairedTransfer: true` only on matched Bank Sync transfers; `categorySetByUser: true` only on categories the user chose (see Auto-Categorization). Optional fields whose absence is the right default for old data need no migration.

### Schema versions and migration

`src/utils/migrate.js` owns the stored shape: `createDefaultData()`, `SCHEMA_VERSION`, and `migrateData(raw)`, which runs on every load and on JSON restore. **Any change to the stored shape must bump `SCHEMA_VERSION` and add a migration step**, with a test in `migrate.test.js`. v1 → v2: reduced the stored keyword snapshot to user additions, dropped `monthlyIncome`, and renamed colliding IDs. v2 → v3: added `plaid` (filled in from the defaults).

### ID generation

Always use `makeId(prefix)` from `src/utils/ids.js` (`tx_`, `sub_`, `prop_`, `loan_`, `mpay_`, `acct_`, `snap_`). It returns `prefix_<Date.now()>` and appends `_N` when called more than once in the same millisecond. Batch operations use one `makeId` plus an index (`tx_1711234567890_0`, `_1`, …). Never build IDs from raw `Date.now()` in a loop — that produced duplicate IDs (and deleting one record deleted all of them). Call `makeId` outside `setState` updaters (see `applyPlaidSync`): React may run an updater twice.

## Project Structure

```
moneylens/
├── CLAUDE.md
├── .env.example                   # Template for .env.local (Plaid keys; gitignored)
├── eslint.config.js
├── index.html
├── package.json
├── vite.config.js                 # Loads PLAID_* env, mounts the Bank Sync API; also Vitest config (TZ)
├── public/favicon.svg
├── server/
│   ├── plaidApi.js                # Bank Sync API: Plaid calls, token store, request checks, Vite plugin
│   └── plaidApi.test.js
└── src/
    ├── main.jsx                   # ErrorBoundary + BrowserRouter
    ├── App.jsx                    # Routes, lazy pages, passes finance hook down as props
    ├── App.css
    ├── constants/
    │   ├── categories.js          # Spending + income categories, CATEGORY_MAP, categoriesFor, formatCurrency
    │   ├── defaultKeywords.js     # Generic category + subscription keywords (+ private file if present)
    │   ├── privateKeywords.local.js  # Gitignored: the user's personal keywords (may not exist)
    │   ├── plaidCategories.js     # Plaid personal_finance_category → our category (fallback)
    │   └── bankProfiles.js        # Built-in CSV profiles, filename detection, profile → account map, Plaid institution hints
    ├── hooks/
    │   ├── useFinanceData.js      # All state + CRUD + localStorage persistence
    │   └── usePlaidSync.js        # Bank Sync server status, sync calls, sync-on-open
    ├── utils/
    │   ├── transactions.js        # isIncome / isSpending / isTransfer, sums
    │   ├── categorizer.js         # Keyword matching, effective keywords, overrides diff
    │   ├── csvParser.js           # PapaParse wrapper, date detection, amount normalization
    │   ├── duplicateDetector.js   # date + amount + description matching
    │   ├── netWorth.js            # Balance timeline from snapshots + linked transactions
    │   ├── plaidSync.js           # Bank Sync: default targets, applySyncResult, removePlaidItem
    │   ├── plaidClient.js         # Browser calls to /api/plaid and the Plaid Link loader
    │   ├── mortgageCalculations.js
    │   ├── mortgagePdfParser.js   # Lakeview/Rocket mortgage + US Bank statement PDFs
    │   ├── migrate.js             # Default data, schema version, migrations
    │   ├── dates.js               # Local-date helpers (todayISO, currentMonth, addDays, …)
    │   ├── ids.js                 # makeId
    │   ├── subscriptions.js       # getMonthlyAmount
    │   ├── trends.js              # Per-period and cumulative totals for the Trends charts
    │   └── *.test.js              # Vitest unit tests
    ├── components/
    │   ├── Layout.jsx             # Header, nav, Suspense around routes
    │   ├── ErrorBoundary.jsx      # Crash screen with "Download Backup"
    │   ├── Modal.jsx
    │   ├── ConfirmButton.jsx      # Two-click destructive action
    │   ├── TransactionRow.jsx     # Edit/Del shown only when handlers passed
    │   ├── TransactionForm.jsx    # Shared add/edit form (Spending, Income)
    │   ├── SubscriptionCard.jsx
    │   ├── CategoryChart.jsx
    │   ├── MiniBar.jsx
    │   ├── SummaryCard.jsx
    │   ├── EmptyState.jsx
    │   ├── FileDropZone.jsx
    │   ├── ColumnMapper.jsx
    │   └── ImportPreviewTable.jsx
    └── pages/
        ├── Dashboard.jsx  Subscriptions.jsx  Spending.jsx  Income.jsx  Trends.jsx
        ├── Budgets.jsx    Mortgage.jsx       NetWorth.jsx  Import.jsx  BankSync.jsx  Settings.jsx
```

## Coding Conventions

- Functional components with hooks only. The one exception is `ErrorBoundary` — React supports error boundaries only as class components.
- One component per file (small page-private form components inside a page file are fine, e.g. `LoanForm` in `Mortgage.jsx`).
- Destructure props in function signature.
- Business logic in `useFinanceData` (state changes) and `src/utils` (pure, unit-tested). Pages compose; they shouldn't re-implement money rules.
- Format currency with `formatCurrency` (`Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })`).
- **Dates:** use `src/utils/dates.js`. Never `new Date().toISOString().slice(0, 10)` for a calendar date — it's UTC and gives tomorrow's date in the evening west of UTC.
- `const` by default, `let` only when reassignment is needed. Prefer early returns.
- Styling: use classes in `App.css`. Inline styles only for data-driven values (category colors, bar widths). Some older static inline styles remain; don't add new ones.
- Destructive deletes of records with dependents (loans, properties, accounts) go through `ConfirmButton`.

## Personal Data

The repo is public; the app's real data lives only in the browser's localStorage, and Bank Sync's secrets only in `.env.local` and `~/.config/moneylens/`. Never commit:

- Account, loan, or card numbers (even partial), balances, payment amounts, addresses
- Merchant names, banks, or services that identify the user's own spending — use `privateKeywords.local.js`
- Real statement text, CSV exports, PDFs, or JSON backups — tests use invented fixtures (e.g. `Account Number 1-234-5678-9012`)
- Plaid keys (`.env.local`), the token file, or real Plaid item/account/transaction IDs — tests use made-up ones (`item_1`, `acc_chk`)
- Facts about the user (location, timezone, which accounts they hold) in code comments, docs, or commit messages

Before committing, scan the diff for digits that look like account numbers or exact dollar amounts.

## Known Gaps vs. the Original Spec

Not built yet (build only when asked):
- Import step 1 raw 5-row preview; preview summary with date range and debit/credit totals; credit/debit filter toggle; success toast after import
- Editing saved bank profiles in Settings (only delete)
- Customizing subscription keywords
- Dashboard budget markers are full-height reference lines, not per-bar
- "Detected from Imports" monthly estimate averages charges without normalizing frequency or excluding cancelled subscriptions
- Bank Sync uses only Plaid's Transactions product: no Liabilities (mortgage details still come from statement PDFs) or Investments (brokerages may not appear in Link), no webhooks, no on-demand `/transactions/refresh`

## Future Enhancements (Don't Build Yet)

- OFX/QFX file import (Quicken format)
- SimpleFIN as a server-free alternative to Plaid for bank linking
- Plaid Liabilities/Investments for mortgage and brokerage balances
- Bill reminders / notifications
- Recurring transaction auto-generation
- Multiple currency support
- PWA support (installable on phone home screen)
- Dark/light theme toggle
