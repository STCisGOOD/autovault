/**
 * x402 Payment Utilities — USDC transfer + signature handling.
 *
 * Handles:
 * 1. Deriving user's USDC Associated Token Account
 * 2. Creating a USDC transfer instruction
 * 3. Signing via wallet adapter
 * 4. Sending payment signature to backend for verification
 */

import { PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { getConnection } from './solana';

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
  const connection = getConnection();
  const usdcMint = getUsdcMint(network);

  // USDC has 6 decimal places
  const amount = Math.round(amountUSDC * 1_000_000);

  const senderATA = await getAssociatedTokenAddress(usdcMint, senderPubkey);
  const recipientATA = await getAssociatedTokenAddress(usdcMint, recipientPubkey);

  const transferIx = createTransferInstruction(
    senderATA,
    recipientATA,
    senderPubkey,
    amount,
    [],
    TOKEN_PROGRAM_ID
  );

  const tx = new Transaction().add(transferIx);
  tx.feePayer = senderPubkey;

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;

  return tx;
}

/**
 * Full payment flow:
 * 1. Create USDC transfer tx
 * 2. User signs with wallet
 * 3. Send to network
 * 4. Return signature for backend verification
 */
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

    // Send to network
    const connection = getConnection();
    const signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    // Wait for confirmation
    await connection.confirmTransaction(signature, 'confirmed');

    return { success: true, signature };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Payment failed',
    };
  }
}
