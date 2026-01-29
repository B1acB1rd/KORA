# Kora Rent Reclaimer

A bot that gets back your rent SOL from sponsored Solana accounts. Built for Kora node operators who want to recover locked capital without manual work.

---

## How Kora Works (and why rent gets locked)

### What is Kora?

Kora is a paymaster service for Solana. It lets apps sponsor transaction fees for their users so users dont need to hold SOL. The operator runs a Kora node that:

1. Accepts transactions from users
2. Signs them as the fee payer (using the operators SOL)
3. Optionally collects payment in SPL tokens (USDC, BONK, etc)

This is great for UX but theres a catch - the operators SOL gets used for more than just tx fees.

### Where Does Rent Get Locked?

On Solana, every account needs to hold a minimum SOL balance called "rent". When a Kora-sponsored transaction creates new accounts, the fee payer (thats you, the operator) pays for that rent.

Common scenarios where your SOL gets locked:

```
Scenario 1: Token Transfers
- User A sends tokens to User B for the first time
- User B needs an Associated Token Account (ATA) to receive
- ATA creation costs ~0.00203 SOL in rent
- Your Kora node paid for that

Scenario 2: NFT Minting  
- User mints an NFT through your app
- NFT needs mint account (~0.00145 SOL)
- NFT needs metadata account (~0.0056 SOL)
- Your Kora node paid for all of that

Scenario 3: Any Account Creation
- System accounts, PDAs, whatever
- If your node sponsored it, you paid the rent
```

### The Rent Table

| Account Type | Rent Cost | When Created |
|-------------|-----------|--------------|
| Token Account (ATA) | ~0.00203 SOL | First token transfer to a wallet |
| Mint Account | ~0.00145 SOL | New token/NFT creation |
| Metadata Account | ~0.0056 SOL | NFT metadata |
| System Account | Variable | General purpose accounts |

### The Problem

Over time this adds up. If your node sponsors 1000 transactions that create accounts:

```
1000 ATAs x 0.00203 SOL = 2.03 SOL locked

6 months later:
- 300 accounts are still active (users still use them)
- 500 accounts have zero balance (user moved tokens out)
- 200 accounts are completely closed

That 500 + 200 = 700 accounts worth of rent is recoverable
= ~1.4 SOL just sitting there
```

Most operators dont track this. They see SOL leaving their wallet for fees but dont realize how much is locked in rent vs actually spent on tx fees. Silent capital loss.

### How Rent Reclaim Works on Solana

**Important: Fee Payer vs Authority**

Paying for an account's creation (as fee payer) does NOT automatically give you the right to close it. On Solana, only the account's **authority** can close it:

- **Token Accounts (SPL)** - The `closeAuthority` (defaults to the account owner) must sign. If you're the fee payer but not the authority, you CANNOT close it.
- **System Accounts** - The account's private key is required. Fee payers cannot close user system accounts.
- **Program-Owned Accounts** - The owning program controls close logic. May require operator authority.

**What This Means for Kora Operators:**

| Account Type | Who Can Close | Can Operator Reclaim? |
|--------------|--------------|----------------------|
| User's ATA (token account) | User wallet | NO - user is authority |
| Operator-owned ATA | Operator | YES - if operator is closeAuthority |
| User's System Account | User | NO - requires user's private key |
| Already Closed Account | N/A | TRACKING ONLY - rent already returned |
| Custom Program PDA | Depends on program | MAYBE - if program grants authority |

This bot automatically detects which accounts the operator has authority over and only attempts to close those.

---

## What This Bot Does

This bot automatically manages rent recovery for Kora-sponsored accounts:

1. **Tracks sponsored accounts** - Import from files, discover from fee payer transactions, or parse Kora logs
2. **Detects authority** - Checks each token account's `closeAuthority` to verify operator permissions
3. **Scans for reclaimable accounts** - Identifies accounts that are closed, empty, AND where operator has authority
4. **Safely reclaims rent** - Only closes accounts the operator is authorized to close
5. **Logs everything** - Full audit trail with authority status for each account

