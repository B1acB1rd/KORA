import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { config } from './config';

export interface SponsoredAccount {
    id?: number;
    pubkey: string;
    programOwner: string | null;
    sponsorSignature: string | null;
    lamports: number;
    createdAt: string;
    lastChecked: string | null;
    status: 'active' | 'closed' | 'reclaimed' | 'skipped';
    reclaimableSince: string | null;
    closeAuthority: string | null;
    operatorCanClose: boolean;
}

export interface ReclaimHistoryEntry {
    id?: number;
    pubkey: string;
    lamportsReclaimed: number;
    status: 'success' | 'failed' | 'skipped';
    reason: string | null;
    txSignature: string | null;
    timestamp: string;
}

export interface WhitelistEntry {
    id?: number;
    pubkey: string;
    reason: string | null;
    addedAt: string;
}

class DatabaseManager {
    private db: SqlJsDatabase | null = null;
    private dbPath: string;
    private initialized = false;

    constructor() {
        this.dbPath = path.resolve(config.databasePath);
    }

    private async getDb(): Promise<SqlJsDatabase> {
        if (!this.db) {
            // Try to locate WASM file for sql.js
            // This handles both normal Node.js execution and pkg-bundled binary
            let wasmPath: string | undefined;

            // Common locations to check for the WASM file
            const possiblePaths = [
                // In node_modules (normal development)
                path.join(__dirname, '../node_modules/sql.js/dist/sql-wasm.wasm'),
                path.join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'),
                // pkg snapshot filesystem
                path.join(path.dirname(process.execPath), 'sql-wasm.wasm'),
            ];

            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    wasmPath = p;
                    break;
                }
            }

            // Initialize sql.js - it will use built-in WASM if path not found
            const SQL = await initSqlJs(wasmPath ? { locateFile: () => wasmPath! } : undefined);
            const dbDir = path.dirname(this.dbPath);

            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            // load or create db
            if (fs.existsSync(this.dbPath)) {
                const buffer = fs.readFileSync(this.dbPath);
                this.db = new SQL.Database(buffer);
            } else {
                this.db = new SQL.Database();
            }

