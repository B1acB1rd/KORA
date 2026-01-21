import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { Keypair, Connection, clusterApiUrl, Cluster, PublicKey } from '@solana/web3.js';

dotenv.config();

export interface Config {
    // network stuff
    rpcUrl: string;
    network: 'devnet' | 'mainnet-beta';
    connection: Connection;

    // wallet
    walletPath: string;
    treasuryAddress: string;
    operatorKeypair?: Keypair;

    // safety limits
    minIdleDays: number;
    maxReclaimSolPerRun: number;

    // rate limits
    rpcDelayMs: number;
    maxConcurrentRequests: number;
    batchSize: number;

    // telegram alerts
    telegramBotToken?: string;
    telegramChatId?: string;
    alertThresholdSol: number;

    // db
    databasePath: string;

    // flags
    dryRun: boolean;
    verbose: boolean;
}

class ConfigManager {
    private config: Config;
    private whitelist: Set<string> = new Set();

    constructor() {
        var network = (process.env.NETWORK || 'devnet') as Cluster;
        var rpcUrl = process.env.RPC_URL || clusterApiUrl(network);

        this.config = {
            rpcUrl,
            network: network as 'devnet' | 'mainnet-beta',
            connection: new Connection(rpcUrl, 'confirmed'),

            walletPath: process.env.WALLET_PATH || './wallet/operator.json',
            treasuryAddress: process.env.TREASURY_ADDRESS || '',

            minIdleDays: parseInt(process.env.MIN_IDLE_DAYS || '7', 10),
            maxReclaimSolPerRun: parseFloat(process.env.MAX_RECLAIM_SOL_PER_RUN || '10'),

            rpcDelayMs: parseInt(process.env.RPC_DELAY_MS || '100', 10),
            maxConcurrentRequests: parseInt(process.env.MAX_CONCURRENT_REQUESTS || '10', 10),
            batchSize: parseInt(process.env.BATCH_SIZE || '100', 10),

            telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
            telegramChatId: process.env.TELEGRAM_CHAT_ID,
            alertThresholdSol: parseFloat(process.env.ALERT_THRESHOLD_SOL || '1.0'),

            databasePath: process.env.DATABASE_PATH || './database/accounts.db',

            dryRun: false,
            verbose: false,
        };

        this.loadWhitelist();
    }

    private loadWhitelist() {
        var whitelistPath = path.join(process.cwd(), 'whitelist.json');
        if (fs.existsSync(whitelistPath)) {
            try {
                var data = JSON.parse(fs.readFileSync(whitelistPath, 'utf-8'));
                if (Array.isArray(data)) {
                    data.forEach((addr: string) => this.whitelist.add(addr));
                }
            } catch (err) {
                console.warn('Warning: Failed to load whitelist.json');
            }
        }
    }

    loadOperatorKeypair(): Keypair {
        if (this.config.operatorKeypair) {
            return this.config.operatorKeypair;
        }

        var keypairPath = path.resolve(this.config.walletPath);
        if (!fs.existsSync(keypairPath)) {
            throw new Error(`Operator wallet not found at: ${keypairPath}`);
        }

        var keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
        this.config.operatorKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
        return this.config.operatorKeypair;
    }

    get() {
        return this.config;
    }

    setDryRun(val: boolean) {
        this.config.dryRun = val;
    }

    setVerbose(val: boolean) {
        this.config.verbose = val;
    }

    setNetwork(network: 'devnet' | 'mainnet-beta') {
        this.config.network = network;
        // update rpc url too
        var rpcUrl = network === 'mainnet-beta'
            ? 'https://api.mainnet-beta.solana.com'
            : 'https://api.devnet.solana.com';
        this.config.rpcUrl = rpcUrl;
        this.config.connection = new Connection(rpcUrl, 'confirmed');
    }

    isWhitelisted(pubkey: string): boolean {
        return this.whitelist.has(pubkey);
    }

    addToWhitelist(pubkey: string) {
        this.whitelist.add(pubkey);
        this.saveWhitelist();
    }

    removeFromWhitelist(pubkey: string) {
        this.whitelist.delete(pubkey);
        this.saveWhitelist();
    }

    getWhitelist(): string[] {
        return Array.from(this.whitelist);
    }

    private saveWhitelist() {
        var whitelistPath = path.join(process.cwd(), 'whitelist.json');
        fs.writeFileSync(whitelistPath, JSON.stringify(Array.from(this.whitelist), null, 2));
    }

    validate(): { valid: boolean; errors: string[] } {
        var errors: string[] = [];

        if (!this.config.treasuryAddress) {
            errors.push('TREASURY_ADDRESS is required');
        } else {
            // validate treasury address format
            try {
                new PublicKey(this.config.treasuryAddress);
            } catch {
                errors.push('TREASURY_ADDRESS is not a valid Solana public key');
            }
        }

        // mainnet needs treasury for sure
        if (this.config.network === 'mainnet-beta' && !this.config.treasuryAddress) {
            errors.push('Treasury address must be set for mainnet operations');
        }

        return {
            valid: errors.length === 0,
            errors,
        };
    }
}

export const configManager = new ConfigManager();
export const config = configManager.get();
