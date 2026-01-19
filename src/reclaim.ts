import {
    PublicKey,
    Transaction,
    SystemProgram,
    sendAndConfirmTransaction,
    TransactionInstruction,
    Keypair,
} from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    createCloseAccountInstruction,
    getAccount,
    TokenAccountNotFoundError,
} from '@solana/spl-token';
import { config, configManager } from './config';
import { database } from './database';
import { logger, ReclaimLogEntry } from './logger';
import { safety } from './safety';
import { AccountStatus } from './scanner';

export interface ReclaimResult {
    pubkey: string;
    success: boolean;
    lamportsReclaimed: number;
    txSignature?: string;
    error?: string;
}

export interface BatchReclaimResult {
    successful: ReclaimResult[];
    failed: ReclaimResult[];
    totalLamportsReclaimed: number;
}

// constants
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const MAX_INSTRUCTIONS = 10; // per tx

class ReclaimEngine {
    private operatorKeypair: Keypair | null = null;

    private async getOperatorKeypair(): Promise<Keypair> {
        if (!this.operatorKeypair) {
            this.operatorKeypair = configManager.loadOperatorKeypair();
        }
        return this.operatorKeypair;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }

    // main reclaim function
    async reclaimAccounts(accounts: AccountStatus[]): Promise<BatchReclaimResult> {
        var result: BatchReclaimResult = {
            successful: [],
            failed: [],
            totalLamportsReclaimed: 0,
        };

        if (accounts.length === 0) {
            logger.info('No accounts to reclaim');
            return result;
        }

        var dryRun = configManager.get().dryRun;
        var treasuryAddr = configManager.get().treasuryAddress;

        if (!treasuryAddr) {
            throw new Error('Treasury address not configured');
        }

        var treasury = new PublicKey(treasuryAddr);
        logger.info(`${dryRun ? '[DRY RUN] ' : ''}Processing ${accounts.length} accounts for reclaim`);

        // batch em up
        var batches = this.createBatches(accounts, MAX_INSTRUCTIONS);
        logger.debug(`Created ${batches.length} transaction batches`);

        for (let i = 0; i < batches.length; i++) {
            var batch = batches[i];
            logger.debug(`Processing batch ${i + 1}/${batches.length} (${batch.length} accounts)`);

            try {
                var batchResult = await this.processBatch(batch, treasury, dryRun);
                result.successful.push(...batchResult.successful);
                result.failed.push(...batchResult.failed);
                result.totalLamportsReclaimed += batchResult.totalLamportsReclaimed;
            } catch (error) {
                var errorMsg = error instanceof Error ? error.message : 'Unknown error';
                logger.error(`Batch ${i + 1} failed: ${errorMsg}`);

                // mark all as failed
                for (var account of batch) {
                    result.failed.push({
                        pubkey: account.pubkey,
                        success: false,
                        lamportsReclaimed: 0,
                        error: errorMsg,
                    });
                }
            }

            // check budget
            if (safety.getRemainingBudget() <= 0) {
                logger.warn('Reclaim limit reached, stopping');
                break;
            }
        }

        return result;
    }

    // process single batch
    private async processBatch(accounts: AccountStatus[], treasury: PublicKey, dryRun: boolean): Promise<BatchReclaimResult> {
        var result: BatchReclaimResult = {
            successful: [],
            failed: [],
            totalLamportsReclaimed: 0,
        };

        var operator = await this.getOperatorKeypair();
        var instructions: TransactionInstruction[] = [];
        var accountsInTx: AccountStatus[] = [];

        for (var account of accounts) {
            // double check safety
            var safetyCheck = await safety.checkAccount(account);
            if (!safetyCheck.allowed) {
                result.failed.push({
                    pubkey: account.pubkey,
                    success: false,
                    lamportsReclaimed: 0,
                    error: safetyCheck.reason,
                });
                this.logEntry(account.pubkey, 'skipped', 0, safetyCheck.reason);
                continue;
            }

            try {
                var ix = await this.createCloseInstruction(account, operator.publicKey, treasury);
                if (ix) {
                    instructions.push(ix);
                    accountsInTx.push(account);
                } else {
                    result.failed.push({
                        pubkey: account.pubkey,
                        success: false,
                        lamportsReclaimed: 0,
                        error: 'Could not create close instruction',
                    });
                }
            } catch (err) {
                var errMsg = err instanceof Error ? err.message : 'Unknown error';
                result.failed.push({
                    pubkey: account.pubkey,
                    success: false,
                    lamportsReclaimed: 0,
                    error: errMsg,
                });
            }
        }

        if (instructions.length === 0) return result;

        if (dryRun) {
            // just simulate
            for (var acc of accountsInTx) {
                logger.success(`[DRY RUN] Would reclaim ${(acc.lamports / 1e9).toFixed(6)} SOL from ${acc.pubkey}`);
                result.successful.push({
                    pubkey: acc.pubkey,
                    success: true,
                    lamportsReclaimed: acc.lamports,
                });
                result.totalLamportsReclaimed += acc.lamports;
                this.logEntry(acc.pubkey, 'reclaimed', acc.lamports, undefined, 'DRY_RUN');
            }
            return result;
        }

        // actually send it
        var txResult = await this.executeWithRetry(instructions, operator);

        if (txResult.success) {
            for (var acc of accountsInTx) {
                result.successful.push({
                    pubkey: acc.pubkey,
                    success: true,
                    lamportsReclaimed: acc.lamports,
                    txSignature: txResult.signature,
                });
                result.totalLamportsReclaimed += acc.lamports;
                safety.recordReclaim(acc.lamports);
                await database.updateAccountStatus(acc.pubkey, 'reclaimed');
                await database.addReclaimHistory({
                    pubkey: acc.pubkey,
                    lamportsReclaimed: acc.lamports,
                    status: 'success',
                    reason: null,
                    txSignature: txResult.signature || null,
                });
                this.logEntry(acc.pubkey, 'reclaimed', acc.lamports, undefined, txResult.signature);
                logger.success(`Reclaimed ${(acc.lamports / 1e9).toFixed(6)} SOL from ${acc.pubkey}`);
            }
        } else {
            for (var acc of accountsInTx) {
                result.failed.push({
                    pubkey: acc.pubkey,
                    success: false,
                    lamportsReclaimed: 0,
                    error: txResult.error,
                });
                await database.addReclaimHistory({
                    pubkey: acc.pubkey,
                    lamportsReclaimed: 0,
                    status: 'failed',
                    reason: txResult.error || 'Transaction failed',
                    txSignature: null,
                });
                this.logEntry(acc.pubkey, 'failed', 0, txResult.error);
            }
        }

        return result;
    }

