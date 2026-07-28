import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointCaptureResult } from '../../shared/sessions.js';
import { checkpointJob, resetCheckpointJobsForTests, startCheckpointJob, subscribeCheckpointJobs } from './checkpoint-jobs.js';

afterEach(() => resetCheckpointJobsForTests());

async function waitForJob(operationId: string): Promise<ReturnType<typeof checkpointJob>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = checkpointJob(operationId);
    if (current && (current.state === 'success' || current.state === 'failed')) return current;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('checkpoint job did not finish');
}

describe('checkpoint job progress', () => {
  it('publishes progress and keeps only sanitized failure details', async () => {
    const payloadStates: string[][] = [];
    const unsubscribe = subscribeCheckpointJobs((payload) => {
      payloadStates.push(payload.jobs.map((job) => job.state));
    });
    const secret = `sk-${'z'.repeat(24)}`;
    const started = startCheckpointJob(async (operationId, onProgress) => {
      onProgress({
        operationId,
        checkpointId: null,
        step: 'preparing',
        state: 'running',
        message: `Synthetic preparation ${secret}`,
        occurredAt: new Date().toISOString(),
      });
      throw Object.assign(new Error(`Synthetic failure ${secret}`), { code: 'synthetic-failure' });
    });
    const finished = await waitForJob(started.operationId);
    unsubscribe();

    expect(finished).toMatchObject({
      state: 'failed',
      error: { code: 'synthetic-failure' },
      progress: [{ step: 'preparing', message: 'Synthetic preparation [REDACTED:provider-api-key]' }],
    });
    expect(finished?.error?.message).toContain('[REDACTED:provider-api-key]');
    expect(JSON.stringify(finished)).not.toContain(secret);
    expect(payloadStates.some((states) => states.includes('running'))).toBe(true);
    expect(payloadStates.at(-1)).toContain('failed');
  });

  it('retains a completed checkpoint result for status polling', async () => {
    const result = {
      operationId: 'replaced-by-handler',
      checkpoint: {
        schemaVersion: 1,
        eventType: 'checkpoint',
        eventId: 'event-id',
        checkpointId: 'checkpoint-id',
        parentCheckpointIds: [],
        resumedFromCheckpointId: null,
        sessionId: 'session-id',
        provider: 'codex',
        providerSessionId: 'provider-session-id',
        title: 'Synthetic checkpoint',
        projectId: 'project-id',
        repositoryId: null,
        branch: null,
        head: null,
        machine: 'fixture-machine',
        createdAt: new Date().toISOString(),
        payloadPath: 'objects/checkpoint-id',
        capabilities: { nativeResume: false, universalHandoff: true, codeReachable: false, wipRef: null, sourceSync: null },
      },
      commitHash: 'a'.repeat(40),
      durationMs: 10,
    } satisfies CheckpointCaptureResult;
    const started = startCheckpointJob(async (operationId) => ({ ...result, operationId }));
    const finished = await waitForJob(started.operationId);
    expect(finished).toMatchObject({ state: 'success', result: { operationId: started.operationId } });
  });
});
