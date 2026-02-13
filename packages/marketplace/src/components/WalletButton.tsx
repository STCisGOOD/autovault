/**
 * WalletButton — Solana wallet connect button.
 *
 * Wraps the @solana/wallet-adapter-react-ui button with
 * our dark theme styling and nanostores state sync.
 *
 * Security (2026 hardening):
 * - Uses centralized RPC_URL from solana.ts (no hardcoded duplicates)
 * - Empty wallets array: Wallet Standard auto-detects installed wallets
 *   (Phantom, Solflare, Backpack, etc.) — no need for manual adapters
 */

import { useEffect } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { setWalletState } from '../stores/wallet';
import { RPC_URL } from '../lib/solana';

// Import wallet adapter CSS
import '@solana/wallet-adapter-react-ui/styles.css';

/** Syncs wallet adapter state to nanostores */
function WalletStateSync() {
  const { connected, publicKey } = useWallet();

  useEffect(() => {
    setWalletState(connected, publicKey?.toBase58() ?? null);
  }, [connected, publicKey]);

  return null;
}

/** The actual button + provider tree */
function WalletButtonInner() {
  return (
    <>
      <WalletStateSync />
      <WalletMultiButton
        style={{
          backgroundColor: 'transparent',
          border: '1px solid rgba(107, 76, 58, 0.3)',
          color: '#6b4c3a',
          fontFamily: '"JetBrains Mono", "Courier New", monospace',
          fontSize: '10px',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          height: '32px',
          padding: '0 12px',
          borderRadius: '0',
        }}
      />
    </>
  );
}

/** Top-level provider wrapper — include this once near the root */
export default function WalletButton() {
  // Empty array: Wallet Standard auto-detects installed wallets.
  // Manual adapters (PhantomWalletAdapter) are legacy and unnecessary since 2024.
  const wallets: never[] = [];

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <WalletButtonInner />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
