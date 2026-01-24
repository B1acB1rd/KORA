
import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction
} from '@solana/web3.js';
import {
    createMint,
    getOrCreateAssociatedTokenAccount,
    createAssociatedTokenAccount,
    closeAccount
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';

// Load or create a test wallet
async function getWallet(filePath: string, connection: Connection): Promise<Keypair> {
    if (fs.existsSync(filePath)) {
        const secret = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return Keypair.fromSecretKey(new Uint8Array(secret));
    } else {
        console.log("Generating new test wallet...");
        const wallet = Keypair.generate();
        fs.writeFileSync(filePath, JSON.stringify(Array.from(wallet.secretKey)));

        console.log("Airdropping 2 SOL to new wallet...");
        try {
            const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
            await connection.confirmTransaction(sig);
            console.log("Airdrop successful.");
        } catch (e) {
            console.error("Airdrop failed. You may need to manually fund: " + wallet.publicKey.toBase58());
        }
        return wallet;
    }
}

async function main() {
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");
    const walletPath = path.join(__dirname, "../devnet-test-wallet.json");

    console.log("--- Kora Reclaim Bot Test Setup ---");

    // 1. Get Operator Wallet
    const wallet = await getWallet(walletPath, connection);
    console.log(`Operator Wallet: ${wallet.publicKey.toBase58()}`);

    const balance = await connection.getBalance(wallet.publicKey);
    console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    if (balance < 0.1 * LAMPORTS_PER_SOL) {
        console.log("Requesting Airdrop...");
        try {
            const sig = await connection.requestAirdrop(wallet.publicKey, 1 * LAMPORTS_PER_SOL);
            await connection.confirmTransaction(sig);
        } catch (e) {
            console.log("Could not airdrop. Please fund this address manually via https://faucet.solana.com/");
            console.log("Address:", wallet.publicKey.toBase58());
            return;
        }
    }

    // 2. Create a Dummy Token Mint (Operator pays for it)
    console.log("\nCreating dummy Token Mint...");
    const mint = await createMint(
        connection,
        wallet,
        wallet.publicKey,
        null,
        9
    );
    console.log(`Mint created: ${mint.toBase58()}`);

    // 3. Create a Dummy Token Account "garbage" (Operator pays for it)
    console.log("\nCreating a reclaimable Token Account (ATA)...");
    // We create an ATA for the operator itself for this test, 
    // effectively "sponsoring" itself. 
    // In a real scenario, this would be a user's account paid for by operator.
    // For simplicity, we just create an account that WE (operator) have authority over.

    const tokenAccount = await createAssociatedTokenAccount(
        connection,
        wallet,
        mint,
        wallet.publicKey
    );
    console.log(`Token Account created: ${tokenAccount.toBase58()}`);
    console.log(`This account cost rent to create. The bot should be able to reclaim it.`);

    // 4. Update .env for the user
    console.log("\n--- Configuration ---");
    console.log("Updating .env file with this test wallet...");

    const envContent = `RPC_URL=https://api.devnet.solana.com
NETWORK=devnet
WALLET_PATH=./devnet-test-wallet.json
TREASURY_ADDRESS=${wallet.publicKey.toBase58()}
# Set idle days to 0 so we can reclaim immediately
MIN_IDLE_DAYS=0
MAX_RECLAIM_SOL_PER_RUN=10
`;

    fs.writeFileSync(path.join(__dirname, "../.env"), envContent);
    console.log(".env updated!");

    console.log("\n--- READY ---");
    console.log("1. Run: npm run build");
    console.log("2. Run: node dist/index.js discover " + wallet.publicKey.toBase58() + " -n devnet");
    console.log("3. Run: node dist/index.js reclaim -n devnet");
}

main().catch(err => {
    console.error(err);
});
