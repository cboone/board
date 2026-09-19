import { createApi } from '../lib/api.mjs';
import { createAnalysisAdmission } from '../lib/analysis-admission.mjs';
import { createAnalysisPreflight } from '../lib/analysis-preflight.mjs';
import { createAnthropicClient } from '../lib/anthropic.mjs';
import {
  createAnalysisDurableServices,
  createAnalysisReconciler,
} from '../lib/analysis-reconciler.mjs';
import { createAuth } from '../lib/auth.mjs';
import { createCrypto } from '../lib/crypto.mjs';
import {
  readAnalysisEnvironment,
  readEnvironment,
  readPublicOrigin,
  requireCanonicalOrigin,
  requirePublishedDeploy,
} from '../lib/environment.mjs';
import { errorResponse } from '../lib/errors.mjs';
import { createProductionStorage } from '../lib/storage.mjs';
import { createSourceOperations } from '../lib/gather.mjs';
import { createReportOperations } from '../lib/report-operations.mjs';
import { createOperationBudget } from '../lib/source-limits.mjs';
import { REVIEWED_SETUP_PRICING_ATTESTATION } from '../lib/spend.mjs';

export const config = { path: '/api/*' };

function requiresReportOperations(request) {
  const path = new URL(request.url).pathname;
  return (
    (request.method === 'GET' &&
      ['/api/reports', '/api/analysis-availability'].includes(path)) ||
    (request.method === 'POST' && path === '/api/setup-budget-decision') ||
    (request.method === 'POST' &&
      /^\/api\/repositories\/[1-9]\d*\/(?:analysis-preflight|check|report-jobs)$/u.test(
        path,
      )) ||
    (request.method === 'GET' &&
      /^\/api\/repositories\/[1-9]\d*\/report$/u.test(path)) ||
    (request.method === 'GET' &&
      /^\/api\/report-jobs\/[a-f0-9]{64}$/u.test(path))
  );
}

function requiresAnalysisPreflight(request) {
  return (
    request.method === 'POST' &&
    /^\/api\/repositories\/[1-9]\d*\/analysis-preflight$/u.test(
      new URL(request.url).pathname,
    )
  );
}

export function createHandler({
  env = process.env,
  storageFactory = createProductionStorage,
  sourceFactory = createSourceOperations,
  authFactory = createAuth,
  admissionFactory = createAnalysisAdmission,
  preflightFactory = createAnalysisPreflight,
  anthropicFactory = createAnthropicClient,
  reconcilerFactory = createAnalysisReconciler,
  reportFactory = createReportOperations,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  return async function handler(request, context) {
    try {
      const deployId = requirePublishedDeploy(context);
      const origin = readPublicOrigin(env);
      requireCanonicalOrigin(request, origin);
      const environment = readEnvironment(env);
      const authStorage = await storageFactory({
        storeName: 'board-auth',
        fetchImpl,
      });
      const crypto = createCrypto({ keyring: environment.keyring });
      const auth = authFactory({
        config: environment,
        storage: authStorage,
        crypto,
        fetchImpl,
        now,
      });
      const sourceOperations = sourceFactory({
        appId: environment.appId,
        ownerId: environment.ownerId,
        fetchImpl,
        now,
      });
      let reportOperations = null;
      let analysisPreflight = null;
      if (requiresReportOperations(request)) {
        const [reportStorage, jobStorage, spendStorage] = await Promise.all(
          ['board-reports', 'board-jobs', 'board-spend'].map((storeName) =>
            storageFactory({ storeName, fetchImpl }),
          ),
        );
        const durable = createAnalysisDurableServices({
          reportStorage,
          jobStorage,
          spendStorage,
          deployId,
          pricingAttestation: REVIEWED_SETUP_PRICING_ATTESTATION,
        });
        const reconciler = reconcilerFactory({ ...durable, now });
        const admission = admissionFactory({
          reportStorage,
          jobStorage,
          spendStorage,
          deployId,
          origin,
          pricingAttestation: REVIEWED_SETUP_PRICING_ATTESTATION,
          fetchImpl,
          now,
        });
        reportOperations = reportFactory({
          reportStorage,
          jobStorage,
          spendStorage,
          sourceOperations,
          admission,
          reconcile: reconciler.reconcile,
          deployId,
          pricingAttestation: REVIEWED_SETUP_PRICING_ATTESTATION,
          now,
        });
        if (requiresAnalysisPreflight(request))
          analysisPreflight = preflightFactory({
            reportStorage,
            spendStorage,
            sourceOperations,
            deployId,
            pricingAttestation: REVIEWED_SETUP_PRICING_ATTESTATION,
            createProvider: () => {
              const { apiKey } = readAnalysisEnvironment(env);
              const client = anthropicFactory({ apiKey, fetchImpl });
              return Object.freeze({
                retrieveModel: (options) => client.retrieveModel(options),
                countTokens: (options) => client.countTokens(options),
              });
            },
            now,
          });
      }
      return await createApi({
        auth,
        sourceOperations,
        reportOperations,
        analysisPreflight,
        createOperationBudget: (options) =>
          createOperationBudget({ ...options, now }),
      })(request);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export default createHandler();
