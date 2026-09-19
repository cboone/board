import { createApi } from '../lib/api.mjs';
import { createAnalysisAdmission } from '../lib/analysis-admission.mjs';
import {
  createAnalysisDurableServices,
  createAnalysisReconciler,
} from '../lib/analysis-reconciler.mjs';
import { createAuth } from '../lib/auth.mjs';
import { createCrypto } from '../lib/crypto.mjs';
import {
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

export function createHandler({
  env = process.env,
  storageFactory = createProductionStorage,
  sourceFactory = createSourceOperations,
  authFactory = createAuth,
  admissionFactory = createAnalysisAdmission,
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
      const [authStorage, reportStorage, jobStorage, spendStorage] =
        await Promise.all(
          [
            ['board-auth', storageFactory],
            ['board-reports', storageFactory],
            ['board-jobs', storageFactory],
            ['board-spend', storageFactory],
          ].map(([storeName, factory]) => factory({ storeName, fetchImpl })),
        );
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
      const reportOperations = reportFactory({
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
      return await createApi({
        auth,
        sourceOperations,
        reportOperations,
        createOperationBudget: (options) =>
          createOperationBudget({ ...options, now }),
      })(request);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export default createHandler();
