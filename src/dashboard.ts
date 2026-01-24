import chalk from 'chalk';
import { database, ReclaimHistoryEntry } from './database';
import { config } from './config';

export interface DashboardStats {
    totalTracked: number;
    active: number;
    closed: number;
    reclaimed: number;
    totalLockedLamports: number;
    totalReclaimedLamports: number;
    operatorCanCloseCount: number;
    operatorCannotCloseCount: number;
}

export interface DailyStats {
    date: string;
    count: number;
    lamports: number;
}

class Dashboard {
    private readonly BOX_WIDTH = 56;

    /**
     * Draw a horizontal line
     */
    private drawLine(char: string = '─'): string {
        return char.repeat(this.BOX_WIDTH);
    }

    /**
     * Draw a progress bar
     */
    private drawProgressBar(current: number, total: number, width: number = 20): string {
        if (total === 0) return '[' + ' '.repeat(width) + '] 0%';

        const percentage = Math.min(100, Math.round((current / total) * 100));
        const filled = Math.round((percentage / 100) * width);
        const empty = width - filled;

        const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
        return `[${bar}] ${percentage}%`;
    }

    /**
     * Draw an ASCII bar chart for history
     */
    private drawBarChart(data: DailyStats[], maxWidth: number = 30): string[] {
        if (data.length === 0) {
            return ['  No reclaim history yet'];
        }

        const maxLamports = Math.max(...data.map(d => d.lamports));
        const lines: string[] = [];

        for (const day of data) {
            const barLength = maxLamports > 0
                ? Math.round((day.lamports / maxLamports) * maxWidth)
                : 0;
            const sol = (day.lamports / 1e9).toFixed(4);
            const bar = chalk.cyan('▓'.repeat(barLength)) + chalk.gray('░'.repeat(maxWidth - barLength));
            lines.push(`  ${day.date} │ ${bar} │ ${sol} SOL`);
        }

        return lines;
    }

    /**
     * Format SOL amount
     */
    private formatSol(lamports: number): string {
        return (lamports / 1e9).toFixed(4);
    }

    /**
     * Get aggregated daily stats from reclaim history
     */
    async getDailyStats(days: number = 7): Promise<DailyStats[]> {
        const history = await database.getReclaimHistory(1000);
        const dailyMap = new Map<string, DailyStats>();

        // Group by date
        for (const entry of history) {
            if (entry.status !== 'success') continue;

            const date = entry.timestamp.split('T')[0];
            const existing = dailyMap.get(date) || { date, count: 0, lamports: 0 };
            existing.count++;
            existing.lamports += entry.lamportsReclaimed;
            dailyMap.set(date, existing);
        }

        // Convert to sorted array (most recent first, limit to N days)
        const sorted = Array.from(dailyMap.values())
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, days);

