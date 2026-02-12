/**
 * AgentDetailLoader — Client-side wrapper that reads pubkey from URL.
 *
 * Parses ?did=did:persistence:devnet:<pubkey> or ?key=<pubkey>
 * and renders AgentDetail with the extracted pubkey.
 */

import { useState, useEffect } from 'react';
import AgentDetail from './AgentDetail';

export default function AgentDetailLoader() {
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('did') ?? params.get('key') ?? '';
    const cleaned = raw.replace(/^did:persistence:devnet:/, '');

    if (/^[A-HJ-NP-Za-km-z1-9]{32,44}$/.test(cleaned)) {
      setPubkey(cleaned);
      document.title = `Agent ${cleaned.slice(0, 8)}... — AutoVault`;
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

  return <AgentDetail pubkey={pubkey} />;
}
