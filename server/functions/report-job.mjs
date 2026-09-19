import { createAnthropicClient } from '../lib/anthropic.mjs';
import {
  createAnalysisWorker,
  ANALYSIS_WORKER_LIMITS,
} from '../lib/analysis-worker.mjs';
import { createAuth } from '../lib/auth.mjs';
import { parseBackgroundInvocation } from '../lib/background.mjs';
import { createCrypto } from '../lib/crypto.mjs';
import {
  readAnalysisEnvironment,
  readEnvironment,
  readPublicOrigin,
  requireCanonicalOrigin,
  requirePublishedDeploy,
} from '../lib/environment.mjs';
import { BoardError } from '../lib/errors.mjs';
import { createSourceOperations } from '../lib/gather.mjs';
import { createJobStore } from '../lib/job-store.mjs';
import { createOperationBudget } from '../lib/source-limits.mjs';
import { REVIEWED_SETUP_PRICING_ATTESTATION } from '../lib/spend.mjs';
import { createProductionStorage } from '../lib/storage.mjs';

// Netlify sends the caller an immediate 202 for a background Function and
// discards the handler return value. Awaiting the worker preserves rejection as
// the platform retry signal; expected completion resolves with no value.
export const config = { background: true };

export function createHandler({
  env = process.env,
  storageFactory = createProductionStorage,
  authFactory = createAuth,
  sourceFactory = createSourceOperations,
  anthropicFactory = createAnthropicClient,
  workerFactory = createAnalysisWorker,
  jobStoreFactory = createJobStore,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  return async function handler(request, context) {
    let invocationStartedAt;
    let budget;
    let deployId;
    let origin;
    let invocation;
    try {
      invocationStartedAt = now();
      budget = createOperationBudget({
        now,
        signal: request.signal,
        limits: { operationMs: ANALYSIS_WORKER_LIMITS.invocationMs },
        startedAt: invocationStartedAt,
      });
      deployId = requirePublishedDeploy(context);
      origin = readPublicOrigin(env);
      requireCanonicalOrigin(request, origin);
      invocation = await parseBackgroundInvocation(request, origin);
    } catch (error) {
      if (error instanceof BoardError) return;
      throw new Error('Board background execution failed.');
    }

    try {
      const jobStorage = await storageFactory({
        storeName: 'board-jobs',
        fetchImpl,
      });
      const current = await jobStoreFactory({
        storage: jobStorage,
      }).authorizeDispatch({
        jobId: invocation.jobId,
        capability: invocation.capability,
        budget,
      });
      if (current.value.admissionDeployId !== deployId)
        throw new BoardError('forbidden');

      const environment = readEnvironment(env);
      const analysisEnvironment = readAnalysisEnvironment(env);
      const [authStorage, reportStorage, spendStorage] = await Promise.all(
        ['board-auth', 'board-reports', 'board-spend'].map((storeName) =>
          storageFactory({ storeName, fetchImpl }),
        ),
      );
      const auth = authFactory({
        config: environment,
        storage: authStorage,
        crypto: createCrypto({ keyring: environment.keyring }),
        fetchImpl,
        now,
      });
      const sourceOperations = sourceFactory({
        appId: environment.appId,
        ownerId: environment.ownerId,
        fetchImpl,
        now,
      });
      const anthropicClient = anthropicFactory({
        apiKey: analysisEnvironment.apiKey,
        fetchImpl,
      });
      const worker = workerFactory({
        auth,
        sourceOperations,
        anthropicClient,
        reportStorage,
        jobStorage,
        spendStorage,
        deployId,
        pricingAttestation: REVIEWED_SETUP_PRICING_ATTESTATION,
        now,
      });
      await worker.run({
        ...invocation,
        budget,
        signal: request.signal,
        invocationStartedAt,
      });
    } catch (error) {
      if (
        error instanceof BoardError &&
        ['forbidden', 'invalid_request'].includes(error.code)
      )
        return;
      throw new Error('Board background execution failed.');
    }
  };
}

export default createHandler();
