/**
 * PaymentFlow — x402 USDC payment modal.
 *
 * Steps:
 * 1. Check wallet connected
 * 2. Check USDC balance
 * 3. Create + sign USDC transfer
 * 4. Get transaction signature
 * 5. Verify with backend (or show success for devnet)
 */

import { useState, useEffect } from 'react';
import { useStore } from '@nanostores/react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { $walletConnected, $walletAddress } from '../stores/wallet';
import { getUsdcBalance, executePayment } from '../lib/x402';

interface PaymentFlowProps {
  agentPubkey: string;
  priceUSDC: number;
  onSuccess: (signature: string) => void;
  onClose: () => void;
}

type PaymentStep = 'check-wallet' | 'check-balance' | 'signing' | 'confirming' | 'success' | 'error';

export default function PaymentFlow({
  agentPubkey,
  priceUSDC,
  onSuccess,
  onClose,
}: PaymentFlowProps) {
  const connected = useStore($walletConnected);
  const address = useStore($walletAddress);
  const { signTransaction } = useWallet();

  const [step, setStep] = useState<PaymentStep>('check-wallet');
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);

  // Step 1: Check wallet
  useEffect(() => {
    if (step === 'check-wallet' && connected && address) {
      setStep('check-balance');
    }
  }, [step, connected, address]);

  // Step 2: Check balance
  useEffect(() => {
    if (step !== 'check-balance' || !address) return;

    async function checkBalance() {
      try {
        const bal = await getUsdcBalance(new PublicKey(address!));
        setBalance(bal);
        if (bal >= priceUSDC) {
          setStep('signing');
        } else {
          setError(`Insufficient USDC balance: ${bal.toFixed(4)} < ${priceUSDC}`);
          setStep('error');
        }
      } catch (err) {
        setError('Failed to check USDC balance');
        setStep('error');
      }
    }

    checkBalance();
  }, [step, address, priceUSDC]);

  // Step 3: Execute payment
  useEffect(() => {
    if (step !== 'signing' || !address || !signTransaction) return;

    async function pay() {
      try {
        setStep('confirming');
        const result = await executePayment(
          new PublicKey(address!),
          signTransaction,
          priceUSDC,
          new PublicKey(agentPubkey)
        );

        if (result.success && result.signature) {
          setSignature(result.signature);
          setStep('success');
          onSuccess(result.signature);
        } else {
          setError(result.error ?? 'Payment failed');
          setStep('error');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Payment failed');
        setStep('error');
      }
    }

    pay();
  }, [step, address, signTransaction, priceUSDC, onSuccess]);

  return (
    <div className="space-y-4">
      <h3 className="text-sm uppercase tracking-widest text-vault-accent text-center">
        x402 Payment
      </h3>

      {/* Price display */}
      <div className="text-center py-3 border border-vault-border/30 bg-vault-bg">
        <div className="text-2xl font-bold text-vault-amber">${priceUSDC.toFixed(2)}</div>
        <div className="text-[10px] text-vault-accent-faint uppercase tracking-wider mt-1">
          USDC on Devnet
        </div>
      </div>

      {/* Step indicator */}
      <div className="flex items-center justify-center gap-2">
        {['Wallet', 'Balance', 'Sign', 'Confirm'].map((label, i) => {
          const stepIndex = ['check-wallet', 'check-balance', 'signing', 'confirming'].indexOf(step);
          const isActive = i <= stepIndex;
          return (
            <div key={label} className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full ${
                  isActive ? 'bg-vault-accent' : 'bg-vault-border'
                }`}
              />
              <span
                className={`text-[9px] uppercase tracking-wider ${
                  isActive ? 'text-vault-accent' : 'text-vault-accent-faint'
                }`}
              >
                {label}
              </span>
              {i < 3 && <div className="w-4 h-[1px] bg-vault-border" />}
            </div>
          );
        })}
      </div>

      {/* Status messages */}
      {step === 'check-wallet' && !connected && (
        <div className="text-center text-xs text-vault-accent-dim">
          Connect your wallet to proceed
        </div>
      )}

      {step === 'check-balance' && (
        <div className="text-center text-xs text-vault-accent-dim animate-pulse">
          Checking USDC balance...
        </div>
      )}

      {step === 'signing' && (
        <div className="text-center text-xs text-vault-accent-dim animate-pulse">
          Please sign the transaction in your wallet...
        </div>
      )}

      {step === 'confirming' && (
        <div className="text-center text-xs text-vault-accent-dim animate-pulse">
          Confirming on Solana devnet...
        </div>
      )}

      {step === 'success' && signature && (
        <div className="text-center space-y-2">
          <div className="text-vault-accent text-sm">Payment Successful</div>
          <div className="text-[10px] text-vault-accent-dim font-mono break-all">
            Signature: {signature}
          </div>
          <a
            href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}
            target="_blank"
            rel="noopener"
            className="inline-block text-[10px] text-vault-accent-dim hover:text-vault-accent
                       underline transition-colors"
          >
            View on Solana Explorer
          </a>
        </div>
      )}

      {step === 'error' && (
        <div className="text-center space-y-2">
          <div className="text-red-400 text-xs">{error}</div>
          <button
            onClick={() => {
              setError(null);
              setStep('check-wallet');
            }}
            className="px-3 py-1 border border-vault-border text-vault-accent-dim
                       hover:text-vault-accent text-[10px] uppercase tracking-widest transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Devnet badge */}
      <div className="flex items-center justify-center gap-2 pt-2 border-t border-vault-border/30">
        <div className="w-2 h-2 rounded-full bg-vault-emerald animate-pulse" />
        <span className="text-[9px] text-vault-accent-faint uppercase tracking-wider">
          Devnet — use{' '}
          <a
            href="https://faucet.circle.com/"
            target="_blank"
            rel="noopener"
            className="text-vault-accent-dim hover:text-vault-accent underline"
          >
            Circle faucet
          </a>{' '}
          for test USDC
        </span>
      </div>

      {/* Close button */}
      <div className="text-center">
        <button
          onClick={onClose}
          className="px-4 py-1.5 border border-vault-border text-vault-accent-dim
                     hover:text-vault-accent text-xs uppercase tracking-widest transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}
