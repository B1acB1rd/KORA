#!/usr/bin/env node

/**
 * Create test token accounts for rent reclaim demonstration.
 * 
 * This script:
 * 1. Creates a test token mint (USDC-like)
 * 2. Creates multiple Associated Token Accounts (ATAs)
 * 3. Sets the operator as the closeAuthority on all accounts
 * 4. Logs the accounts for use with the rent reclaimer bot
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
    SystemProgram,
    SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    MINT_SIZE,
    createInitializeMintInstruction,
    createAssociatedTokenAccountInstruction,
    createSetAuthorityInstruction,
    AuthorityType,
    getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const WALLET_PATH = process.env.WALLET_PATH || './devnet-operator.json';

// Number of test accounts to create
const NUM_TEST_ACCOUNTS = 5;

async function main() {
    try {
        console.log('🚀 Creating test token accounts for rent reclaim...\n');

        // Connect to devnet
        const connection = new Connection(RPC_URL, 'confirmed');
        console.log(`✓ Connected to ${RPC_URL}\n`);

        // Load operator keypair
        if (!fs.existsSync(WALLET_PATH)) {
            throw new Error(`Operator keypair not found at ${WALLET_PATH}`);
        }
        const keyfileContent = fs.readFileSync(WALLET_PATH, 'utf-8');
        const keyArray = JSON.parse(keyfileContent);
        const operatorKeypair = Keypair.fromSecretKey(Buffer.from(keyArray));
        const operatorPubkey = operatorKeypair.publicKey;

        console.log(`✓ Loaded operator wallet: ${operatorPubkey.toBase58()}\n`);

        // Check operator balance
        const balance = await connection.getBalance(operatorPubkey);
        console.log(`  Operator balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

        if (balance < 0.5 * LAMPORTS_PER_SOL) {
            console.warn(
                '⚠️  Warning: Operator has less than 0.5 SOL. May not have enough for transaction fees.\n'
            );
        }

        // Step 1: Create a test token mint
        console.log('📝 Step 1: Creating test token mint...');
        const mintKeypair = Keypair.generate();
        const mintPubkey = mintKeypair.publicKey;
        const mintLamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

        // Create mint account
        const createMintTx = new Transaction().add(
            SystemProgram.createAccount({
                fromPubkey: operatorPubkey,
                newAccountPubkey: mintPubkey,
                space: MINT_SIZE,
                lamports: mintLamports,
                programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeMintInstruction(
                mintPubkey,
                6, // decimals (like USDC)
                operatorPubkey, // mint authority
                operatorPubkey // freeze authority
            )
        );

        const mintTxSig = await sendAndConfirmTransaction(connection, createMintTx, [
            operatorKeypair,
            mintKeypair,
        ]);

        console.log(`✓ Created test mint: ${mintPubkey.toBase58()}`);
        console.log(`  Transaction: ${mintTxSig}\n`);

        // Step 2: Create ATAs with random owners and set operator as closeAuthority
        console.log(
            `📝 Step 2: Creating ${NUM_TEST_ACCOUNTS} Associated Token Accounts (ATAs)...`
        );

        const testAccounts = [];

        for (let i = 0; i < NUM_TEST_ACCOUNTS; i++) {
            // Generate a random owner for this ATA
            const ownerKeypair = Keypair.generate();
            const ownerPubkey = ownerKeypair.publicKey;

            // Get ATA address
            const ataAddress = getAssociatedTokenAddressSync(mintPubkey, ownerPubkey);

            // Create ATA + Set close authority in one transaction
            const createAtaTx = new Transaction().add(
                createAssociatedTokenAccountInstruction(
                    operatorPubkey, // payer
                    ataAddress, // associated token account
                    ownerPubkey, // owner
                    mintPubkey // mint
                ),
                // Immediately set the operator as the close authority
                createSetAuthorityInstruction(
                    ataAddress, // token account
                    ownerPubkey, // current authority (owner)
                    AuthorityType.CloseAccount, // authority type
                    operatorPubkey, // new authority (operator)
                    []
                )
            );

            try {
                const ataTxSig = await sendAndConfirmTransaction(connection, createAtaTx, [
                    operatorKeypair,
                    ownerKeypair,
                ]);

                console.log(`✓ Account ${i + 1}/${NUM_TEST_ACCOUNTS}`);
                console.log(`  ATA Address: ${ataAddress.toBase58()}`);
                console.log(`  Owner: ${ownerPubkey.toBase58()}`);
                console.log(`  Close Authority: ${operatorPubkey.toBase58()}`);
                console.log(`  Transaction: ${ataTxSig}`);

                testAccounts.push({
                    address: ataAddress.toBase58(),
                    owner: ownerPubkey.toBase58(),
                    mint: mintPubkey.toBase58(),
                    closeAuthority: operatorPubkey.toBase58(),
                    createdAt: new Date().toISOString(),
                });
            } catch (error) {
                console.error(`✗ Failed to create ATA ${i + 1}: ${error}`);
                throw error;
            }
        }

        console.log();

        // Step 3: Save accounts to test-accounts.json
        console.log('💾 Step 3: Saving account metadata...');
        const outputPath = path.join(__dirname, '..', 'test-accounts.json');
        fs.writeFileSync(outputPath, JSON.stringify(testAccounts, null, 2));
        console.log(`✓ Saved test accounts to: ${outputPath}\n`);

        // Summary
        console.log('✨ Test Account Creation Complete!\n');
        console.log('📊 Summary:');
        console.log(`  • Mint: ${mintPubkey.toBase58()}`);
        console.log(`  • Operator (close authority): ${operatorPubkey.toBase58()}`);
        console.log(`  • Accounts created: ${testAccounts.length}`);
        console.log(`  • Estimated total rent: ${(testAccounts.length * 0.00203).toFixed(5)} SOL\n`);

        console.log('🚀 Next steps:');
        console.log('  1. Import accounts: node dist/index.js import test-accounts.json -n devnet');
        console.log('  2. Scan accounts: node dist/index.js scan -n devnet -v');
        console.log('  3. Dry run: node dist/index.js reclaim --dry-run -n devnet -v');
        console.log('  4. Execute: node dist/index.js reclaim -n devnet\n');
    } catch (error) {
        console.error('❌ Error creating test accounts:', error);
        process.exit(1);
    }
}

main();
