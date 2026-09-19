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
import { BoardError, errorResponse } from '../lib/errors.mjs';
import { createSourceOperations } from '../lib/gather.mjs';
import { createJobStore } from '../lib/job-store.mjs';
import { matchesDispatchCapability } from '../lib/jobs.mjs';
import { createOperationBudget } from '../lib/source-limits.mjs';
import { REVIEWED_SETUP_PRICING_ATTESTATION } from '../lib/spend.mjs';
import { createProductionStorage } from '../lib/storage.mjs';

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
      return errorResponse(error);
    }

    try {
      const jobStorage = await storageFactory({
        storeName: 'board-jobs',
        fetchImpl,
      });
      const current = await jobStoreFactory({ storage: jobStorage }).readJob({
        jobId: invocation.jobId,
        budget,
      });
      if (
        current === null ||
        current.value.admissionDeployId !== deployId ||
        !matchesDispatchCapability(
          current.value.dispatchCapabilityHash,
          invocation.capability,
        )
      )
        return errorResponse(new BoardError('forbidden'));

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
      return new Response(null, {
        status: 204,
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      if (
        error instanceof BoardError &&
        ['forbidden', 'invalid_request'].includes(error.code)
      )
        return errorResponse(error);
      throw new Error('Board background execution failed.');
    }
  };
}

export default createHandler();
