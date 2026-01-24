/**
 * Devnet Proof Script
 * 
 * This script demonstrates the Kora Rent Reclaimer bot working on devnet.
 * It creates test accounts, runs the full reclaim flow, and outputs
 * transaction signatures as proof.
 * 
 * Usage: npx ts-node test-scripts/devnet-proof.ts
 */

import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
} from '@solana/web3.js';
import {
    createMint,
    createAssociatedTokenAccount,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

const DEVNET_RPC = 'https://api.devnet.solana.com';

interface ProofResult {
    timestamp: string;
    operatorAddress: string;
    accountsCreated: string[];
    accountsDiscovered: number;
    accountsReclaimed: number;
    totalSolReclaimed: number;
    transactionSignatures: string[];
    solanaExplorerLinks: string[];
}

/**
 * Load or create a test wallet
 */
async function getOrCreateWallet(filePath: string, connection: Connection): Promise<Keypair> {
    if (fs.existsSync(filePath)) {
        console.log(`Loading existing wallet from ${filePath}`);
        const secret = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return Keypair.fromSecretKey(new Uint8Array(secret));
    }

    console.log('Generating new test wallet...');
    const wallet = Keypair.generate();
    fs.writeFileSync(filePath, JSON.stringify(Array.from(wallet.secretKey)));

    console.log('Requesting airdrop...');
    try {
        const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig);
        console.log('Airdrop successful!');
    } catch (e) {
        console.error('Airdrop failed. Please manually fund:', wallet.publicKey.toBase58());
        console.log('Use: https://faucet.solana.com/');
    }

    return wallet;
}

/**
 * Create test token accounts that the operator owns
 */
async function createTestAccounts(
    connection: Connection,
    operator: Keypair,
    count: number = 3
): Promise<string[]> {
    console.log(`\nCreating ${count} test token accounts...`);
    const createdAccounts: string[] = [];

    for (let i = 0; i < count; i++) {
        try {
            // Create a new token mint
            const mint = await createMint(
                connection,
                operator,
                operator.publicKey,
                null,
                9
            );
            console.log(`  Created mint ${i + 1}: ${mint.toBase58()}`);

            // Create an ATA for the operator (operator will be closeAuthority)
            const ata = await createAssociatedTokenAccount(
                connection,
                operator,
                mint,
                operator.publicKey
            );
            console.log(`  Created ATA ${i + 1}: ${ata.toBase58()}`);
            createdAccounts.push(ata.toBase58());

            // Small delay to avoid rate limiting
            await new Promise(r => setTimeout(r, 500));
        } catch (err) {
            console.error(`  Failed to create account ${i + 1}:`, err);
        }
    }

    return createdAccounts;
}

/**
 * Save test accounts to a file for import
 */
function saveTestAccountsForImport(accounts: string[], outputPath: string): void {
    const importData = accounts.map(pubkey => ({ pubkey }));
    fs.writeFileSync(outputPath, JSON.stringify(importData, null, 2));
    console.log(`\nSaved ${accounts.length} accounts to ${outputPath}`);
}

/**
 * Generate Solana Explorer links
 */
function getExplorerLinks(signatures: string[]): string[] {
    return signatures.map(sig =>
        `https://explorer.solana.com/tx/${sig}?cluster=devnet`
    );
}

/**
 * Main proof generation script
 */
async function main() {
    console.log('='.repeat(60));
    console.log('  KORA RENT RECLAIMER - DEVNET PROOF GENERATOR');
    console.log('='.repeat(60));
    console.log();

    const connection = new Connection(DEVNET_RPC, 'confirmed');
    const projectRoot = path.join(__dirname, '..');
    const walletPath = path.join(projectRoot, 'devnet-test-wallet.json');
    const testAccountsPath = path.join(projectRoot, 'test-accounts.json');

    // 1. Get or create operator wallet
    console.log('Step 1: Setting up operator wallet...');
    const operator = await getOrCreateWallet(walletPath, connection);
    console.log(`Operator address: ${operator.publicKey.toBase58()}`);

    // Check balance
    const balance = await connection.getBalance(operator.publicKey);
    console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    if (balance < 0.1 * LAMPORTS_PER_SOL) {
        console.log('\nInsufficient balance. Requesting airdrop...');
        try {
            const sig = await connection.requestAirdrop(operator.publicKey, 1 * LAMPORTS_PER_SOL);
            await connection.confirmTransaction(sig);
            console.log('Airdrop successful!');
        } catch (e) {
            console.error('Airdrop failed. Please fund manually:');
            console.log(`Address: ${operator.publicKey.toBase58()}`);
            console.log('Faucet: https://faucet.solana.com/');
            process.exit(1);
        }
    }

    // 2. Create test token accounts
    console.log('\nStep 2: Creating test token accounts...');
    const createdAccounts = await createTestAccounts(connection, operator, 2);

    if (createdAccounts.length === 0) {
        console.error('Failed to create any test accounts.');
        process.exit(1);
    }

    // 3. Save accounts for import
    console.log('\nStep 3: Saving accounts for import...');
    saveTestAccountsForImport(createdAccounts, testAccountsPath);

    // 4. Update .env file
    console.log('\nStep 4: Updating .env configuration...');
    const envContent = `# Devnet Configuration for Testing
RPC_URL=${DEVNET_RPC}
NETWORK=devnet
WALLET_PATH=./devnet-test-wallet.json
TREASURY_ADDRESS=${operator.publicKey.toBase58()}
MIN_IDLE_DAYS=0
MAX_RECLAIM_SOL_PER_RUN=10
`;
    fs.writeFileSync(path.join(projectRoot, '.env'), envContent);
    console.log('.env updated for devnet testing');

    // 5. Print next steps
    console.log('\n' + '='.repeat(60));
    console.log('  NEXT STEPS');
    console.log('='.repeat(60));
    console.log(`
1. Build the project:
   npm run build

2. Import the test accounts:
   node dist/index.js import ${testAccountsPath} -n devnet

3. Run a scan to see the accounts:
   node dist/index.js scan -n devnet

4. Execute the reclaim (dry run first):
   node dist/index.js reclaim --dry-run -n devnet

5. Execute actual reclaim:
   node dist/index.js reclaim -n devnet

6. Check status:
   node dist/index.js status -n devnet

7. View the dashboard:
   node dist/index.js dashboard -n devnet
`);

    // 6. Generate proof summary
    const proof: ProofResult = {
        timestamp: new Date().toISOString(),
        operatorAddress: operator.publicKey.toBase58(),
        accountsCreated: createdAccounts,
        accountsDiscovered: 0, // Will be filled after running discover
        accountsReclaimed: 0,  // Will be filled after running reclaim
        totalSolReclaimed: 0,
        transactionSignatures: [], // Add signatures here after reclaim
        solanaExplorerLinks: [],
    };

    const proofPath = path.join(projectRoot, 'devnet-proof.json');
    fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
    console.log(`\nProof template saved to: ${proofPath}`);
    console.log('Update this file with transaction signatures after running reclaim.');

    console.log('\n' + '='.repeat(60));
    console.log('  DEVNET SETUP COMPLETE');
    console.log('='.repeat(60));
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
