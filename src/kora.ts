import fs from 'fs';
import path from 'path';
import { database, SponsoredAccount } from './database';
import { logger } from './logger';
import { PublicKey, ConfirmedSignatureInfo } from '@solana/web3.js';
import { config } from './config';

export interface KoraTransaction {
    signature: string;
    slot: number;
    blockTime: number | null;
    accounts: string[];
}

export interface ImportedAccount {
    pubkey: string;
    programOwner?: string;
    sponsorSignature?: string;
    createdAt?: string;
}

class KoraParser {
    // import from json file
    async importFromFile(filePath: string): Promise<number> {
        var absolutePath = path.resolve(filePath);

        if (!fs.existsSync(absolutePath)) {
            throw new Error(`File not found: ${absolutePath}`);
        }

        var content = fs.readFileSync(absolutePath, 'utf-8');
        var data: ImportedAccount[];

        try {
            data = JSON.parse(content);
        } catch {
            throw new Error('Invalid JSON file format');
        }

        if (!Array.isArray(data)) {
            throw new Error('JSON file must contain an array of accounts');
        }

        var accounts: Omit<SponsoredAccount, 'id'>[] = [];
        var now = new Date().toISOString();

        for (var item of data) {
            if (!item.pubkey) {
                logger.warn('Skipping entry without pubkey');
                continue;
            }

            // validate pubkey
            try {
                new PublicKey(item.pubkey);
            } catch {
                logger.warn(`Invalid pubkey format: ${item.pubkey}`);
                continue;
            }

            accounts.push({
                pubkey: item.pubkey,
                programOwner: item.programOwner || null,
                sponsorSignature: item.sponsorSignature || null,
                lamports: 0,
                createdAt: item.createdAt || now,
                lastChecked: null,
                status: 'active',
            });
        }

        if (accounts.length > 0) {
            await database.addAccountsBatch(accounts);
            logger.success(`Imported ${accounts.length} accounts`);
        }

        return accounts.length;
    }

    // parse kora logs - mostly placeholder
    // TODO: update when we know actual log format
    async parseKoraLogs(logPath: string): Promise<number> {
        logger.info(`Parsing Kora logs from: ${logPath}`);

        if (!fs.existsSync(logPath)) {
            throw new Error(`Log file not found: ${logPath}`);
        }

        var content = fs.readFileSync(logPath, 'utf-8');
        var lines = content.split('\n');
        var accounts: Omit<SponsoredAccount, 'id'>[] = [];
        var now = new Date().toISOString();

        // patterns for finding sponsored accounts
        // might need to adjust these based on actual logs
        var sponsorPattern = /sponsored.*account.*([1-9A-HJ-NP-Za-km-z]{32,44})/i;
        var sigPattern = /signature[:\s]+([1-9A-HJ-NP-Za-km-z]{87,88})/i;

        for (var line of lines) {
            var accountMatch = line.match(sponsorPattern);
            if (accountMatch) {
                var pubkey = accountMatch[1];
                var sigMatch = line.match(sigPattern);

                accounts.push({
                    pubkey,
                    programOwner: null,
                    sponsorSignature: sigMatch ? sigMatch[1] : null,
                    lamports: 0,
                    createdAt: now,
                    lastChecked: null,
                    status: 'active',
                });
            }
        }

        if (accounts.length > 0) {
            await database.addAccountsBatch(accounts);
            logger.success(`Parsed ${accounts.length} accounts from logs`);
        }

        return accounts.length;
    }

    // discover from fee payer txs
    async discoverFromFeePayer(feePayerAddress: string, limit = 1000): Promise<number> {
        logger.info(`Discovering accounts from fee payer: ${feePayerAddress}`);

        var feePayer = new PublicKey(feePayerAddress);
        var signatures: ConfirmedSignatureInfo[] = [];

        try {
            signatures = await config.connection.getSignaturesForAddress(feePayer, { limit });
        } catch (err) {
            throw new Error(`Failed to fetch signatures: ${err}`);
        }

        logger.info(`Found ${signatures.length} transactions to analyze`);

        var discoveredAccounts = new Set<string>();
        var accounts: Omit<SponsoredAccount, 'id'>[] = [];

        for (var sig of signatures) {
            try {
                var tx = await config.connection.getTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0,
                });

                if (!tx?.meta?.postBalances || !tx?.transaction?.message) continue;

                var message = tx.transaction.message;

                // handle both legacy and v0 txs
                var accountKeys: PublicKey[];
                if ('staticAccountKeys' in message) {
                    accountKeys = message.staticAccountKeys;
                } else if ('accountKeys' in message) {
                    accountKeys = (message as { accountKeys: PublicKey[] }).accountKeys;
                } else {
                    continue;
                }

                var preBalances = tx.meta.preBalances;
                var postBalances = tx.meta.postBalances;

                for (let i = 0; i < accountKeys.length; i++) {
                    var pubkey = accountKeys[i].toBase58();

                    // skip fee payer
                    if (pubkey === feePayerAddress) continue;

                    // newly funded account?
                    if (preBalances[i] === 0 && postBalances[i] > 0) {
                        if (!discoveredAccounts.has(pubkey)) {
                            discoveredAccounts.add(pubkey);
                            accounts.push({
                                pubkey,
                                programOwner: null,
                                sponsorSignature: sig.signature,
                                lamports: postBalances[i],
                                createdAt: sig.blockTime
                                    ? new Date(sig.blockTime * 1000).toISOString()
                                    : new Date().toISOString(),
                                lastChecked: null,
                                status: 'active',
                            });
                        }
                    }
                }
            } catch (err) {
                logger.debug(`Failed to process tx ${sig.signature}: ${err}`);
            }
        }

        if (accounts.length > 0) {
            await database.addAccountsBatch(accounts);
            logger.success(`Discovered ${accounts.length} sponsored accounts`);
        }

        return accounts.length;
    }

    // export to json
    async exportAccounts(outputPath: string) {
        var accounts = await database.getAllAccounts();
        var exportData = accounts.map(a => ({
            pubkey: a.pubkey,
            programOwner: a.programOwner,
            sponsorSignature: a.sponsorSignature,
            lamports: a.lamports,
            createdAt: a.createdAt,
            status: a.status,
        }));

        fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));
        logger.success(`Exported ${accounts.length} accounts to ${outputPath}`);
    }

    // add single account manually
    async addAccount(pubkey: string, programOwner?: string, sponsorSig?: string) {
        // validate
        try {
            new PublicKey(pubkey);
        } catch {
            throw new Error(`Invalid pubkey format: ${pubkey}`);
        }

        await database.addAccount({
            pubkey,
            programOwner: programOwner || null,
            sponsorSignature: sponsorSig || null,
            lamports: 0,
            createdAt: new Date().toISOString(),
            lastChecked: null,
            status: 'active',
        });

        logger.success(`Added account: ${pubkey}`);
    }

    // stats
    async getStats(): Promise<{ total: number; active: number; closed: number; reclaimed: number; totalLamports: number }> {
        var counts = await database.getAccountCount();
        var accounts = await database.getAllAccounts();
        var totalLamports = accounts.reduce((sum, a) => sum + a.lamports, 0);

        return { ...counts, totalLamports };
    }
}

export const kora = new KoraParser();
