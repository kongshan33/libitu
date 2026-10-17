import test from 'node:test';
import assert from 'node:assert/strict';
import {referencePhase} from '../features/stage-two/practice/reference-phase.ts';

const idle = {preparing:false,uploading:false,serverError:false,localPending:false,localError:false,localUsable:false};
test('completed saved reference stays ready while local preview runs or fails', () => {
  assert.equal(referencePhase({...idle,serverState:'completed',localPending:true}), 'ready');
  assert.equal(referencePhase({...idle,serverState:'completed',localError:true}), 'ready');
  assert.equal(referencePhase({...idle,serverState:'completed',preparing:true}), 'preparing');
});
test('local usable audio cannot conceal server deletion, errors or pending work', () => {
  for (const serverState of ['deleted','failed','cancelled','partially_completed','awaiting_upload'])
    assert.equal(referencePhase({...idle,serverState,localUsable:true}), 'review');
  assert.equal(referencePhase({...idle,serverState:'completed',serverError:true}), 'review');
  assert.equal(referencePhase({...idle,serverState:'processing',localUsable:true}), 'analyzing');
  assert.equal(referencePhase({...idle,localUsable:true}), 'ready');
  assert.equal(referencePhase(idle), 'idle');
});
