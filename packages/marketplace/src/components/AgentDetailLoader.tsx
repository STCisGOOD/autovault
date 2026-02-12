/**
 * AgentDetailLoader — Client-side wrapper that reads pubkey from URL.
 *
 * Parses ?did=did:persistence:devnet:<pubkey> or ?key=<pubkey>,
 * verifies the agent exists on-chain, then renders AgentDetail.
 *
 * Security: Without the on-chain check, an attacker could craft
 * /agent?key=<attacker-pubkey> to render a fake profile with a
 * "Hire" button that sends USDC to the attacker's address.
 */

import { useState, useEffect } from 'react';
import { PublicKey } from '@solana/web3.js';
import AgentDetail from './AgentDetail';
import { checkAgentExists } from '../lib/register';

export default function AgentDetailLoader() {
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [verified, setVerified] = useState<boolean | null>(null); // null = checking

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('did') ?? params.get('key') ?? '';
    const cleaned = raw.replace(/^did:persistence:devnet:/, '');

    if (/^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(cleaned)) {
      setPubkey(cleaned);
      document.title = `Agent ${cleaned.slice(0, 8)}... — AutoVault`;

      // Verify agent exists on-chain before rendering profile
      checkAgentExists(new PublicKey(cleaned))
        .then((exists) => setVerified(exists))
        .catch(() => setVerified(false));
    } else {
      setInvalid(true);
    }
  }, []);

  if (invalid) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-20 text-center">
        <div className="text-vault-accent-faint text-2xl mb-4">---</div>
        <div className="text-vault-accent-dim text-sm">
          Invalid agent identifier. Check the DID or pubkey and try again.
        </div>
        <a
          href="/gallery"
          className="inline-block mt-6 px-4 py-2 border border-vault-border text-vault-accent-dim
                     hover:text-vault-accent hover:border-vault-accent/40 text-xs uppercase tracking-widest
                     transition-colors"
        >
          Back to Marketplace
        </a>
      </div>
    );
  }

  if (!pubkey) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-vault-accent-dim text-xs uppercase tracking-widest animate-pulse">
          Loading agent...
        </div>
      </div>
    );
  }

  // Still checking on-chain
  if (verified === null) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-vault-accent-dim text-xs uppercase tracking-widest animate-pulse">
          Verifying on-chain identity...
        </div>
      </div>
    );
  }

  // Agent not found on-chain
  if (!verified) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-20 text-center">
        <div className="text-vault-accent-faint text-2xl mb-4">---</div>
        <div className="text-red-400 text-sm font-bold mb-2">
          Unverified Agent
        </div>
        <div className="text-vault-accent-dim text-xs max-w-md mx-auto">
          No on-chain identity found for this address. This agent has not been
          registered on Solana devnet. Do not send payments to unverified agents.
        </div>
        <div className="text-[10px] text-vault-accent-faint font-mono mt-4 break-all">
          {pubkey}
        </div>
        <a
          href="/gallery"
          className="inline-block mt-6 px-4 py-2 border border-vault-border text-vault-accent-dim
                     hover:text-vault-accent hover:border-vault-accent/40 text-xs uppercase tracking-widest
                     transition-colors"
        >
          Back to Marketplace
        </a>
      </div>
    );
  }

  return <AgentDetail pubkey={pubkey} />;
}
