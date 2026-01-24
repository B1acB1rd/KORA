/**
 * Runtime paths for Kora Reclaimer CLI
 * 
 * All runtime data (database, logs, config, whitelist) is stored in a
 * user-specific directory to work correctly in standalone binary mode.
 * 
 * Linux/macOS: ~/.kora-reclaimer/
 * Windows: %APPDATA%\kora-reclaimer\
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

class PathManager {
    private _dataDir: string;
    private _initialized = false;

    constructor() {
        // Determine data directory based on platform
        if (process.platform === 'win32') {
            // Windows: use APPDATA
            const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
            this._dataDir = path.join(appData, 'kora-reclaimer');
        } else {
            // Linux/macOS: use home directory
            this._dataDir = path.join(os.homedir(), '.kora-reclaimer');
        }
    }

    /**
     * Initialize the data directory structure
     */
    init(): void {
        if (this._initialized) return;

        // Create main data directory
        if (!fs.existsSync(this._dataDir)) {
            fs.mkdirSync(this._dataDir, { recursive: true });
        }

        // Create subdirectories
        const subdirs = ['database', 'logs', 'config'];
        for (const subdir of subdirs) {
            const dir = path.join(this._dataDir, subdir);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        this._initialized = true;
    }

    /**
     * Get the base data directory
     */
    get dataDir(): string {
        this.init();
        return this._dataDir;
    }

    /**
     * Get the database directory
     */
    get databaseDir(): string {
        return path.join(this.dataDir, 'database');
    }

    /**
     * Get the default database path
     */
    get defaultDatabasePath(): string {
        return path.join(this.databaseDir, 'accounts.db');
    }

    /**
     * Get the logs directory
     */
    get logsDir(): string {
        return path.join(this.dataDir, 'logs');
    }

    /**
     * Get the config directory
     */
    get configDir(): string {
        return path.join(this.dataDir, 'config');
    }

    /**
     * Get the whitelist file path
     */
    get whitelistPath(): string {
        return path.join(this.dataDir, 'whitelist.json');
    }

    /**
     * Get the .env file path (for config)
     */
    get envPath(): string {
        return path.join(this.dataDir, '.env');
    }

    /**
     * Resolve a path that could be absolute or relative to CWD
     * Used for user-specified paths like wallet files
     */
    resolveUserPath(userPath: string): string {
        if (path.isAbsolute(userPath)) {
            return userPath;
        }
        return path.resolve(process.cwd(), userPath);
    }

    /**
     * Print data directory location (useful for users)
     */
    printInfo(): void {
        console.log(`Data directory: ${this._dataDir}`);
    }
}

export const paths = new PathManager();
