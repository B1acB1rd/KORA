import { PublicKey, AccountInfo, SystemProgram, Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, AccountLayout } from '@solana/spl-token';
import { config, configManager } from './config';
import { database, SponsoredAccount } from './database';
import { logger } from './logger';

export interface AccountStatus {
    pubkey: string;
    exists: boolean;
    lamports: number;
    owner: string | null;
    dataLength: number;
    executable: boolean;
    isTokenAccount: boolean;
    isReclaimable: boolean;
    skipReason?: string;
    closeAuthority?: string | null;
    operatorCanClose: boolean;
}

export interface ScanResult {
    total: number;
    reclaimable: AccountStatus[];
    skipped: AccountStatus[];
    errors: string[];
}

class Scanner {
    private rateLimitDelay = config.rpcDelayMs;
    private batchSize = config.batchSize;

    // simple delay helper
    private delay(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }

    // main scan function - goes thru all accounts
    async scanAccounts(): Promise<ScanResult> {
        var accounts = await database.getActiveAccounts();
        logger.info(`Scanning ${accounts.length} tracked accounts...`);

        var result: ScanResult = {
            total: accounts.length,
            reclaimable: [],
            skipped: [],
            errors: [],
        };

        // batch processing with getMultipleAccounts
        for (let i = 0; i < accounts.length; i += this.batchSize) {
            var batch = accounts.slice(i, Math.min(i + this.batchSize, accounts.length));
            var batchNum = Math.floor(i / this.batchSize) + 1;
            var totalBatches = Math.ceil(accounts.length / this.batchSize);
            logger.debug(`Processing batch ${batchNum}/${totalBatches}`);

            try {
                var batchResults = await this.scanBatch(batch);

                for (var status of batchResults) {
                    if (status.isReclaimable) {
                        result.reclaimable.push(status);
                    } else {
                        result.skipped.push(status);
                    }
                }
            } catch (error) {
                var errorMsg = error instanceof Error ? error.message : 'Unknown error';
                result.errors.push(`Batch error: ${errorMsg}`);
                logger.error(`Batch scan error: ${errorMsg}`);
            }

            // rate limit
            await this.delay(this.rateLimitDelay);
        }

        logger.info(`Scan complete: ${result.reclaimable.length} reclaimable, ${result.skipped.length} skipped`);
        return result;
    }

    // scan batch using getMultipleAccounts for efficiency
    private async scanBatch(accounts: SponsoredAccount[]): Promise<AccountStatus[]> {
        var pubkeys = accounts.map(a => new PublicKey(a.pubkey));
        var statuses: AccountStatus[] = [];

        try {
            var accountInfos = await config.connection.getMultipleAccountsInfo(pubkeys);

            for (let i = 0; i < accounts.length; i++) {
                var account = accounts[i];
                var info = accountInfos[i];
                var status = await this.analyzeAccount(account.pubkey, info);
                statuses.push(status);

                // update db
                if (!info) {
                    await database.updateAccountStatus(account.pubkey, 'closed', 0);
                } else {
                    await database.updateAccountStatus(account.pubkey, 'active', info.lamports);
                }
            }
        } catch (error) {
            logger.error(`Failed to fetch batch: ${error}`);
            // fallback to single account fetches
            for (var account of accounts) {
                try {
                    var status = await this.scanSingleAccount(account.pubkey);
                    statuses.push(status);
                } catch {
                    // just push a failed status
                    statuses.push({
                        pubkey: account.pubkey,
                        exists: false,
                        lamports: 0,
                        owner: null,
                        dataLength: 0,
                        executable: false,
                        isTokenAccount: false,
                        isReclaimable: false,
                        skipReason: 'Failed to fetch account info',
                        operatorCanClose: false,
                    });
                }
            }
        }

        return statuses;
    }

    // scan single account
    async scanSingleAccount(pubkey: string): Promise<AccountStatus> {
        try {
            var publicKey = new PublicKey(pubkey);
            var info = await config.connection.getAccountInfo(publicKey);
            return await this.analyzeAccount(pubkey, info);
        } catch (error) {
            logger.error(`Failed to scan account ${pubkey}: ${error}`);
            return {
                pubkey,
                exists: false,
                lamports: 0,
                owner: null,
                dataLength: 0,
                executable: false,
                isTokenAccount: false,
                isReclaimable: false,
                skipReason: 'Failed to fetch account info',
                operatorCanClose: false,
            };
        }
    }

