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

Solana accounts can be closed and rent recovered when:

1. **Token Accounts (SPL)** - If the token balance is 0, the account can be closed using the `closeAccount` instruction. Rent goes to a destination you specify.

2. **System Accounts** - If the account has no data (just holds SOL), you can transfer out the lamports which effectively closes it.

3. **Program-Owned Accounts** - Depends on the program. Some programs have close instructions, some dont. We skip these and flag them for manual review.

The key insight: as a Kora operator, you sponsored the creation of these accounts. In many cases (especially ATAs), you have the authority to close them and recover the rent.

---

## What This Bot Does

This bot automates the whole process:

1. **Tracks sponsored accounts** - Import from files, discover from fee payer transactions, or parse Kora logs
2. **Scans for reclaimable accounts** - Checks which accounts are closed, empty, or inactive
3. **Safely reclaims rent** - Closes eligible accounts and sends rent to your treasury
4. **Logs everything** - Full audit trail of what was reclaimed and why

### Core Features

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
                    +-------------+
                    |   Scanner   |
                    | - Fetches account state from RPC
                    | - Checks if closed/empty/inactive
                    +-------------+
                           |
                           v
                    +-------------+
                    |   Safety    |
                    | - Whitelist check
                    | - Idle time check  
                    | - Budget limits
                    +-------------+
                           |
                           v
                    +-------------+
                    |   Reclaim   |
                    | - Creates close instructions
                    | - Batches into transactions
                    | - Sends with retry logic
                    +-------------+
                           |
                           v
                    +-------------+
                    |   Logger    |
                    | - JSON logs
                    | - Console output
                    | - Telegram alerts
                    +-------------+
                           |
                           v
                      Treasury $
```

---

## Getting Started

### Requirements

- Node.js 20+
- A Solana wallet (the operator keypair)
- Some devnet SOL for testing

### Install

```bash
npm install
npm run build
```

### Configure

Copy `.env.example` to `.env` and fill in:

```env
# Which network
RPC_URL=https://api.devnet.solana.com
NETWORK=devnet

# Your operator wallet (the one that sponsors txs)
WALLET_PATH=./devnet-operator.json

# Where reclaimed SOL goes
TREASURY_ADDRESS=<your-treasury-pubkey>

# Safety settings
MIN_IDLE_DAYS=7
MAX_RECLAIM_SOL_PER_RUN=10

# Optional: Telegram alerts
# TELEGRAM_BOT_TOKEN=xxx
# TELEGRAM_CHAT_ID=xxx
```

### Basic Usage

```bash
# 1. Import or discover sponsored accounts
node dist/index.js discover <your-fee-payer-address> --limit 1000 -n devnet

# 2. Scan to see whats reclaimable (safe, read-only)
node dist/index.js scan -n devnet

# 3. Dry run the reclaim (simulates but doesnt execute)
node dist/index.js reclaim --dry-run -n devnet

# 4. Actually reclaim
node dist/index.js reclaim -n devnet

# 5. Check status
node dist/index.js status
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

## Testing on Devnet

```bash
# Get some devnet SOL
solana airdrop 2 --url devnet

# Discover accounts from your fee payer
node dist/index.js discover <fee-payer> --limit 100 -n devnet

# Dry run first
node dist/index.js reclaim --dry-run -v -n devnet

# If it looks good, do it
node dist/index.js reclaim -n devnet

# Check what happened  
node dist/index.js status
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

**Token Accounts (SPL)**
```
closeAccount(
  account,      // the ATA to close
  destination,  // where rent goes (treasury)
  authority     // who can close (operator)
)
```

**System Accounts**
```
transfer(
  from,         // the account
  to,           // treasury  
  lamports      // all of it
)
```

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

## License

MIT

---

Tested on devnet, use on mainnet at your own risk.
