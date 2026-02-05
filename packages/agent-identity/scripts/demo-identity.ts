#!/usr/bin/env ts-node
/**
 * demo-identity.ts
 *
 * Demonstrates agent identity creation and on-chain commitment.
 * Run with: npx ts-node scripts/demo-identity.ts
 *
 * This script:
 * 1. Creates or loads an agent identity
 * 2. Requests SOL from devnet faucet
 * 3. Records a sample interaction
 * 4. Commits identity evolution to Solana
 * 5. Outputs tx hashes as proof
 */

import { initializeAgentIdentity } from '../src/index';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   AGENT IDENTITY DEMO - PERMANENCE ON SOLANA DEVNET');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Step 1: Initialize identity
  console.log('🔑 Step 1: Initializing agent identity...\n');

  const agent = await initializeAgentIdentity({
    verbose: true,
    autoFund: true,
    minBalance: 0.1,
    useSolanaStorage: true,
    usePrivateStorage: true,
  });

  console.log('\n✅ Identity initialized:');
  console.log(`   DID: ${agent.did}`);
  console.log(`   Public Key: ${agent.publicKey}`);
  console.log(`   Network: ${agent.network}`);
  console.log(`   Balance: ${agent.balance.toFixed(4)} SOL`);
  console.log(`   Is New: ${agent.isNew}`);

  // Step 2: Start an observation (simulating an interaction)
  console.log('\n📝 Step 2: Recording sample interaction...\n');

  const interactionId = `demo-${Date.now()}`;
  agent.startObservation(interactionId);

  // Simulate some tool calls
  agent.identity.recordToolCall('Read', { file: 'package.json' }, 'success', true, 50);
  agent.identity.recordToolCall('Grep', { pattern: 'agent' }, 'success', true, 120);
  agent.identity.recordToolCall('Write', { file: 'demo.ts' }, 'success', true, 80);

  // Step 3: End observation with a sample interaction
  console.log('🧠 Step 3: Processing through identity evolution...\n');

  const result = await agent.endObservation({
    id: interactionId,
    prompt: 'Demonstrate agent identity persistence on Solana devnet',
    response: 'Successfully demonstrated identity creation, observation recording, and on-chain commitment.',
    timestamp: Date.now(),
    durationMs: 2500,
  });

  console.log('   Observation processed:');
  console.log(`   - Insights extracted: ${result.bridgeResult.insights.length}`);
  console.log(`   - Pivotal insights: ${result.bridgeResult.insights.filter(i => i.isPivotal).length}`);
  console.log(`   - ActionLog hash: ${result.actionLogHash?.slice(0, 16)}...`);

  if (result.bridgeResult.insights.length > 0) {
    console.log('\n   Sample insight:');
    console.log(`   "${result.bridgeResult.insights[0].text.slice(0, 100)}..."`);
  }

  // Step 4: Save to Solana
  console.log('\n💾 Step 4: Saving identity to Solana...\n');

  const saved = await agent.save();
  console.log(`   Save result: ${saved ? '✅ Success' : '❌ Failed'}`);

  // Step 5: Get status
  console.log('\n📊 Step 5: Current identity status:\n');

  const status = agent.getStatus();
  console.log(`   Weights: [${status.weights.map(w => w.toFixed(3)).join(', ')}]`);
  console.log(`   Declarations: ${status.declarationCount}`);
  console.log(`   Observations: ${status.observationCount}`);
  console.log(`   Integrity: ${status.integrityValid ? '✅ Valid' : '❌ Invalid'}`);

  // Output proof
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('   PROOF OF PERMANENCE');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log(`   🔗 Agent DID: ${agent.did}`);
  console.log(`   🌐 Network: Solana Devnet`);
  console.log(`   📍 Explorer: https://explorer.solana.com/address/${agent.publicKey}?cluster=devnet`);
  console.log(`   📊 ActionLog Hash: ${result.actionLogHash || 'N/A'}`);

  console.log('\n   This agent identity is now permanently recorded on Solana.');
  console.log('   The same identity will be loaded on next run.\n');

  // Cleanup
  await agent.shutdown();
  console.log('✅ Demo complete.\n');
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
