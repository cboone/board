import { createApi } from '../lib/api.mjs';
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
import { createOperationBudget } from '../lib/source-limits.mjs';

export const config = { path: '/api/*' };

export function createHandler({
  env = process.env,
  storageFactory = createProductionStorage,
  sourceFactory = createSourceOperations,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  return async function handler(request, context) {
    try {
      requirePublishedDeploy(context);
      const origin = readPublicOrigin(env);
      requireCanonicalOrigin(request, origin);
      const environment = readEnvironment(env);
      const storage = await storageFactory({ fetchImpl });
      const crypto = createCrypto({ keyring: environment.keyring });
      const auth = createAuth({
        config: environment,
        storage,
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
      return await createApi({
        auth,
        sourceOperations,
        createOperationBudget: (options) =>
          createOperationBudget({ ...options, now }),
      })(request);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export default createHandler();