    // create the close instruction
    private async createCloseInstruction(account: AccountStatus, authority: PublicKey, destination: PublicKey): Promise<TransactionInstruction | null> {
        var accountPubkey = new PublicKey(account.pubkey);

        if (account.isTokenAccount) {
            // token account - check balance first
            try {
                var tokenAccount = await getAccount(config.connection, accountPubkey);
                if (tokenAccount.amount > 0n) {
                    logger.warn(`Token account ${account.pubkey} has non-zero balance, skipping`);
                    return null;
                }
                return createCloseAccountInstruction(accountPubkey, destination, authority);
            } catch (err) {
                if (err instanceof TokenAccountNotFoundError) {
                    logger.debug(`Token account ${account.pubkey} not found or already closed`);
                    return null;
                }
                throw err;
            }
        } else if (account.owner === SystemProgram.programId.toBase58()) {
            // system account - just transfer
            return SystemProgram.transfer({
                fromPubkey: accountPubkey,
                toPubkey: destination,
                lamports: account.lamports,
            });
        }

        return null;
    }

    // retry logic with backoff
    private async executeWithRetry(instructions: TransactionInstruction[], signer: Keypair): Promise<{ success: boolean; signature?: string; error?: string }> {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                var tx = new Transaction().add(...instructions);

                var signature = await sendAndConfirmTransaction(
                    config.connection,
                    tx,
                    [signer],
                    { commitment: 'confirmed', maxRetries: 3 }
                );

                logger.debug(`Transaction confirmed: ${signature}`);
                return { success: true, signature };
            } catch (err) {
                var errMsg = err instanceof Error ? err.message : 'Unknown error';
                logger.warn(`Attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg}`);

                if (attempt < MAX_RETRIES) {
                    var delay = RETRY_DELAY * Math.pow(2, attempt - 1);
                    logger.debug(`Retrying in ${delay}ms...`);
                    await this.delay(delay);
                } else {
                    return { success: false, error: errMsg };
                }
            }
        }

        return { success: false, error: 'Max retries exceeded' };
    }

    // batch helper
    private createBatches(accounts: AccountStatus[], maxPerBatch: number): AccountStatus[][] {
        var batches: AccountStatus[][] = [];
        for (let i = 0; i < accounts.length; i += maxPerBatch) {
            batches.push(accounts.slice(i, Math.min(i + maxPerBatch, accounts.length)));
        }
        return batches;
    }

    // reclaim just one
    async reclaimSingle(pubkey: string): Promise<ReclaimResult> {
        var result = await this.reclaimAccounts([{
            pubkey,
            exists: true,
            lamports: 0,
            owner: null,
            dataLength: 0,
            executable: false,
            isTokenAccount: false,
            isReclaimable: true,
        }]);

        if (result.successful.length > 0) return result.successful[0];
        if (result.failed.length > 0) return result.failed[0];

        return { pubkey, success: false, lamportsReclaimed: 0, error: 'No result' };
    }

    private logEntry(pubkey: string, status: 'reclaimed' | 'skipped' | 'failed', lamports: number, reason?: string, txSig?: string) {
        var entry: ReclaimLogEntry = {
            pubkey,
            status,
            lamports,
            reason,
            txSignature: txSig,
            timestamp: new Date().toISOString(),
        };
        logger.addReclaimEntry(entry);
    }
}

export const reclaim = new ReclaimEngine();
