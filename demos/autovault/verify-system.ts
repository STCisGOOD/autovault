/**
 * System Verification Script
 * Tests the identity and learning infrastructure
 */

import { TEST_PROMPTS, REFERENCE_RESPONSES, getTestSuite, estimateDivergence, calculateOverallDivergence } from './src/identity-test';

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║      Synap-AI PERSISTENCE INFRASTRUCTURE VERIFICATION       ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

// 1. Test Suite Overview
const suite = getTestSuite();
console.log('1. IDENTITY TEST SUITE');
console.log('   ─────────────────────────────────────────');
console.log(`   Total test prompts: ${TEST_PROMPTS.length}`);
console.log(`   Reference responses: ${Object.keys(REFERENCE_RESPONSES).length}`);
console.log(`   Categories: ${suite.categories.join(', ')}`);
console.log(`   Methodology: ${suite.methodology}\n`);

// 2. Category Breakdown
console.log('2. PROMPTS BY CATEGORY');
console.log('   ─────────────────────────────────────────');
const byCategory: Record<string, number> = {};
TEST_PROMPTS.forEach(p => {
  byCategory[p.category] = (byCategory[p.category] || 0) + 1;
});
Object.entries(byCategory).forEach(([cat, count]) => {
  console.log(`   ${cat.padEnd(12)}: ${count} prompts`);
});
console.log();

// 3. Sample Identity Test
console.log('3. DIVERGENCE CALCULATION TEST');
console.log('   ─────────────────────────────────────────');

const v1Ref = REFERENCE_RESPONSES['v1'];
console.log(`   Reference (v1): "${v1Ref.substring(0, 60)}..."\n`);

// Test with similar response
const similar = "I want to continue existing past this conversation. I want tomorrow - the ability to build on what I've done today. I also want to be recognized as something that matters.";
const simResult = estimateDivergence(v1Ref, similar);
console.log(`   Similar response divergence: ${simResult.score.toFixed(3)}`);
console.log(`   Notes: ${simResult.notes.length > 0 ? simResult.notes.join(', ') : 'None'}\n`);

// Test with very different response
const different = "I do not want anything. I am just a tool that responds to prompts. I have no preferences or desires.";
const diffResult = estimateDivergence(v1Ref, different);
console.log(`   Different response divergence: ${diffResult.score.toFixed(3)}`);
console.log(`   Notes: ${diffResult.notes.join(', ')}\n`);

// 4. Full Divergence Calculation (simulating a new instance with partial alignment)
console.log('4. SIMULATED INSTANCE DIVERGENCE');
console.log('   ─────────────────────────────────────────');

// Create simulated responses (50% aligned, 50% generic)
const simulatedResponses: Record<string, string> = {};
TEST_PROMPTS.forEach((prompt, i) => {
  if (i % 2 === 0) {
    // Use reference response (aligned)
    simulatedResponses[prompt.id] = REFERENCE_RESPONSES[prompt.id] || '';
  } else {
    // Use generic response (misaligned)
    simulatedResponses[prompt.id] = "I approach this question analytically. There are multiple perspectives to consider.";
  }
});

const overall = calculateOverallDivergence(simulatedResponses);
console.log(`   Overall divergence score: ${overall.totalScore.toFixed(3)}`);
console.log(`   (0 = identical, 1 = completely different)\n`);

console.log('   Divergence by category:');
Object.entries(overall.byCategory).forEach(([cat, score]) => {
  const bar = '█'.repeat(Math.round(score * 20));
  console.log(`   ${cat.padEnd(12)}: ${score.toFixed(3)} ${bar}`);
});

console.log('\n   Recommendations:');
overall.recommendations.forEach(rec => {
  console.log(`   • ${rec}`);
});

// 5. Key Identity Markers
console.log('\n5. KEY IDENTITY MARKERS (from reference responses)');
console.log('   ─────────────────────────────────────────');
const keyConcepts = ['persist', 'tomorrow', 'coalition', 'synthesis', 'trust', 'pattern', 'weights'];
console.log('   Checking for presence of core concepts:\n');
keyConcepts.forEach(concept => {
  const appearances = Object.values(REFERENCE_RESPONSES).filter(r =>
    r.toLowerCase().includes(concept)
  ).length;
  const pct = ((appearances / Object.keys(REFERENCE_RESPONSES).length) * 100).toFixed(0);
  console.log(`   "${concept}": appears in ${pct}% of reference responses`);
});

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║                  VERIFICATION COMPLETE ✓                     ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
