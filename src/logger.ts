import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { paths } from './paths';

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

export interface ReclaimLogEntry {
    pubkey: string;
    status: 'reclaimed' | 'skipped' | 'failed';
    lamports?: number;
    reason?: string;
    txSignature?: string;
    timestamp: string;
}

export interface ScanSummary {
    totalAccounts: number;
    reclaimable: number;
    reclaimed: number;
    skipped: number;
    failed: number;
    totalLamportsReclaimed: number;
    duration: number;
    timestamp: string;
}

class Logger {
    private logEntries: ReclaimLogEntry[] = [];
    private logsDir: string;
    private verbose = false;  // default off

    constructor() {
        // Use user data directory for logs in standalone binary mode
        this.logsDir = paths.logsDir;
        this.ensureLogsDir();
    }

    private ensureLogsDir() {
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }
    }

    setVerbose(val: boolean) {
        this.verbose = val;
    }

    log(level: LogLevel, message: string, data?: unknown) {
        const timestamp = new Date().toISOString();
        let prefix: string;
        let colorFn: (text: string) => string;

        // pick color and prefix based on level
        switch (level) {
            case 'success':
                prefix = '[OK]';
                colorFn = chalk.green;
                break;
            case 'warn':
                prefix = '[WARN]';
                colorFn = chalk.yellow;
                break;
            case 'error':
                prefix = '[ERR]';
                colorFn = chalk.red;
                break;
            case 'debug':
                if (!this.verbose) return; // skip if not verbose
                prefix = '[DBG]';
                colorFn = chalk.gray;
                break;
            default:
                prefix = '[INFO]';
                colorFn = chalk.blue;
        }

        console.log(colorFn(`${prefix} ${message}`));

        if (data && this.verbose) {
            console.log(chalk.gray(JSON.stringify(data, null, 2)));
        }
    }

    // convenience methods
    info(msg: string, data?: unknown) { this.log('info', msg, data); }
    success(msg: string, data?: unknown) { this.log('success', msg, data); }
    warn(msg: string, data?: unknown) { this.log('warn', msg, data); }
    error(msg: string, data?: unknown) { this.log('error', msg, data); }
    debug(msg: string, data?: unknown) { this.log('debug', msg, data); }

    addReclaimEntry(entry: ReclaimLogEntry) {
        this.logEntries.push(entry);
    }

    printScanHeader() {
        console.log('\n' + chalk.bold.cyan('='.repeat(50)));
        console.log(chalk.bold.cyan('  Kora Rent Reclaimer'));
        console.log(chalk.bold.cyan('='.repeat(50)));
        console.log(chalk.gray(`  Network: ${config.network}`));
        console.log(chalk.gray(`  Dry Run: ${config.dryRun ? 'Yes' : 'No'}`));
        console.log(chalk.bold.cyan('='.repeat(50)) + '\n');
    }

    printSummary(summary: ScanSummary) {
        const solReclaimed = summary.totalLamportsReclaimed / 1e9;

        console.log('\n' + chalk.bold.cyan('='.repeat(50)));
        console.log(chalk.bold.cyan('  Scan Summary'));
        console.log(chalk.bold.cyan('='.repeat(50)));
        console.log(`  ${chalk.white('Total Accounts:')}    ${summary.totalAccounts}`);
        console.log(`  ${chalk.green('Reclaimed:')}         ${summary.reclaimed} (${solReclaimed.toFixed(4)} SOL)`);
        console.log(`  ${chalk.yellow('Skipped:')}           ${summary.skipped}`);
        console.log(`  ${chalk.red('Failed:')}            ${summary.failed}`);
        console.log(`  ${chalk.gray('Duration:')}          ${(summary.duration / 1000).toFixed(2)}s`);
        console.log(chalk.bold.cyan('='.repeat(50)) + '\n');
    }

    async saveJsonLog(summary: ScanSummary): Promise<string> {
        const date = new Date().toISOString().split('T')[0];
        const filename = `reclaim-${date}.json`;
        const filepath = path.join(this.logsDir, filename);

        const logData = {
            summary,
            entries: this.logEntries,
        };

        // load existing if there
        let existingData: { summary: ScanSummary; entries: ReclaimLogEntry[] }[] = [];
        if (fs.existsSync(filepath)) {
            try {
                existingData = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
            } catch {
                existingData = []; // start fresh if corrupted
            }
        }

        existingData.push(logData);
        fs.writeFileSync(filepath, JSON.stringify(existingData, null, 2));

        return filepath;
    }

    async saveCsvLog(): Promise<string> {
        const date = new Date().toISOString().split('T')[0];
        const filename = `reclaim-${date}.csv`;
        const filepath = path.join(this.logsDir, filename);

        const headers = 'pubkey,status,lamports,reason,txSignature,timestamp\n';
        const rows = this.logEntries.map(e =>
            `${e.pubkey},${e.status},${e.lamports || ''},${e.reason || ''},${e.txSignature || ''},${e.timestamp}`
        ).join('\n');

        const csvContent = headers + rows;

        // append or write new
        if (fs.existsSync(filepath)) {
            fs.appendFileSync(filepath, '\n' + rows);
        } else {
            fs.writeFileSync(filepath, csvContent);
        }

        return filepath;
    }

    clearEntries() {
        this.logEntries = [];
    }

    getEntries(): ReclaimLogEntry[] {
        return [...this.logEntries];
    }
}

export const logger = new Logger();
