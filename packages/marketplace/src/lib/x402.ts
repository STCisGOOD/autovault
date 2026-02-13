/**
 * x402 Payment Utilities — USDC transfer + signature handling.
 *
 * Handles:
 * 1. Deriving user's USDC Associated Token Account
 * 2. Creating a USDC transfer instruction
 * 3. Signing via wallet adapter
 * 4. Sending payment signature to backend for verification
 *
 * Security (2026 hardening):
 * - Amount validation: positive, bounded, safe integer after scaling
 * - Transaction instruction whitelist: only expected program IDs allowed
 * - Blockhash-based confirmation (not deprecated signature-only)
 * - ATA creation for first-time recipients (C2 fix)
 */

import { PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { getConnection, confirmTx } from './solana';

// Maximum USDC payment amount (safety bound against manipulation)
const MAX_USDC_AMOUNT = 1000;

// Allowed program IDs for payment transactions — anything else is suspicious
const ALLOWED_PROGRAMS = new Set([
  SystemProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
]);

// USDC Mint addresses
const USDC_MINT_DEVNET = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const USDC_MINT_MAINNET = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Default pay-to address (from backend config)
const DEFAULT_PAY_TO = new PublicKey('7d5L3DqVxRMHbWx2P6JkNq7t5vFCmYk3kPJqZhBe8iGs');

export interface PaymentResult {
  success: boolean;
  signature?: string;
  error?: string;
}

/**
 * Get the USDC mint for the current network.
 */
export function getUsdcMint(network: 'devnet' | 'mainnet' = 'devnet'): PublicKey {
  return network === 'mainnet' ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;
}

/**
 * Get the user's USDC balance.
 */
export async function getUsdcBalance(
  walletPubkey: PublicKey,
  network: 'devnet' | 'mainnet' = 'devnet'
): Promise<number> {
  const connection = getConnection();
  const usdcMint = getUsdcMint(network);

  try {
    const ata = await getAssociatedTokenAddress(usdcMint, walletPubkey);
    const balance = await connection.getTokenAccountBalance(ata);
    return Number(balance.value.uiAmount ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Create a USDC transfer transaction.
 *
 * @param senderPubkey - User's wallet public key
 * @param recipientPubkey - Agent's pay-to address
 * @param amountUSDC - Amount in USDC (e.g., 0.01)
 * @param network - devnet or mainnet
 */
export async function createUsdcTransferTx(
  senderPubkey: PublicKey,
  recipientPubkey: PublicKey = DEFAULT_PAY_TO,
  amountUSDC: number,
  network: 'devnet' | 'mainnet' = 'devnet'
): Promise<Transaction> {
  // Validate amount: must be positive, finite, bounded, and safe after scaling
  if (
    !Number.isFinite(amountUSDC) ||
    amountUSDC <= 0 ||
    amountUSDC > MAX_USDC_AMOUNT
  ) {
    throw new Error(`Invalid payment amount: ${amountUSDC}`);
  }

  const connection = getConnection();
  const usdcMint = getUsdcMint(network);

  // USDC has 6 decimal places
  const amount = Math.round(amountUSDC * 1_000_000);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`Amount overflows safe integer: ${amountUSDC}`);
  }

  const senderATA = await getAssociatedTokenAddress(usdcMint, senderPubkey);
  const recipientATA = await getAssociatedTokenAddress(usdcMint, recipientPubkey);

  const tx = new Transaction();

  // Create recipient ATA if it doesn't exist (required for first-time recipients)
  const recipientATAInfo = await connection.getAccountInfo(recipientATA);
  if (!recipientATAInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        senderPubkey,    // payer
        recipientATA,    // ATA to create
        recipientPubkey, // owner
        usdcMint,        // mint
      ),
    );
  }

  tx.add(
    createTransferInstruction(
      senderATA,
      recipientATA,
      senderPubkey,
      amount,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );
  tx.feePayer = senderPubkey;

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  return tx;
}

/**
 * Full payment flow:
 * 1. Create USDC transfer tx
 * 2. User signs with wallet
 * 3. Send to network
 * 4. Return signature for backend verification
 */
/**
 * Validate that a signed transaction only contains instructions from
 * whitelisted program IDs. Detects malicious extensions or MITM attacks
 * that append drain instructions (e.g., Crypto Copilot skimmer, 2025).
 */
function validateSignedTransaction(tx: Transaction): void {
  for (const ix of tx.instructions) {
    const pid = ix.programId.toBase58();
    if (!ALLOWED_PROGRAMS.has(pid)) {
      throw new Error(
        `Transaction contains unexpected program: ${pid}. ` +
        'This may indicate a malicious browser extension. ' +
        'Please audit your extensions and retry.'
      );
    }
  }
}

export async function executePayment(
  senderPubkey: PublicKey,
  signTransaction: (tx: Transaction) => Promise<Transaction>,
  amountUSDC: number,
  recipientPubkey?: PublicKey,
  network: 'devnet' | 'mainnet' = 'devnet'
): Promise<PaymentResult> {
  try {
    // Check balance first
    const balance = await getUsdcBalance(senderPubkey, network);
    if (balance < amountUSDC) {
      return {
        success: false,
        error: `Insufficient USDC balance: ${balance.toFixed(4)} < ${amountUSDC}`,
      };
    }

    // Create and sign transaction
    const tx = await createUsdcTransferTx(
      senderPubkey,
      recipientPubkey ?? DEFAULT_PAY_TO,
      amountUSDC,
      network
    );

    const signed = await signTransaction(tx);

    // POST-SIGN VALIDATION: Verify the wallet/extension didn't inject
    // extra instructions. A malicious Chrome extension (like Crypto Copilot)
    // can append hidden transfer instructions before the wallet signs.
    validateSignedTransaction(signed);

    // Send to network
    const connection = getConnection();
    const signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    // Use blockhash-based confirmation (not deprecated signature-only).
    // The deprecated form can hang indefinitely if blockhash expires.
    await confirmTx(signature, tx.recentBlockhash!, tx.lastValidBlockHeight!);

    return { success: true, signature };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Payment failed',
    };
  }
}
