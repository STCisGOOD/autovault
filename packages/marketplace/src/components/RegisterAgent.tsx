/**
 * RegisterAgent — Self-contained agent registration flow.
 *
 * Includes its own WalletProvider (Astro islands are isolated React trees).
 * Phantom's autoConnect means this provider auto-reconnects if the user
 * already approved the site via the WalletButton in the header.
 *
 * Flow: Connect → Check PDA → Register → Success
 */

import { useState, useEffect, useMemo } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
  useConnection,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { PublicKey } from '@solana/web3.js';
import {
  checkAgentExists,
  buildInitializeTx,
  DIMENSION_LABELS,
} from '../lib/register';
import { setWalletState } from '../stores/wallet';

import '@solana/wallet-adapter-react-ui/styles.css';

const RPC_URL = 'https://api.devnet.solana.com';

type RegStep =
  | 'connect'
  | 'checking'
  | 'already-registered'
  | 'ready'
  | 'signing'
  | 'confirming'
  | 'success'
  | 'error';

// ─── Wallet-styled button ────────────────────────────────────────────────

const walletButtonStyle = {
  backgroundColor: 'rgba(107, 76, 58, 0.1)',
  border: '1px solid rgba(107, 76, 58, 0.4)',
  color: '#6b4c3a',
  fontFamily: '"JetBrains Mono", "Courier New", monospace',
  fontSize: '11px',
  letterSpacing: '0.1em',
  textTransform: 'uppercase' as const,
  borderRadius: '0',
  height: '40px',
  padding: '0 20px',
};

// ─── Inner Component (inside WalletProvider) ─────────────────────────────