    // figure out if account can be reclaimed
    private async analyzeAccount(pubkey: string, info: AccountInfo<Buffer> | null): Promise<AccountStatus> {
        // get operator public key for authority comparison
        var operatorPubkey: PublicKey | null = null;
        try {
            var keypair = configManager.loadOperatorKeypair();
            operatorPubkey = keypair.publicKey;
        } catch {
            logger.debug('Could not load operator keypair for authority check');
        }

        var status: AccountStatus = {
            pubkey,
            exists: info !== null,
            lamports: info?.lamports || 0,
            owner: info?.owner?.toBase58() || null,
            dataLength: info?.data?.length || 0,
            executable: info?.executable || false,
            isTokenAccount: false,
            isReclaimable: false,
            operatorCanClose: false,
            closeAuthority: null,
        };

        // already closed? track for accounting but cant reclaim
        if (!info) {
            status.isReclaimable = false;
            status.skipReason = 'Account already closed';
            // mark as closed in db and track this for accounting
            await database.updateAccountStatus(pubkey, 'closed', 0);
            return status;
        }

        // is it a token account?
        status.isTokenAccount = info.owner.equals(TOKEN_PROGRAM_ID);

        // safety first
        var skipReason = await this.checkSafetyRules(pubkey, info);
        if (skipReason) {
            status.skipReason = skipReason;
            return status;
        }

        // check if reclaimable based on owner and AUTHORITY
        if (info.owner.equals(SystemProgram.programId)) {
            // system account - operator CANNOT close these
            // they require the account's private key, not just fee payer
            status.isReclaimable = false;
            status.operatorCanClose = false;
            status.skipReason = 'System account - operator cannot close (requires account private key)';
        } else if (status.isTokenAccount) {
            // token accounts - need to check closeAuthority
            try {
                // decode the token account to get closeAuthority
                var decoded = AccountLayout.decode(info.data);
                var closeAuthority = decoded.closeAuthorityOption === 1
                    ? new PublicKey(decoded.closeAuthority).toBase58()
                    : new PublicKey(decoded.owner).toBase58(); // default to owner if no closeAuthority set

                status.closeAuthority = closeAuthority;

                // check if operator is the close authority
                if (operatorPubkey && closeAuthority === operatorPubkey.toBase58()) {
                    status.operatorCanClose = true;
                    status.isReclaimable = true;
                    // mark as reclaimable if first time
                    await database.markAsReclaimable(pubkey);
                } else {
                    status.operatorCanClose = false;
                    status.isReclaimable = false;
                    status.skipReason = `Operator is not close authority (authority: ${closeAuthority.slice(0, 8)}...)`;
                    // clear reclaimable state since we cant close it
                    await database.clearReclaimableState(pubkey);
                }

                // update authority info in db
                await database.updateAccountAuthority(pubkey, closeAuthority, status.operatorCanClose);

            } catch (err) {
                status.skipReason = 'Failed to decode token account';
                status.operatorCanClose = false;
            }
        } else {
            // other program owned - needs manual review
            status.skipReason = 'Program-owned account (manual review needed)';
            status.operatorCanClose = false;
        }

        return status;
    }

    // check if account passes safety
    private async checkSafetyRules(pubkey: string, info: AccountInfo<Buffer>): Promise<string | null> {
        // whitelisted?
        var isWhitelisted = await database.isWhitelisted(pubkey);
        if (isWhitelisted || configManager.isWhitelisted(pubkey)) {
            return 'Account is whitelisted';
        }

        // cant touch programs
        if (info.executable) {
            return 'Executable program account';
        }

        // check idle time
        var account = await database.getAccount(pubkey);
        if (account?.lastChecked) {
            var lastChecked = new Date(account.lastChecked);
            var daysSinceCheck = (Date.now() - lastChecked.getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceCheck < config.minIdleDays) {
                return `Account active within last ${config.minIdleDays} days`;
            }
        }

        return null;
    }

    // get accounts we havent checked in a while
    async getStaleAccounts(days: number = 7): Promise<SponsoredAccount[]> {
        var accounts = await database.getActiveAccounts();
        var staleDate = new Date();
        staleDate.setDate(staleDate.getDate() - days);

        return accounts.filter(account => {
            if (!account.lastChecked) return true;
            return new Date(account.lastChecked) < staleDate;
        });
    }
}

export const scanner = new Scanner();