**Note:** The bot will skip accounts where the operator is not the authority. This is by design - on Solana, you cannot close accounts you dont own.

### Core Features

- **Authority verification** - Automatically detects if operator can close each account
- **Batch scanning** - Uses `getMultipleAccounts` RPC call for efficiency
- **Safety checks** - Whitelist, idle time requirements, max reclaim limits
- **Telegram alerts** - Get notified when reclaims happen
- **Cron mode** - Run automatically on a schedule
- **Dry run mode** - Test without executing anything

---

## Architecture

```
                    Sponsored Accounts
                    (from import/discover)
                           |
                           v
                    +----------------------------------+
                    |   Scanner   |                    |
                    | - Fetches account state from RPC |
                    | - Checks if closed/empty/inactive|
                    +----------------------------------+
                           |
                           v
                    +--------------------+
                    |   Safety           |
                    | - Whitelist check  |
                    | - Idle time check  |
                    | - Budget limits    |
                    +--------------------+
                           |
                           v
                    +----------------------------------+
                    |   Reclaim                        |
                    | - Creates close instructions     |
                    | - Batches into transactions      |
                    | - Sends with retry logic         |
                    +----------------------------------+
                           |
                           v
                    +--------------------+
                    |   Logger           |
                    | - JSON logs        |
                    | - Console output   |
                    | - Telegram alerts  |
                    +--------------------+
                           |
                           v
                      Treasury $
```

---

## Quick Start & Verification

**For Judges & Evaluators:** The fastest way to verify this bot works is using the `dev` script with the pre-configured details.

1.  **Install**: `npm install`
2.  **Build**: `npm run build`
3.  **Run Dry-Run**: `npm start -- reclaim --dry-run -n devnet`
    *   *This will simulate the process using the configured test wallet and show you exactly what would happen without spending real SOL.*
4.  **Run Scan**: `npm start -- scan -n devnet -v`
    *   *This will show you the account scanning process in verbose mode.*

---

## Getting Started

### Option 1: Download Standalone Binary (Recommended)

