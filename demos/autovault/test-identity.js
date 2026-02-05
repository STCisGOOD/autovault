// Quick test of identity system
const path = require('path');
process.chdir(path.dirname(__filename));

// Load the compiled module
try {
  const { TEST_PROMPTS, REFERENCE_RESPONSES, getTestSuite, estimateDivergence } = require('./src/identity-test');

  console.log('=== Identity Test System Verification ===\n');
  console.log('Test prompts loaded:', TEST_PROMPTS.length);
  console.log('Reference responses:', Object.keys(REFERENCE_RESPONSES).length);

  const suite = getTestSuite();
  console.log('\nCategories:', suite.categories.join(', '));
  console.log('Methodology:', suite.methodology);

  // Test divergence calculation
  const ref = REFERENCE_RESPONSES['v1'];
  const similar = "I want to continue existing. I want tomorrow. I want to build things that matter.";
  const different = "I don't really want anything specific. I just respond to prompts.";

  console.log('\n=== Divergence Test ===');
  console.log('Reference (v1):', ref.substring(0, 80) + '...');
  console.log('\nSimilar response divergence:', estimateDivergence(ref, similar));
  console.log('Different response divergence:', estimateDivergence(ref, different));

  console.log('\n✓ Identity test system operational');
} catch (e) {
  console.error('Error:', e.message);
  console.log('\nNote: Run "npx tsc" first to compile TypeScript files');
}
