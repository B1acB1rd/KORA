import { database } from './database';
import { configManager } from './config';
import { logger } from './logger';
import { AccountStatus } from './scanner';

export interface SafetyCheckResult {
    allowed: boolean;
    reason?: string;
}

export interface SafetyConfig {
    minIdleDays: number;
    maxReclaimSolPerRun: number;
    requireConfirmation: boolean;
}

class SafetyManager {
    private totalReclaimedThisRun = 0;
    private config: SafetyConfig;

    constructor() {
        var cfg = configManager.get();
        this.config = {
            minIdleDays: cfg.minIdleDays,
            maxReclaimSolPerRun: cfg.maxReclaimSolPerRun,
            requireConfirmation: cfg.network === 'mainnet-beta',
        };
    }

    resetRunState() {
        this.totalReclaimedThisRun = 0;
    }

    // main check function
    async checkAccount(account: AccountStatus): Promise<SafetyCheckResult> {
        // whitelisted = dont touch
        if (await this.isWhitelisted(account.pubkey)) {
            return { allowed: false, reason: 'Account is whitelisted' };
        }

        // programs = no way
        if (account.executable) {
            return { allowed: false, reason: 'Executable program account' };
        }

        // already gone
        if (!account.exists) {
            return { allowed: false, reason: 'Account already closed' };
        }

        // check if been idle long enough
        var idleCheck = await this.checkIdleDuration(account.pubkey);
        if (!idleCheck.allowed) return idleCheck;

        // check if we can still reclaim more
        var limitCheck = this.checkReclaimLimit(account.lamports);
        if (!limitCheck.allowed) return limitCheck;

        return { allowed: true };
    }

    // check idle time
    private async checkIdleDuration(pubkey: string): Promise<SafetyCheckResult> {
        var account = await database.getAccount(pubkey);
        if (!account) return { allowed: true }; // no history = ok
        if (!account.lastChecked) return { allowed: true }; // never checked = ok

        var lastChecked = new Date(account.lastChecked);
        var daysSinceCheck = (Date.now() - lastChecked.getTime()) / (1000 * 60 * 60 * 24);

        if (daysSinceCheck < this.config.minIdleDays) {
            return {
                allowed: false,
                reason: `Account checked ${daysSinceCheck.toFixed(1)} days ago (min: ${this.config.minIdleDays})`
            };
        }

        return { allowed: true };
    }

    // check if we hit the limit
    private checkReclaimLimit(lamports: number): SafetyCheckResult {
        var solAmount = lamports / 1e9;
        var potentialTotal = (this.totalReclaimedThisRun / 1e9) + solAmount;

        if (potentialTotal > this.config.maxReclaimSolPerRun) {
            return {
                allowed: false,
                reason: `Would exceed max reclaim limit (${this.config.maxReclaimSolPerRun} SOL per run)`
            };
        }

        return { allowed: true };
    }

    // record successful reclaim
    recordReclaim(lamports: number) {
        this.totalReclaimedThisRun += lamports;
        logger.debug(`Total reclaimed this run: ${(this.totalReclaimedThisRun / 1e9).toFixed(4)} SOL`);
    }

    // check whitelist
    async isWhitelisted(pubkey: string): Promise<boolean> {
        var dbWhitelisted = await database.isWhitelisted(pubkey);
        return dbWhitelisted || configManager.isWhitelisted(pubkey);
    }

    async addToWhitelist(pubkey: string, reason?: string) {
        await database.addToWhitelist(pubkey, reason);
        configManager.addToWhitelist(pubkey);
        logger.info(`Added ${pubkey} to whitelist${reason ? `: ${reason}` : ''}`);
    }

    async removeFromWhitelist(pubkey: string) {
        await database.removeFromWhitelist(pubkey);
        configManager.removeFromWhitelist(pubkey);
        logger.info(`Removed ${pubkey} from whitelist`);
    }

    async getWhitelist(): Promise<string[]> {
        var dbWhitelist = (await database.getWhitelist()).map(e => e.pubkey);
        var cfgWhitelist = configManager.getWhitelist();
        // merge and dedupe
        return [...new Set([...dbWhitelist, ...cfgWhitelist])];
    }

    // filter accounts by safety rules
    async filterSafeAccounts(accounts: AccountStatus[]): Promise<{ safe: AccountStatus[]; filtered: { account: AccountStatus; reason: string }[] }> {
        var safe: AccountStatus[] = [];
        var filtered: { account: AccountStatus; reason: string }[] = [];

        for (var account of accounts) {
            var check = await this.checkAccount(account);
            if (check.allowed) {
                safe.push(account);
            } else {
                filtered.push({ account, reason: check.reason || 'Unknown' });
            }
        }

        return { safe, filtered };
    }

    // how much can we still reclaim
    getRemainingBudget(): number {
        var maxLamports = this.config.maxReclaimSolPerRun * 1e9;
        return Math.max(0, maxLamports - this.totalReclaimedThisRun);
    }

    // need mainnet confirm?
    requiresConfirmation(): boolean {
        return this.config.requireConfirmation && !configManager.get().dryRun;
    }
}

export const safety = new SafetyManager();
