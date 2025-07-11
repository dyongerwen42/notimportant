// check_key.js
// This is a standalone script to definitively test a Solana private key.
// NOTE: This version uses ES Module 'import' syntax.
// To run it, rename this file to 'check_key.mjs' or add "type": "module" to your package.json file.

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// --- PASTE YOUR KEY HERE ---
// Replace the placeholder string with the exact private key from your wallet.
const myPrivateKeyString = "3NssSSmxNv27sczwDLjvVK7fAZrfBd6eQLgA4TNZp9zw4jJWSJAJLYAeqnFjmwGQP4SdzD4iyAh1akT9rv7vpXZ5";

console.log("--- Solana Key Check Script (ESM Version) ---");
console.log("Attempting to validate key...");

try {
    // 1. Decode the base58 string into a byte array.
    const decodedKey = bs58.decode(myPrivateKeyString);
    console.log(`[OK] Key decoded successfully.`);
    console.log(`   - Decoded length: ${decodedKey.length} bytes.`);

    // 2. Check if the length is valid for a Solana keypair export.
    // Wallets like Phantom typically export a 64-byte key (32-byte secret + 32-byte public).
    if (decodedKey.length !== 64) {
        throw new Error(`Invalid key length. Expected 64 bytes for a full keypair export from Phantom, but got ${decodedKey.length}. Please re-export the key from your wallet.`);
    }

    // 3. The first 32 bytes of a wallet's exported key is the seed.
    const seed = decodedKey.slice(0, 32);
    console.log(`[OK] Extracted 32-byte seed from key.`);
    
    // 4. Generate the keypair from the seed. This is the correct method for this key type.
    const keypair = Keypair.fromSeed(seed);
    console.log(`[OK] Keypair generated from seed.`);

    // 5. Final success message with the public key.
    console.log("\n✅ --- SUCCESS! --- ✅");
    console.log("The private key is valid.");
    console.log("Derived Public Key (Wallet Address):", keypair.publicKey.toBase58());

} catch (error) {
    console.error("\n❌ --- ERROR --- ❌");
    console.error("The private key is invalid or the environment is misconfigured.");
    console.error("Error Message:", error.message);
    console.error("\nNext Steps: Ensure you have copied the key correctly and try running 'npm install' again in a clean folder.");
}
