/**
 * WalletButton — Solana wallet connect button.
 *
 * Wraps the @solana/wallet-adapter-react-ui button with
 * our dark theme styling and nanostores state sync.
 */

import { useEffect, useMemo } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { setWalletState } from '../stores/wallet';

// Import wallet adapter CSS
import '@solana/wallet-adapter-react-ui/styles.css';

const RPC_URL = 'https://api.devnet.solana.com';

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
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

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