            if (!this.initialized) {
                this.initialize();
                this.initialized = true;
            }
        }
        return this.db;
    }

    private initialize() {
        const db = this.db!;

        // accounts table
        db.run(`
      CREATE TABLE IF NOT EXISTS sponsored_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pubkey TEXT UNIQUE NOT NULL,
        program_owner TEXT,
        sponsor_signature TEXT,
        lamports INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_checked DATETIME,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'closed', 'reclaimed', 'skipped')),
        reclaimable_since DATETIME,
        close_authority TEXT,
        operator_can_close INTEGER DEFAULT 0
      )
    `);

        // run migrations for existing databases
        this.runMigrations(db);

        // history table
        db.run(`
      CREATE TABLE IF NOT EXISTS reclaim_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pubkey TEXT NOT NULL,
        lamports_reclaimed INTEGER,
        status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'skipped')),
        reason TEXT,
        tx_signature TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // whitelist table
        db.run(`
      CREATE TABLE IF NOT EXISTS whitelist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pubkey TEXT UNIQUE NOT NULL,
        reason TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

        // indexes for faster queries
        db.run(`CREATE INDEX IF NOT EXISTS idx_accounts_status ON sponsored_accounts(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_accounts_pubkey ON sponsored_accounts(pubkey)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_history_pubkey ON reclaim_history(pubkey)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_whitelist_pubkey ON whitelist(pubkey)`);

        this.save();
    }

    // run schema migrations for existing databases
    private runMigrations(db: SqlJsDatabase) {
        // check if new columns exist, add them if not
        try {
            const tableInfo = db.exec("PRAGMA table_info(sponsored_accounts)");
            if (tableInfo.length > 0) {
                const columns = tableInfo[0].values.map(row => row[1] as string);

                if (!columns.includes('reclaimable_since')) {
                    db.run("ALTER TABLE sponsored_accounts ADD COLUMN reclaimable_since DATETIME");
                }
                if (!columns.includes('close_authority')) {
                    db.run("ALTER TABLE sponsored_accounts ADD COLUMN close_authority TEXT");
                }
                if (!columns.includes('operator_can_close')) {
                    db.run("ALTER TABLE sponsored_accounts ADD COLUMN operator_can_close INTEGER DEFAULT 0");
                }
            }
        } catch (err) {
            // table might not exist yet, thats ok
        }
    }

    private save() {
        if (this.db) {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            fs.writeFileSync(this.dbPath, buffer);
        }
    }

    // add single account
    async addAccount(account: Omit<SponsoredAccount, 'id'>) {
        const db = await this.getDb();
        db.run(`
      INSERT OR REPLACE INTO sponsored_accounts 
      (pubkey, program_owner, sponsor_signature, lamports, created_at, last_checked, status, reclaimable_since, close_authority, operator_can_close)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            account.pubkey,
            account.programOwner,
            account.sponsorSignature,
            account.lamports,
            account.createdAt,
            account.lastChecked,
            account.status,
            account.reclaimableSince,
            account.closeAuthority,
            account.operatorCanClose ? 1 : 0
        ]);
        this.save();
    }

    // bulk add
    async addAccountsBatch(accounts: Omit<SponsoredAccount, 'id'>[]) {
        const db = await this.getDb();

        for (const account of accounts) {
            db.run(`
        INSERT OR REPLACE INTO sponsored_accounts 
        (pubkey, program_owner, sponsor_signature, lamports, created_at, last_checked, status, reclaimable_since, close_authority, operator_can_close)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
                account.pubkey,
                account.programOwner,
                account.sponsorSignature,
                account.lamports,
                account.createdAt,
                account.lastChecked,
                account.status,
                account.reclaimableSince,
                account.closeAuthority,
                account.operatorCanClose ? 1 : 0
            ]);
        }
        this.save();
    }

    // helper to safely escape strings for sql.js queries
    // sql.js exec() doesn't support parameterized queries, so we escape manually
    private escapeString(str: string): string {
        return str.replace(/'/g, "''");
    }

    async getAccount(pubkey: string): Promise<SponsoredAccount | null> {
        const db = await this.getDb();
        const escapedPubkey = this.escapeString(pubkey);
        const result = db.exec(`SELECT * FROM sponsored_accounts WHERE pubkey = '${escapedPubkey}'`);
        if (result.length === 0 || result[0].values.length === 0) {
            return null;
        }
        return this.mapToSponsoredAccount(result[0].columns, result[0].values[0]);
    }

    async getAllAccounts(): Promise<SponsoredAccount[]> {
        const db = await this.getDb();
        const result = db.exec('SELECT * FROM sponsored_accounts');
        if (result.length === 0) return [];
        return result[0].values.map(row => this.mapToSponsoredAccount(result[0].columns, row));
    }

    async getActiveAccounts(): Promise<SponsoredAccount[]> {
        const db = await this.getDb();
        const result = db.exec("SELECT * FROM sponsored_accounts WHERE status = 'active'");
        if (result.length === 0) return [];
        return result[0].values.map(row => this.mapToSponsoredAccount(result[0].columns, row));
    }

    async updateAccountStatus(pubkey: string, status: SponsoredAccount['status'], lamports?: number) {
        const db = await this.getDb();
        if (lamports !== undefined) {
            db.run(`
        UPDATE sponsored_accounts 
        SET status = ?, lamports = ?, last_checked = datetime('now')
        WHERE pubkey = ?
      `, [status, lamports, pubkey]);
        } else {
            db.run(`
        UPDATE sponsored_accounts 
        SET status = ?, last_checked = datetime('now')
        WHERE pubkey = ?
      `, [status, pubkey]);
        }
        this.save();
    }

    // update authority info for an account
    async updateAccountAuthority(pubkey: string, closeAuthority: string | null, operatorCanClose: boolean) {
        const db = await this.getDb();
        db.run(`
      UPDATE sponsored_accounts 
      SET close_authority = ?, operator_can_close = ?
      WHERE pubkey = ?
    `, [closeAuthority, operatorCanClose ? 1 : 0, pubkey]);
        this.save();
    }

    // mark account as reclaimable (first time it becomes empty/closeable)
    async markAsReclaimable(pubkey: string) {
        const db = await this.getDb();
        // only set reclaimable_since if its not already set
        db.run(`
      UPDATE sponsored_accounts 
      SET reclaimable_since = datetime('now')
      WHERE pubkey = ? AND reclaimable_since IS NULL
    `, [pubkey]);
        this.save();
    }

    // clear reclaimable state (account became active again)
    async clearReclaimableState(pubkey: string) {
        const db = await this.getDb();
        db.run(`
      UPDATE sponsored_accounts 
      SET reclaimable_since = NULL
      WHERE pubkey = ?
    `, [pubkey]);
        this.save();
    }

    async getAccountCount(): Promise<{ total: number; active: number; closed: number; reclaimed: number }> {
        const db = await this.getDb();

        function getCount(query: string): number {
            const result = db.exec(query);
            if (result.length === 0 || result[0].values.length === 0) return 0;
            return Number(result[0].values[0][0]) || 0;
        }

        return {
            total: getCount('SELECT COUNT(*) FROM sponsored_accounts'),
            active: getCount("SELECT COUNT(*) FROM sponsored_accounts WHERE status = 'active'"),
            closed: getCount("SELECT COUNT(*) FROM sponsored_accounts WHERE status = 'closed'"),
            reclaimed: getCount("SELECT COUNT(*) FROM sponsored_accounts WHERE status = 'reclaimed'"),
        };
    }

    private mapToSponsoredAccount(columns: string[], row: unknown[]): SponsoredAccount {
        const obj: Record<string, unknown> = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });

        return {
            id: obj.id as number,
            pubkey: obj.pubkey as string,
            programOwner: obj.program_owner as string | null,
            sponsorSignature: obj.sponsor_signature as string | null,
            lamports: obj.lamports as number,
            createdAt: obj.created_at as string,
            lastChecked: obj.last_checked as string | null,
            status: obj.status as SponsoredAccount['status'],
            reclaimableSince: obj.reclaimable_since as string | null,
            closeAuthority: obj.close_authority as string | null,
            operatorCanClose: Boolean(obj.operator_can_close),
        };
    }

    // history stuff
    async addReclaimHistory(entry: Omit<ReclaimHistoryEntry, 'id' | 'timestamp'>) {
        const db = await this.getDb();
        db.run(`
      INSERT INTO reclaim_history (pubkey, lamports_reclaimed, status, reason, tx_signature)
      VALUES (?, ?, ?, ?, ?)
    `, [entry.pubkey, entry.lamportsReclaimed, entry.status, entry.reason, entry.txSignature]);
        this.save();
    }

    async getReclaimHistory(limit = 100): Promise<ReclaimHistoryEntry[]> {
        const db = await this.getDb();
        const result = db.exec(`SELECT * FROM reclaim_history ORDER BY timestamp DESC LIMIT ${limit}`);
        if (result.length === 0) return [];

        return result[0].values.map(row => {
            const obj: Record<string, unknown> = {};
            result[0].columns.forEach((col, i) => { obj[col] = row[i]; });
            return {
                id: obj.id as number,
                pubkey: obj.pubkey as string,
                lamportsReclaimed: obj.lamports_reclaimed as number,
                status: obj.status as ReclaimHistoryEntry['status'],
                reason: obj.reason as string | null,
                txSignature: obj.tx_signature as string | null,
                timestamp: obj.timestamp as string,
            };
        });
    }

    async getTotalReclaimed(): Promise<number> {
        const db = await this.getDb();
        const result = db.exec("SELECT SUM(lamports_reclaimed) as total FROM reclaim_history WHERE status = 'success'");
        if (result.length === 0 || result[0].values.length === 0) return 0;
        return Number(result[0].values[0][0]) || 0;
    }

    // whitelist methods
    async addToWhitelist(pubkey: string, reason?: string) {
        const db = await this.getDb();
        db.run('INSERT OR IGNORE INTO whitelist (pubkey, reason) VALUES (?, ?)', [pubkey, reason || null]);
        this.save();
    }

    async removeFromWhitelist(pubkey: string) {
        const db = await this.getDb();
        db.run('DELETE FROM whitelist WHERE pubkey = ?', [pubkey]);
        this.save();
    }

    async isWhitelisted(pubkey: string): Promise<boolean> {
        const db = await this.getDb();
        const escapedPubkey = this.escapeString(pubkey);
        const result = db.exec(`SELECT 1 FROM whitelist WHERE pubkey = '${escapedPubkey}'`);
        return result.length > 0 && result[0].values.length > 0;
    }

    async getWhitelist(): Promise<WhitelistEntry[]> {
        const db = await this.getDb();
        const result = db.exec('SELECT * FROM whitelist');
        if (result.length === 0) return [];

        return result[0].values.map(row => {
            const obj: Record<string, unknown> = {};
            result[0].columns.forEach((col, i) => { obj[col] = row[i]; });
            return {
                id: obj.id as number,
                pubkey: obj.pubkey as string,
                reason: obj.reason as string | null,
                addedAt: obj.added_at as string,
            };
        });
    }

    close() {
        if (this.db) {
            this.save();
            this.db.close();
            this.db = null;
        }
    }
}

export const database = new DatabaseManager();