        return sorted.reverse(); // Oldest first for chart
    }

    /**
     * Get authority breakdown from database
     */
    async getAuthorityBreakdown(): Promise<{ canClose: number; cannotClose: number }> {
        const accounts = await database.getAllAccounts();
        let canClose = 0;
        let cannotClose = 0;

        for (const acc of accounts) {
            if (acc.status === 'active') {
                if (acc.operatorCanClose) {
                    canClose++;
                } else {
                    cannotClose++;
                }
            }
        }

        return { canClose, cannotClose };
    }

    /**
     * Print the enhanced dashboard
     */
    async printDashboard(): Promise<void> {
        const stats = await database.getAccountCount();
        const accounts = await database.getAllAccounts();
        const totalReclaimed = await database.getTotalReclaimed();
        const dailyStats = await this.getDailyStats(7);
        const authorityBreakdown = await this.getAuthorityBreakdown();
        const recentHistory = await database.getReclaimHistory(5);

        // Calculate total locked
        const totalLocked = accounts
            .filter(a => a.status === 'active')
            .reduce((sum, a) => sum + a.lamports, 0);

        // Header
        console.log('\n' + chalk.bold.cyan('╔' + this.drawLine('═') + '╗'));
        console.log(chalk.bold.cyan('║') + chalk.bold.white('  KORA RENT RECLAIMER DASHBOARD'.padEnd(this.BOX_WIDTH)) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('╠' + this.drawLine('═') + '╣'));

        // Network info
        console.log(chalk.bold.cyan('║') + `  Network:    ${chalk.yellow(config.network)}`.padEnd(this.BOX_WIDTH + 10) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('║') + `  Treasury:   ${chalk.gray(config.treasuryAddress?.slice(0, 20) || 'Not set')}...`.padEnd(this.BOX_WIDTH + 10) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('╠' + this.drawLine('═') + '╣'));

        // Account Statistics
        console.log(chalk.bold.cyan('║') + chalk.bold.white('  ACCOUNT STATISTICS').padEnd(this.BOX_WIDTH) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('║') + this.drawLine('─').padEnd(this.BOX_WIDTH) + chalk.bold.cyan('║'));

        console.log(chalk.bold.cyan('║') + `  Total Tracked:     ${chalk.white(stats.total.toString().padStart(8))}`.padEnd(this.BOX_WIDTH + 10) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('║') + `  Active:            ${chalk.green(stats.active.toString().padStart(8))}`.padEnd(this.BOX_WIDTH + 10) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('║') + `  Closed:            ${chalk.yellow(stats.closed.toString().padStart(8))}`.padEnd(this.BOX_WIDTH + 10) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('║') + `  Reclaimed:         ${chalk.cyan(stats.reclaimed.toString().padStart(8))}`.padEnd(this.BOX_WIDTH + 10) + chalk.bold.cyan('║'));

        console.log(chalk.bold.cyan('╠' + this.drawLine('═') + '╣'));

        // Authority Breakdown
        console.log(chalk.bold.cyan('║') + chalk.bold.white('  AUTHORITY STATUS (Active Accounts)').padEnd(this.BOX_WIDTH) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('║') + this.drawLine('─').padEnd(this.BOX_WIDTH) + chalk.bold.cyan('║'));

        const totalActive = authorityBreakdown.canClose + authorityBreakdown.cannotClose;
        console.log(chalk.bold.cyan('║') + `  Can Reclaim:       ${chalk.green(authorityBreakdown.canClose.toString().padStart(8))} ${this.drawProgressBar(authorityBreakdown.canClose, totalActive, 15)}`.padEnd(this.BOX_WIDTH + 20) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('║') + `  No Authority:      ${chalk.red(authorityBreakdown.cannotClose.toString().padStart(8))} ${this.drawProgressBar(authorityBreakdown.cannotClose, totalActive, 15)}`.padEnd(this.BOX_WIDTH + 20) + chalk.bold.cyan('║'));

        console.log(chalk.bold.cyan('╠' + this.drawLine('═') + '╣'));

        // SOL Summary
        console.log(chalk.bold.cyan('║') + chalk.bold.white('  SOL SUMMARY').padEnd(this.BOX_WIDTH) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('║') + this.drawLine('─').padEnd(this.BOX_WIDTH) + chalk.bold.cyan('║'));

        console.log(chalk.bold.cyan('║') + `  Locked (Active):   ${chalk.yellow(this.formatSol(totalLocked).padStart(12))} SOL`.padEnd(this.BOX_WIDTH + 10) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('║') + `  Total Reclaimed:   ${chalk.green(this.formatSol(totalReclaimed).padStart(12))} SOL`.padEnd(this.BOX_WIDTH + 10) + chalk.bold.cyan('║'));

        console.log(chalk.bold.cyan('╠' + this.drawLine('═') + '╣'));

        // Reclaim History Chart
        console.log(chalk.bold.cyan('║') + chalk.bold.white('  RECLAIM HISTORY (Last 7 Days)').padEnd(this.BOX_WIDTH) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('║') + this.drawLine('─').padEnd(this.BOX_WIDTH) + chalk.bold.cyan('║'));

        const chartLines = this.drawBarChart(dailyStats, 20);
        for (const line of chartLines) {
            // Need to handle chalk colors in padding, so just print directly
            console.log(chalk.bold.cyan('║') + line);
        }

        console.log(chalk.bold.cyan('╠' + this.drawLine('═') + '╣'));

        // Recent Activity
        console.log(chalk.bold.cyan('║') + chalk.bold.white('  RECENT ACTIVITY').padEnd(this.BOX_WIDTH) + chalk.bold.cyan('║'));
        console.log(chalk.bold.cyan('║') + this.drawLine('─').padEnd(this.BOX_WIDTH) + chalk.bold.cyan('║'));

        if (recentHistory.length === 0) {
            console.log(chalk.bold.cyan('║') + chalk.gray('  No reclaim activity yet').padEnd(this.BOX_WIDTH) + chalk.bold.cyan('║'));
        } else {
            for (const entry of recentHistory.slice(0, 5)) {
                const sol = this.formatSol(entry.lamportsReclaimed);
                const statusIcon = entry.status === 'success' ? chalk.green('✓') :
                    entry.status === 'failed' ? chalk.red('✗') : chalk.yellow('○');
                const time = entry.timestamp.split('T')[1]?.slice(0, 8) || '';
                const pubkeyShort = entry.pubkey.slice(0, 8) + '...';
                console.log(chalk.bold.cyan('║') + `  ${statusIcon} ${entry.timestamp.split('T')[0]} ${time} │ ${pubkeyShort} │ ${sol} SOL`);
            }
        }

        console.log(chalk.bold.cyan('╚' + this.drawLine('═') + '╝'));
        console.log('');
    }

    /**
     * Print a compact status (for regular status command)
     */
    async printCompactStatus(): Promise<void> {
        const stats = await database.getAccountCount();
        const accounts = await database.getAllAccounts();
        const totalReclaimed = await database.getTotalReclaimed();
        const authorityBreakdown = await this.getAuthorityBreakdown();

        const totalLocked = accounts
            .filter(a => a.status === 'active')
            .reduce((sum, a) => sum + a.lamports, 0);

        console.log('\n' + chalk.bold.cyan('═'.repeat(50)));
        console.log(chalk.bold.white('  Kora Rent Reclaimer Status'));
        console.log(chalk.bold.cyan('═'.repeat(50)));
        console.log(`  Network:           ${chalk.yellow(config.network)}`);
        console.log(`  Treasury:          ${config.treasuryAddress || chalk.gray('Not set')}`);
        console.log(chalk.cyan('─'.repeat(50)));
        console.log(chalk.bold.white('  Account Statistics'));
        console.log(`  Total Tracked:     ${stats.total}`);
        console.log(`  Active:            ${chalk.green(stats.active)}`);
        console.log(`  Closed:            ${chalk.yellow(stats.closed)}`);
        console.log(`  Reclaimed:         ${chalk.cyan(stats.reclaimed)}`);
        console.log(chalk.cyan('─'.repeat(50)));
        console.log(chalk.bold.white('  Authority Breakdown'));
        console.log(`  Can Reclaim:       ${chalk.green(authorityBreakdown.canClose)}`);
        console.log(`  No Authority:      ${chalk.red(authorityBreakdown.cannotClose)}`);
        console.log(chalk.cyan('─'.repeat(50)));
        console.log(chalk.bold.white('  SOL Summary'));
        console.log(`  Locked:            ${chalk.yellow(this.formatSol(totalLocked))} SOL`);
        console.log(`  Total Reclaimed:   ${chalk.green(this.formatSol(totalReclaimed))} SOL`);
        console.log(chalk.bold.cyan('═'.repeat(50)) + '\n');
    }
}

export const dashboard = new Dashboard();
