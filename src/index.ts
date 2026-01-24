#!/usr/bin/env node
import { Command } from 'commander';
import cron from 'node-cron';
import readline from 'readline';
import { configManager, config } from './config';
import { logger, ScanSummary } from './logger';
import { database } from './database';
import { scanner } from './scanner';
import { safety } from './safety';
import { reclaim } from './reclaim';
import { kora } from './kora';
import { alerts } from './alerts';
import { dashboard } from './dashboard';

const program = new Command();

// setup the program 
program
    .name('kora-reclaim')
    .description('Automated rent reclaim bot for Kora-sponsored Solana accounts')
    .version('1.0.0')
    .option('-n, --network <network>', 'Network to use (devnet | mainnet-beta)', 'devnet')
    .option('-d, --dry-run', 'Simulate without executing transactions')
    .option('-v, --verbose', 'Enable verbose logging')
    .hook('preAction', (thisCommand) => {
        const opts = thisCommand.opts();
        if (opts.network) {
            configManager.setNetwork(opts.network as 'devnet' | 'mainnet-beta');
        }
        if (opts.dryRun) configManager.setDryRun(true);
        if (opts.verbose) {
            configManager.setVerbose(true);
            logger.setVerbose(true);
        }
    });

// scan cmd
program
    .command('scan')
    .description('Scan all tracked accounts and identify reclaimable ones')
    .action(async () => {
        logger.printScanHeader();

        let startTime = Date.now();
        let result = await scanner.scanAccounts();
        let duration = Date.now() - startTime;

        // filter out accounts that dont pass safety
        const { safe, filtered } = await safety.filterSafeAccounts(result.reclaimable);

        logger.info(`Found ${safe.length} accounts eligible for reclaim`);

        if (filtered.length > 0) {
            logger.info(`Filtered ${filtered.length} accounts by safety rules`);
            // TODO: maybe add more details here
            for (const { account, reason } of filtered) {
                logger.debug(`  ${account.pubkey}: ${reason}`);
            }
        }

        // show what we found
        if (safe.length > 0) {
            console.log('\nReclaimable Accounts:');
            for (let i = 0; i < safe.length; i++) {
                const account = safe[i];
                const sol = (account.lamports / 1e9).toFixed(6);
                console.log(`  ${account.pubkey} - ${sol} SOL`);
            }
        }

        let summary: ScanSummary = {
            totalAccounts: result.total,
            reclaimable: safe.length,
            reclaimed: 0,
            skipped: result.skipped.length + filtered.length,
            failed: result.errors.length,
            totalLamportsReclaimed: 0,
            duration: duration,
            timestamp: new Date().toISOString(),
        };

        logger.printSummary(summary);
        database.close();
    });

/**
 * reclaim cmd - does the actual reclaim
 */
program
    .command('reclaim')
    .description('Execute rent reclaim on eligible accounts')
    .option('-y, --yes', 'Skip confirmation prompt on mainnet')
    .option('--max <sol>', 'Maximum SOL to reclaim this run', parseFloat)
    .action(async (options) => {
        logger.printScanHeader();

        // check config first
        const validation = configManager.validate();
        if (!validation.valid) {
            for (const error of validation.errors) {
                logger.error(error);
            }
            process.exit(1);
        }

        // mainnet needs confirm
        if (safety.requiresConfirmation() && !options.yes) {
            let confirmed = await confirmMainnetOperation();
            if (!confirmed) {
                logger.info('Operation cancelled');
                process.exit(0);
            }
        }

        safety.resetRunState();

        const startTime = Date.now();
        logger.info('Scanning accounts...');
        const scanResult = await scanner.scanAccounts();

        const { safe } = await safety.filterSafeAccounts(scanResult.reclaimable);

        if (safe.length === 0) {
            logger.info('No accounts eligible for reclaim');
            database.close();
            return;
        }

        logger.info(`Reclaiming ${safe.length} accounts...`);
        const reclaimResult = await reclaim.reclaimAccounts(safe);

        const duration = Date.now() - startTime;

        // build summary
        const summary: ScanSummary = {
            totalAccounts: scanResult.total,
            reclaimable: safe.length,
            reclaimed: reclaimResult.successful.length,
            skipped: scanResult.skipped.length,
            failed: reclaimResult.failed.length,
            totalLamportsReclaimed: reclaimResult.totalLamportsReclaimed,
            duration,
            timestamp: new Date().toISOString(),
        };

        logger.printSummary(summary);

        // save log
        const jsonPath = await logger.saveJsonLog(summary);
        logger.info(`JSON log saved to: ${jsonPath}`);

        // send alerts if configured
        await alerts.sendReclaimSummary(
            summary.totalAccounts,
            summary.reclaimed,
            summary.failed,
            summary.totalLamportsReclaimed
        );

        database.close();
    });

