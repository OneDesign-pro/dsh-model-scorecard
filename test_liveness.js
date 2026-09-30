// Test for liveness.js queuing behavior

import { createLiveness } from './lib/liveness.js';

// Mock ctx
const ctx = {
  get: () => undefined
};

async function test() {
  const liveness = createLiveness(ctx, { persist: false });

  console.log('Test 1: Start check for model A');
  const snap1 = await liveness.start({ provider: 'openrouter', model: 'modelA' });
  console.log('Snapshot 1:', JSON.stringify({
    queue: snap1.job?.queue?.map(p => `${p.provider}/${p.model}`) || [],
    total: snap1.job?.total,
    done: snap1.job?.done,
    pending: snap1.pending,
    running: snap1.running
  }, null, 2));

  console.log('\nTest 2: Start check for model B while A is still checking');
  const snap2 = await liveness.start({ provider: 'openrouter', model: 'modelB' });
  console.log('Snapshot 2:', JSON.stringify({
    queue: snap2.job?.queue?.map(p => `${p.provider}/${p.model}`) || [],
    total: snap2.job?.total,
    done: snap2.job?.done,
    pending: snap2.pending,
    running: snap2.running
  }, null, 2));

  // Wait a bit to see if processing starts
  await new Promise(resolve => setTimeout(resolve, 100));

  console.log('\nTest 3: After 100ms');
  const snap3 = await liveness.get();
  console.log('Snapshot 3:', JSON.stringify({
    queue: snap3.job?.queue?.map(p => `${p.provider}/${p.model}`) || [],
    total: snap3.job?.total,
    done: snap3.job?.done,
    pending: snap3.pending,
    running: snap3.running
  }, null, 2));

  // Wait for the checks to complete (they will fail quickly because we have no real llm)
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('\nTest 4: After 2000ms');
  const snap4 = await liveness.get();
  console.log('Snapshot 4:', JSON.stringify({
    queue: snap4.job?.queue?.map(p => `${p.provider}/${p.model}`) || [],
    total: snap4.job?.total,
    done: snap4.job?.done,
    pending: snap4.pending,
    running: snap4.running
  }, null, 2));
}

test().catch(console.error);