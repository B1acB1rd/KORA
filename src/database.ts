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
            var SQL = await initSqlJs();
            var dbDir = path.dirname(this.dbPath);

            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            // load or create db
            if (fs.existsSync(this.dbPath)) {
                var buffer = fs.readFileSync(this.dbPath);
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
        var db = this.db!;

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
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'closed', 'reclaimed', 'skipped'))
      )
    `);

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

    private save() {
        if (this.db) {
            var data = this.db.export();
            var buffer = Buffer.from(data);
            fs.writeFileSync(this.dbPath, buffer);
        }
    }

    // add single account
    async addAccount(account: Omit<SponsoredAccount, 'id'>) {
        var db = await this.getDb();
        db.run(`
      INSERT OR REPLACE INTO sponsored_accounts 
      (pubkey, program_owner, sponsor_signature, lamports, created_at, last_checked, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
            account.pubkey,
            account.programOwner,
            account.sponsorSignature,
            account.lamports,
            account.createdAt,
            account.lastChecked,
            account.status
        ]);
        this.save();
    }

    // bulk add
    async addAccountsBatch(accounts: Omit<SponsoredAccount, 'id'>[]) {
        var db = await this.getDb();

        for (var account of accounts) {
            db.run(`
        INSERT OR REPLACE INTO sponsored_accounts 
        (pubkey, program_owner, sponsor_signature, lamports, created_at, last_checked, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
                account.pubkey,
                account.programOwner,
                account.sponsorSignature,
                account.lamports,
                account.createdAt,
                account.lastChecked,
                account.status
            ]);
        }
        this.save();
    }

    async getAccount(pubkey: string): Promise<SponsoredAccount | null> {
        var db = await this.getDb();
        var result = db.exec('SELECT * FROM sponsored_accounts WHERE pubkey = ?', [pubkey]);
        if (result.length === 0 || result[0].values.length === 0) {
            return null;
        }
        return this.mapToSponsoredAccount(result[0].columns, result[0].values[0]);
    }

    async getAllAccounts(): Promise<SponsoredAccount[]> {
        var db = await this.getDb();
        var result = db.exec('SELECT * FROM sponsored_accounts');
        if (result.length === 0) return [];
        return result[0].values.map(row => this.mapToSponsoredAccount(result[0].columns, row));
    }

    async getActiveAccounts(): Promise<SponsoredAccount[]> {
        var db = await this.getDb();
        var result = db.exec("SELECT * FROM sponsored_accounts WHERE status = 'active'");
        if (result.length === 0) return [];
        return result[0].values.map(row => this.mapToSponsoredAccount(result[0].columns, row));
    }

    async updateAccountStatus(pubkey: string, status: SponsoredAccount['status'], lamports?: number) {
        var db = await this.getDb();
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

    async getAccountCount(): Promise<{ total: number; active: number; closed: number; reclaimed: number }> {
        var db = await this.getDb();

        function getCount(query: string): number {
            var result = db.exec(query);
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
        var obj: Record<string, unknown> = {};
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
        };
    }

    // history stuff
    async addReclaimHistory(entry: Omit<ReclaimHistoryEntry, 'id' | 'timestamp'>) {
        var db = await this.getDb();
        db.run(`
      INSERT INTO reclaim_history (pubkey, lamports_reclaimed, status, reason, tx_signature)
      VALUES (?, ?, ?, ?, ?)
    `, [entry.pubkey, entry.lamportsReclaimed, entry.status, entry.reason, entry.txSignature]);
        this.save();
    }

    async getReclaimHistory(limit = 100): Promise<ReclaimHistoryEntry[]> {
        var db = await this.getDb();
        var result = db.exec(`SELECT * FROM reclaim_history ORDER BY timestamp DESC LIMIT ${limit}`);
        if (result.length === 0) return [];

        return result[0].values.map(row => {
            var obj: Record<string, unknown> = {};
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
        var db = await this.getDb();
        var result = db.exec("SELECT SUM(lamports_reclaimed) as total FROM reclaim_history WHERE status = 'success'");
        if (result.length === 0 || result[0].values.length === 0) return 0;
        return Number(result[0].values[0][0]) || 0;
    }

    // whitelist methods
    async addToWhitelist(pubkey: string, reason?: string) {
        var db = await this.getDb();
        db.run('INSERT OR IGNORE INTO whitelist (pubkey, reason) VALUES (?, ?)', [pubkey, reason || null]);
        this.save();
    }

    async removeFromWhitelist(pubkey: string) {
        var db = await this.getDb();
        db.run('DELETE FROM whitelist WHERE pubkey = ?', [pubkey]);
        this.save();
    }

    async isWhitelisted(pubkey: string): Promise<boolean> {
        var db = await this.getDb();
        var result = db.exec('SELECT 1 FROM whitelist WHERE pubkey = ?', [pubkey]);
        return result.length > 0 && result[0].values.length > 0;
    }

    async getWhitelist(): Promise<WhitelistEntry[]> {
        var db = await this.getDb();
        var result = db.exec('SELECT * FROM whitelist');
        if (result.length === 0) return [];

        return result[0].values.map(row => {
            var obj: Record<string, unknown> = {};
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