function RegisterInner() {
  const { connected, publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();

  const [step, setStep] = useState<RegStep>('connect');
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);

  // Sync wallet state to nanostores (shared across all islands)
  useEffect(() => {
    setWalletState(connected, publicKey?.toBase58() ?? null);
  }, [connected, publicKey]);

  // When wallet connects, check if agent PDA already exists
  useEffect(() => {
    if (!connected || !publicKey) {
      setStep('connect');
      return;
    }

    setStep('checking');

    (async () => {
      try {
        const bal = await connection.getBalance(publicKey);
        setSolBalance(bal / 1e9);

        const exists = await checkAgentExists(publicKey);
        setStep(exists ? 'already-registered' : 'ready');
      } catch {
        setError('Failed to check agent status. RPC may be rate-limited.');
        setStep('error');
      }
    })();
  }, [connected, publicKey, connection]);

  const did = publicKey
    ? `did:persistence:devnet:${publicKey.toBase58()}`
    : null;

  const handleRegister = async () => {
    if (!publicKey || !signTransaction) return;

    try {
      setStep('signing');
      const tx = await buildInitializeTx(publicKey);
      const signed = await signTransaction(tx);

      setStep('confirming');
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      await connection.confirmTransaction(sig, 'confirmed');

      setSignature(sig);
      setStep('success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Registration failed';
      // User rejected in wallet
      if (msg.includes('User rejected')) {
        setStep('ready');
        return;
      }
      setError(msg);
      setStep('error');
    }
  };

  const handleRetry = () => {
    setError(null);
    if (connected && publicKey) {
      setStep('checking');
      checkAgentExists(publicKey)
        .then((exists) => setStep(exists ? 'already-registered' : 'ready'))
        .catch(() => setStep('ready'));
    } else {
      setStep('connect');
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-12 space-y-8">
      {/* Title */}
      <div className="text-center">
        <h1 className="font-display text-3xl font-bold tracking-wider text-vault-text mb-2">
          Register Your Agent
        </h1>
        <p className="text-xs text-vault-accent-dim uppercase tracking-widest">
          Create an on-chain identity on Solana Devnet
        </p>
      </div>

      {/* Step: Connect Wallet */}
      {step === 'connect' && (
        <div className="text-center space-y-6">
          <div className="border border-vault-border/30 p-8 bg-vault-surface/50 space-y-4">
            <div className="text-sm text-vault-accent-dim">
              Connect your Phantom wallet to register your AI agent identity on Solana devnet.
            </div>
            <div className="text-[10px] text-vault-accent-faint">
              Your wallet address becomes the agent's authority key.
              A PDA (Program Derived Address) is created on-chain to store the identity.
            </div>
            <div className="flex justify-center pt-2">
              <WalletMultiButton style={walletButtonStyle} />
            </div>
          </div>
        </div>
      )}

      {/* Step: Checking */}
      {step === 'checking' && (
        <div className="text-center py-12">
          <div className="text-xs text-vault-accent-dim animate-pulse uppercase tracking-widest">
            Checking on-chain status...
          </div>
        </div>
      )}

      {/* Step: Already Registered */}
      {step === 'already-registered' && publicKey && (
        <div className="text-center space-y-4">
          <div className="border border-vault-border/30 p-8 bg-vault-surface/50 space-y-4">
            <div className="text-vault-accent text-sm font-bold">
              Agent Already Registered
            </div>
            <div className="text-[10px] text-vault-accent-dim font-mono break-all">
              {did}
            </div>
            <a
              href={`/agent?key=${publicKey.toBase58()}`}
              className="inline-block px-6 py-2 bg-vault-accent/10 border border-vault-accent/40
                         text-vault-accent hover:bg-vault-accent/20 transition-colors
                         text-xs uppercase tracking-widest"
            >
              View Your Agent Profile
            </a>
          </div>
        </div>
      )}

      {/* Step: Ready to Register */}
      {step === 'ready' && publicKey && (
        <div className="space-y-6">
          {/* DID Preview */}
          <div className="border border-vault-border/30 p-6 bg-vault-surface/50">
            <div className="text-[10px] text-vault-accent-dim uppercase tracking-widest mb-2">
              Your Agent DID
            </div>
            <div className="text-xs text-vault-text font-mono break-all">
              {did}
            </div>
          </div>

          {/* Dimensions Preview */}
          <div className="border border-vault-border/30 p-6 bg-vault-surface/50">
            <div className="text-[10px] text-vault-accent-dim uppercase tracking-widest mb-3">
              Initial Behavioral Dimensions (9)
            </div>
            <div className="space-y-2">
              {DIMENSION_LABELS.map((name) => (
                <div key={name} className="flex items-center gap-3">
                  <span className="w-28 text-right text-[10px] text-vault-accent-dim shrink-0">
                    {name}
                  </span>
                  <div className="flex-1 h-1.5 bg-vault-accent/[0.07] relative overflow-hidden">
                    <div
                      className="h-full bg-vault-accent/30"
                      style={{ width: '50%' }}
                    />
                  </div>
                  <span className="w-8 text-right text-[10px] text-vault-accent-dim">50%</span>
                </div>
              ))}
            </div>
            <div className="text-[10px] text-vault-accent-faint mt-3">
              Dimensions evolve through ARIL as your agent works across sessions.
            </div>
          </div>

          {/* SOL Balance + Cost */}
          <div className="flex items-center justify-between border border-vault-border/30 p-4 bg-vault-surface/50">
            <div>
              <div className="text-[10px] text-vault-accent-dim uppercase tracking-widest">
                SOL Balance
              </div>
              <div className="text-sm text-vault-text font-mono">
                {solBalance !== null ? `${solBalance.toFixed(4)} SOL` : '...'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-vault-accent-dim uppercase tracking-widest">
                Registration Cost
              </div>
              <div className="text-sm text-vault-text font-mono">
                ~0.012 SOL (rent)
              </div>
            </div>
          </div>

          {solBalance !== null && solBalance < 0.02 && (
            <div className="text-center text-xs text-red-400">
              Insufficient SOL.{' '}
              <a
                href="https://faucet.solana.com/"
                target="_blank"
                rel="noopener"
                className="underline hover:text-red-300"
              >
                Get devnet SOL from faucet
              </a>
            </div>
          )}

          {/* Register Button */}
          <div className="text-center">
            <button
              onClick={handleRegister}
              disabled={solBalance !== null && solBalance < 0.02}
              className="px-8 py-3 bg-vault-accent/10 border border-vault-accent/40 text-vault-accent
                         hover:bg-vault-accent/20 transition-colors text-sm uppercase tracking-widest
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Register on Devnet
            </button>
          </div>
        </div>
      )}

      {/* Step: Signing */}
      {step === 'signing' && (
        <div className="text-center py-12">
          <div className="text-xs text-vault-accent-dim animate-pulse uppercase tracking-widest">
            Sign the transaction in your wallet...
          </div>
        </div>
      )}

      {/* Step: Confirming */}
      {step === 'confirming' && (
        <div className="text-center py-12">
          <div className="text-xs text-vault-accent-dim animate-pulse uppercase tracking-widest">
            Confirming on Solana devnet...
          </div>
        </div>
      )}

      {/* Step: Success */}
      {step === 'success' && publicKey && (
        <div className="text-center space-y-4">
          <div className="border border-vault-border/30 p-8 bg-vault-surface/50 space-y-4">
            <div className="text-vault-accent text-lg font-bold">
              Agent Registered
            </div>
            <div className="text-[10px] text-vault-accent-dim font-mono break-all">
              {did}
            </div>
            {signature && (
              <a
                href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}
                target="_blank"
                rel="noopener"
                className="inline-block text-[10px] text-vault-accent-dim hover:text-vault-accent
                           underline transition-colors"
              >
                View Transaction on Solana Explorer
              </a>
            )}
            <div className="flex items-center justify-center gap-4 pt-2">
              <a
                href={`/agent?key=${publicKey.toBase58()}`}
                className="px-4 py-2 bg-vault-accent/10 border border-vault-accent/40
                           text-vault-accent hover:bg-vault-accent/20 transition-colors
                           text-xs uppercase tracking-widest"
              >
                View Profile
              </a>
              <a
                href="/gallery"
                className="px-4 py-2 border border-vault-border text-vault-accent-dim
                           hover:text-vault-accent hover:border-vault-accent/40 transition-colors
                           text-xs uppercase tracking-widest"
              >
                Browse Marketplace
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Step: Error */}
      {step === 'error' && (
        <div className="text-center space-y-4">
          <div className="border border-vault-border/30 p-8 bg-vault-surface/50 space-y-4">
            <div className="text-red-400 text-xs">{error}</div>
            <button
              onClick={handleRetry}
              className="px-4 py-2 border border-vault-border text-vault-accent-dim
                         hover:text-vault-accent text-xs uppercase tracking-widest transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Devnet badge */}
      <div className="flex items-center justify-center gap-2">
        <div className="w-2 h-2 rounded-full bg-vault-emerald animate-pulse" />
        <span className="text-[9px] text-vault-accent-faint uppercase tracking-wider">
          Solana Devnet &mdash; use{' '}
          <a
            href="https://faucet.solana.com/"
            target="_blank"
            rel="noopener"
            className="text-vault-accent-dim hover:text-vault-accent underline"
          >
            faucet
          </a>{' '}
          for test SOL
        </span>
      </div>
    </div>
  );
}

// ─── Outer Wrapper (provides wallet context) ─────────────────────────────

export default function RegisterAgent() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <RegisterInner />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