Download the pre-built binary for your platform from the [Releases](https://github.com/B1acB1rd/KORA/releases) page:

| Platform | File |
|----------|------|
| Windows | `kora-reclaimer.exe` |
| Linux | `kora-reclaimer-linux` |
| macOS | `kora-reclaimer-macos` |

**No Node.js required!** Just download, configure, and run.

#### Quick Start with Binary

```bash
# Windows (PowerShell)
.\kora-reclaimer.exe --help
.\kora-reclaimer.exe status
.\kora-reclaimer.exe scan -n devnet

# Linux/macOS
chmod +x kora-reclaimer-linux  # Make executable (first time only)
./kora-reclaimer-linux --help
./kora-reclaimer-linux status
./kora-reclaimer-linux scan -n devnet
```

#### Data Directory

The CLI stores its data (database, logs, whitelist) in:
- **Windows:** `%APPDATA%\kora-reclaimer\`
- **Linux/macOS:** `~/.kora-reclaimer/`

---

### Option 2: Build from Source (Recommended for Testing)

This is the best way to test and develop.

#### Requirements

- Node.js 18+
- npm (comes with Node.js)
- A Solana operator keypair (JSON format)
- Some devnet SOL for transaction fees

#### Install & Build

```bash
git clone <repo-url>
cd kora-rent-reclaimer
npm install
npm run build
```

#### Build Standalone Binaries (Optional)

You can package the bot as a standalone executable for distribution:

```bash
npm run build:windows  # Creates bin/kora-reclaimer.exe
npm run build:linux    # Creates bin/kora-reclaimer-linux
npm run build:macos    # Creates bin/kora-reclaimer-macos
npm run build:all      # All platforms
```

Then run the binary directly:
```bash
./bin/kora-reclaimer-linux scan -n devnet  # Linux/macOS
.\bin\kora-reclaimer.exe scan -n devnet     # Windows
```


### Configure Environment

A `.env` file already exists in the repo configured for Devnet testing. You may customize it:

```env
# RPC Configuration
RPC_URL=https://api.devnet.solana.com
NETWORK=devnet

# Your operator wallet (the one that sponsors txs)
# This should point to a keypair JSON file you own
WALLET_PATH=./devnet-operator.json

# Where reclaimed SOL goes (should be your operator address)
TREASURY_ADDRESS=<your-operator-pubkey>

# Safety settings
MIN_IDLE_DAYS=0  # Use 0 for testing; use 7+ for production
MAX_RECLAIM_SOL_PER_RUN=10

# Optional: Telegram alerts
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ALERT_THRESHOLD_SOL=1.0
```

**Important:** Replace `WALLET_PATH` and `TREASURY_ADDRESS` with your actual operator keypair and address.

### Quick Start (Tested Workflow)

Follow these exact steps to test the bot on Devnet:

#### Step 1: Install Dependencies

```bash
npm install
```

#### Step 2: Build the Project

```bash
npm run build
```

#### Step 3: Generate Test Accounts (Optional, for demo)

If you want to test with fresh token accounts on Devnet:

```bash
npx ts-node test-scripts/devnet-proof.ts
```

This script will:
- Create 2 test token accounts on Devnet
- Set your operator as the `closeAuthority` (so you can reclaim)
- Save account metadata to `test-accounts.json`
- Update `.env` with the test wallet address and treasury

#### Step 4: Import Accounts

Import test accounts (or your own from a JSON file):

```bash
node dist/index.js import test-accounts.json -n devnet
```

#### Step 5: Scan for Reclaimable Accounts

Scan your tracked accounts to identify which ones you can reclaim:

```bash
node dist/index.js scan -n devnet -v
```

Expected output:
- List of reclaimable accounts
- Authority verification (operator must be `closeAuthority`)
- Amount of SOL locked in each account

#### Step 6: Dry-Run Reclaim (Recommended)

Simulate the reclaim without actually sending transactions:

```bash
node dist/index.js reclaim --dry-run -n devnet -v
```

This shows what accounts would be closed and how much SOL would be recovered.

#### Step 7: Execute Reclaim

Once satisfied with the dry-run output, execute the actual reclaim:

```bash
node dist/index.js reclaim -n devnet -v
```

The bot will:
- Create close account transactions
- Sign them with your operator keypair
- Send them to Devnet
- Return rent SOL to your treasury address

#### Step 8: Check Status

View reclaim history and account statistics:

```bash
node dist/index.js status -n devnet
```

View JSON logs:

```bash
ls %APPDATA%\kora-reclaimer\logs\  # Windows
ls ~/.kora-reclaimer/logs/           # Linux/macOS
```

### Using Your Own Accounts

Instead of the test script, you can import real sponsored accounts:

```bash
# Discover accounts from your fee payer address
node dist/index.js discover <your-fee-payer-address> --limit 1000 -n devnet

# Or import from a JSON file
node dist/index.js import your-accounts.json -n devnet
```

JSON format:
```json
[
  {
    "pubkey": "8NsGv6qS7VPU9bVxLwWvBHuBfaXJKqLN8FnLHHFNDYXh"
  },
  {
    "pubkey": "5JvHtHVfEZLZKQxm3zWGaRMHJNt3WqRZ8KNDT7y4xKPU"
  }
]
```

---

## Commands Reference

### Main Commands

| Command | What it does |
|---------|-------------|
| `scan` | Scan tracked accounts, show which are reclaimable |
| `reclaim` | Execute rent reclaim on eligible accounts |
| `status` | Show stats (tracked, active, closed, reclaimed, SOL locked) |
| `discover <feePayer>` | Find sponsored accounts from fee payer tx history |
| `import <file>` | Import accounts from JSON file |
| `export <file>` | Export tracked accounts to JSON |

### Whitelist Commands

```bash
node dist/index.js whitelist add <pubkey> --reason "why"
node dist/index.js whitelist remove <pubkey>
node dist/index.js whitelist list
```

### Cron Mode

```bash
# Run every 6 hours
node dist/index.js cron --schedule "0 */6 * * *"
```

### Global Flags

| Flag | Description |
|------|-------------|
| `-n, --network` | devnet or mainnet-beta |
| `-d, --dry-run` | Simulate only |
| `-v, --verbose` | More output |

---

## Safety Features

This bot moves SOL around, so its got guardrails:

### Whitelist
Add accounts that should never be touched. Maybe theyre still active, maybe theyre special.

### Dry Run Mode
Always use `--dry-run` first. See what would happen without actually doing it.

### Max Reclaim Per Run
Caps total SOL reclaimed in one execution. Default 10 SOL. Set via `MAX_RECLAIM_SOL_PER_RUN` env var.

### Minimum Idle Time
Accounts must be inactive for X days before reclaim. Default 7 days. Set via `MIN_IDLE_DAYS`.

### Mainnet Confirmation
On mainnet, the bot asks "are you sure?" before doing anything. Use `-y` flag to skip.

### Full Logging
Every action logged with timestamp, account pubkey, status, and reason. JSON logs in `./logs/`.

---

## Logs and Reporting

### Console Output

```
==================================================
  Scan Summary
==================================================
  Total Accounts:    1204
  Reclaimed:         42 (0.84 SOL)
  Skipped:           311
  Failed:            2
  Duration:          12.45s
==================================================
```

### JSON Logs

Saved to `./logs/reclaim-YYYY-MM-DD.json`:

```json
{
  "summary": {
    "totalAccounts": 1204,
    "reclaimable": 42,
    "reclaimed": 42,
    "skipped": 311,
    "failed": 2,
    "totalLamportsReclaimed": 840000000
  },
  "entries": [
    {
      "pubkey": "8NsGv...",
      "status": "reclaimed",
      "lamports": 2039280,
      "txSignature": "4nKSv...",
      "timestamp": "2026-01-16T12:00:00Z"
    },
    {
      "pubkey": "5JvHt...",
      "status": "skipped",
      "reason": "Account is whitelisted",
      "timestamp": "2026-01-16T12:00:01Z"
    }
  ]
}
```

Every account gets a status and reason, so you can audit what happened.

---

## Telegram Alerts

If you configure the bot token and chat ID, youll get:

- Summary after each reclaim run
- Alerts for large reclaims (configurable threshold)
- Error notifications
- Startup messages when cron starts

---

## Troubleshooting

### Issue: "Could not load operator keypair"

**Cause:** `WALLET_PATH` in `.env` doesn't exist or is invalid.

**Fix:**
1. Ensure `WALLET_PATH` points to a valid keypair JSON file
2. The keypair should be a 64-byte array: `[29, 234, 249, ...]`
3. Example:
   ```json
   [29, 234, 249, 202, 206, 179, 254, 234, ...]
   ```

### Issue: "No accounts found to reclaim"

**Cause:** Accounts don't have operator as `closeAuthority` or fail safety checks.

**Fix:**
1. Run `scan -v` to see why accounts are skipped
2. Check that `WALLET_PATH` matches the operator who created the accounts
3. Ensure `MIN_IDLE_DAYS` is set appropriately (use 0 for fresh test accounts)
4. Review whitelist with `whitelist list`

### Issue: "Insufficient SOL for fees"

**Cause:** Operator wallet doesn't have enough SOL for transaction fees.

**Fix:**
1. Get devnet SOL:
   ```bash
   solana airdrop 2 <your-operator-pubkey> --url devnet
   ```
2. Or request funds from the Solana Devnet Faucet: https://faucet.solana.com/

### Issue: "sql.js: Failed to load bindings"

**Cause:** Native SQLite bindings not available (harmless warning).

**Fix:** This is not an error — the bot falls back to pure JavaScript SQLite. If you want native bindings:
```bash
npm run rebuild
```

### Issue: Commands not working in PowerShell

**Cause:** Path or quoting issues on Windows.

**Fix:** Use full paths and proper quoting:
```powershell
node dist/index.js scan -n devnet -v
node dist/index.js reclaim --dry-run -n devnet
```

---

## Prerequisites for Testing

Before you start, ensure you have:

- **Node.js 18+** installed
  ```bash
  node --version  # Should be v18.0.0 or higher
  ```
- **npm** installed
  ```bash
  npm --version
  ```
- **A Solana operator keypair** (JSON format)
  - Generate one: `solana-keygen new`
  - Or use an existing keypair
- **Devnet SOL** in your operator wallet
  - Request airdrop: `solana airdrop 2 <pubkey> --url devnet`
  - Or use the test script (includes airdrop logic)
- **Internet connection** to reach Solana Devnet RPC

---

## Production Readiness

Before running on **Mainnet**:

1. **Test thoroughly on Devnet** with real sponsored accounts
2. **Set `MIN_IDLE_DAYS`** to a safe value (7+ days recommended)
3. **Use a whitelisted address** for treasury to prevent accidents
4. **Enable Telegram alerts** to be notified of large reclaims
5. **Review all logs** and dry-run output before executing
6. **Monitor transaction signatures** to confirm on Solana Explorer
7. **Keep backups** of your database (`database/accounts.db`)

Example production `.env`:

```env
RPC_URL=https://api.mainnet-beta.solana.com
NETWORK=mainnet-beta
WALLET_PATH=/path/to/your/mainnet-operator.json
TREASURY_ADDRESS=<your-mainnet-treasury>
MIN_IDLE_DAYS=30
MAX_RECLAIM_SOL_PER_RUN=5
TELEGRAM_BOT_TOKEN=<your-bot-token>
TELEGRAM_CHAT_ID=<your-chat-id>
```

---

## Technical Details

### How We Detect Reclaimable Accounts

1. Fetch account info via RPC
2. Check if account exists (null = already closed)
3. Check account owner (System Program vs Token Program vs other)
4. For token accounts: check if balance is 0
5. Apply safety filters (whitelist, idle time, etc)

### How We Reclaim

**Token Accounts (SPL)** - Only if operator is the closeAuthority
```
closeAccount(
  account,      // the ATA to close
  destination,  // where rent goes (treasury)
  authority     // who can close (must be operator)
)
```

**System Accounts** - SKIPPED

System accounts require the account's private key to close. The operator (fee payer) cannot close user system accounts. These are logged and skipped.

**Program Accounts**

We skip these. Different programs have different close mechanisms and we dont want to make assumptions.

### Transaction Batching

We batch multiple close instructions into single transactions (up to 10 per tx) for efficiency. Each batch gets retry logic with exponential backoff.

---

## File Structure

```
src/
  index.ts      - CLI entry point
  config.ts     - Environment and settings
  database.ts   - SQLite for tracking accounts
  scanner.ts    - Account scanning logic
  reclaim.ts    - Transaction execution
  safety.ts     - Whitelist and limits
  logger.ts     - Logging and reporting
  kora.ts       - Account discovery/import
  alerts.ts     - Telegram notifications
```

---

## Tech Stack

- TypeScript
- @solana/web3.js - RPC and transactions
- @solana/spl-token - Token account handling
- sql.js - SQLite in JavaScript
- commander - CLI framework
- node-cron - Scheduling
- chalk - Pretty console output

---

## Support & Feedback

For issues, questions, or improvements:
- Check the **Troubleshooting** section above
- Review **logs** in `%APPDATA%\kora-reclaimer\logs\` (Windows) or `~/.kora-reclaimer/logs/` (Linux/macOS)
- Ensure `.env` is correctly configured
- Run with `-v` flag for verbose output

---

## License

MIT

---

**Tested on Devnet with real Solana RPC. Use on Mainnet at your own risk.**
