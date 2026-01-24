import https from 'https';
import { config } from './config';
import { logger } from './logger';

export interface TelegramConfig {
    botToken: string;
    chatId: string;
}

class AlertManager {
    private telegramConfig: TelegramConfig | null = null;

    constructor() {
        // setup telegram if both token and chat id are there
        const cfg = config;
        if (cfg.telegramBotToken && cfg.telegramChatId) {
            this.telegramConfig = {
                botToken: cfg.telegramBotToken,
                chatId: cfg.telegramChatId,
            };
        }
    }

    isConfigured(): boolean {
        return this.telegramConfig !== null;
    }

    // send msg to telegram
    async sendTelegramAlert(message: string): Promise<boolean> {
        if (!this.telegramConfig) {
            logger.debug('Telegram alerts not configured');
            return false;
        }

        const { botToken, chatId } = this.telegramConfig;
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

        const data = JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
        });

        return new Promise((resolve) => {
            const req = https.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                },
            }, (res) => {
                if (res.statusCode === 200) {
                    logger.debug('Telegram alert sent successfully');
                    resolve(true);
                } else {
                    logger.warn(`Telegram alert failed: ${res.statusCode}`);
                    resolve(false);
                }
            });

            req.on('error', (err) => {
                logger.error(`Telegram alert error: ${err.message}`);
                resolve(false);
            });

            req.write(data);
            req.end();
        });
    }

    // send summary after reclaim run
    async sendReclaimSummary(total: number, reclaimed: number, failed: number, lamportsReclaimed: number) {
        if (!this.isConfigured()) return;

        const solReclaimed = (lamportsReclaimed / 1e9).toFixed(4);
        const msg = `
<b>Kora Rent Reclaimer Report</b>

<b>Summary</b>
- Total Accounts Scanned: ${total}
- Successfully Reclaimed: ${reclaimed}
- Failed: ${failed}
- SOL Reclaimed: ${solReclaimed}

Network: ${config.network}
Time: ${new Date().toISOString()}
    `.trim();

        await this.sendTelegramAlert(msg);
    }

    // alert for big reclaims
    async sendLargeReclaimAlert(pubkey: string, lamports: number) {
        if (!this.isConfigured()) return;

        const threshold = config.alertThresholdSol * 1e9;
        if (lamports < threshold) return;

        const sol = (lamports / 1e9).toFixed(4);
        const msg = `
<b>Large Reclaim Alert</b>

Amount: ${sol} SOL
Account: <code>${pubkey}</code>
Network: ${config.network}
    `.trim();

        await this.sendTelegramAlert(msg);
    }

    // error alert
    async sendErrorAlert(error: string, context?: string) {
        if (!this.isConfigured()) return;

        const msg = `
<b>Kora Reclaimer Error</b>

${context ? `Context: ${context}\n` : ''}Error: ${error}
Network: ${config.network}
Time: ${new Date().toISOString()}
    `.trim();

        await this.sendTelegramAlert(msg);
    }

    // startup notification
    async sendStartupAlert() {
        if (!this.isConfigured()) return;

        const msg = `
<b>Kora Rent Reclaimer Started</b>

Network: ${config.network}
Dry Run: ${config.dryRun ? 'Yes' : 'No'}
Time: ${new Date().toISOString()}
    `.trim();

        await this.sendTelegramAlert(msg);
    }
}

export const alerts = new AlertManager();