// status - show whats going on
program
    .command('status')
    .description('Show current status and metrics')
    .action(async () => {
        await dashboard.printCompactStatus();
        database.close();
    });

// dashboard - detailed visualization
program
    .command('dashboard')
    .description('Show detailed dashboard with charts and history')
    .action(async () => {
        await dashboard.printDashboard();
        database.close();
    });

// import accounts from file
program
    .command('import <file>')
    .description('Import accounts from JSON file')
    .action(async (file: string) => {
        try {
            const count = await kora.importFromFile(file);
            logger.success(`Imported ${count} accounts`);
        } catch (error) {
            logger.error(`Import failed: ${error}`);
            process.exit(1);
        }
        database.close();
    });

// discover accts from fee payer
program
    .command('discover <feePayer>')
    .description('Discover sponsored accounts from fee payer address')
    .option('-l, --limit <number>', 'Number of transactions to scan', '1000')
    .action(async (feePayer: string, options) => {
        try {
            let count = await kora.discoverFromFeePayer(feePayer, parseInt(options.limit));
            logger.success(`Discovered ${count} accounts`);
        } catch (error) {
            logger.error(`Discovery failed: ${error}`);
            process.exit(1);
        }
        database.close();
    });

// export to json
program
    .command('export <file>')
    .description('Export tracked accounts to JSON file')
    .action(async (file: string) => {
        try {
            await kora.exportAccounts(file);
        } catch (error) {
            logger.error(`Export failed: ${error}`);
            process.exit(1);
        }
        database.close();
    });

// whitelist cmds
const whitelist = program.command('whitelist').description('Manage account whitelist');

whitelist
    .command('add <pubkey>')
    .description('Add account to whitelist')
    .option('-r, --reason <reason>', 'Reason for whitelisting')
    .action(async (pubkey: string, options) => {
        await safety.addToWhitelist(pubkey, options.reason);
        database.close();
    });

whitelist.command('remove <pubkey>').description('Remove account from whitelist').action(async (pubkey: string) => {
    await safety.removeFromWhitelist(pubkey);
    database.close();
});

whitelist.command('list').description('List all whitelisted accounts').action(async () => {
    const list = await safety.getWhitelist();
    console.log('\nWhitelisted Accounts:');
    if (list.length === 0) {
        console.log('  (none)');
    } else {
        list.forEach(pubkey => console.log(`  ${pubkey}`));
    }
    console.log('');
    database.close();
});

// cron scheduler - runs automatically
program
    .command('cron')
    .description('Start automated cron scheduler')
    .option('-s, --schedule <cron>', 'Cron schedule expression', '0 */6 * * *')
    .action(async (options) => {
        logger.info(`Starting cron scheduler: ${options.schedule}`);
        logger.info('Press Ctrl+C to stop');

        await alerts.sendStartupAlert();

        cron.schedule(options.schedule, async () => {
            logger.info('Running scheduled scan and reclaim...');
            safety.resetRunState();

            try {
                const scanResult = await scanner.scanAccounts();
                const { safe } = await safety.filterSafeAccounts(scanResult.reclaimable);

                if (safe.length > 0) {
                    const reclaimResult = await reclaim.reclaimAccounts(safe);

                    await alerts.sendReclaimSummary(
                        scanResult.total,
                        reclaimResult.successful.length,
                        reclaimResult.failed.length,
                        reclaimResult.totalLamportsReclaimed
                    );
                }
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                logger.error(`Scheduled run failed: ${errorMsg}`);
                await alerts.sendErrorAlert(errorMsg, 'Scheduled run');
            }
        });

        // dont let process die
        process.on('SIGINT', () => {
            logger.info('Stopping cron scheduler');
            database.close();
            process.exit(0);
        });
    });

// helper for mainnet confirmation
async function confirmMainnetOperation(): Promise<boolean> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        console.log('\n** WARNING: You are about to execute on MAINNET **');
        console.log('   This will reclaim real SOL from accounts.\n');

        rl.question('Are you sure you want to continue? (yes/no): ', (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
        });
    });
}

// Wait for key press before exiting (useful when double-clicking the exe)
async function waitForKeyPress(): Promise<void> {
    console.log('\nPress Enter to exit...');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question('', () => {
            rl.close();
            resolve();
        });
    });
}

// Check if running interactively (no command provided)
async function main() {
    // If no arguments beyond node and script, show help and wait
    if (process.argv.length <= 2) {
        program.outputHelp();
        await waitForKeyPress();
        process.exit(0);
    }
    program.parse();
}

main();
