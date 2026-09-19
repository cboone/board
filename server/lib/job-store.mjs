import { BoardError } from './errors.mjs';
import { canonicalStringify } from './fingerprint.mjs';
import { projectJobMachine, transitionJob } from './job-machine.mjs';
import {
  createAnalysisJob,
  deriveAnalysisJobIdentity,
  matchesDispatchCapability,
  projectSafeJob,
} from './jobs.mjs';

const HEX_64 = /^[a-f0-9]{64}$/u;
const unavailable = () => new BoardError('service_unavailable');
const same = (left, right) =>
  canonicalStringify(left) === canonicalStringify(right);
const keyFor = (jobId) => {
  if (typeof jobId !== 'string' || !HEX_64.test(jobId)) throw unavailable();
  return `jobs/${jobId}`;
};
const validStorage = (storage) =>
  storage &&
  typeof storage.read === 'function' &&
  typeof storage.write === 'function';

async function readStored(storage, jobId, budget) {
  if (!validStorage(storage) || !budget) throw unavailable();
  const result = await storage.read(keyFor(jobId), { budget });
  if (result === null) return null;
  return {
    value: projectJobMachine(result.value),
    etag: result.etag,
  };
}

function assertTuple(
  job,
  { ownerId, repositoryId, operation, expectedCurrentReportId },
) {
  if (
    job.ownerId !== ownerId ||
    job.repositoryId !== repositoryId ||
    job.operation !== operation ||
    job.expectedCurrentReportId !== expectedCurrentReportId
  )
    throw new BoardError('idempotency_conflict');
  return job;
}

export function createJobStore({ storage }) {
  if (!validStorage(storage)) throw unavailable();

  async function readJob({ jobId, budget }) {
    return readStored(storage, jobId, budget);
  }

  async function createOrReadJob({
    ownerId,
    repositoryId,
    idempotencyKey,
    operation,
    expectedCurrentReportId,
    authorizationEpoch,
    admissionDeployId,
    at,
    deadlineAt,
    budget,
  }) {
    const identity = deriveAnalysisJobIdentity({
      ownerId,
      repositoryId,
      idempotencyKey,
    });
    const existing = await readStored(storage, identity.jobId, budget);
    if (existing)
      return {
        status: 'existing',
        ...existing,
        value: assertTuple(existing.value, {
          ownerId,
          repositoryId,
          operation,
          expectedCurrentReportId,
        }),
      };
    const candidate = projectJobMachine(
      createAnalysisJob({
        ownerId,
        repositoryId,
        idempotencyKey,
        operation,
        expectedCurrentReportId,
        authorizationEpoch,
        admissionDeployId,
        at,
        deadlineAt,
      }),
    );
    try {
      const write = await storage.write(
        keyFor(identity.jobId),
        candidate,
        { onlyIfNew: true },
        { budget },
      );
      if (write?.modified === true)
        return {
          status: 'created',
          value: candidate,
          etag: write.etag,
        };
    } catch {
      // A committed write can lose its acknowledgement. The exact strong read
      // below distinguishes that outcome from an absent or conflicting write.
    }
    const observed = await readStored(storage, identity.jobId, budget);
    if (!observed) throw unavailable();
    return {
      status: same(observed.value, candidate) ? 'recovered' : 'existing',
      ...observed,
      value: assertTuple(observed.value, {
        ownerId,
        repositoryId,
        operation,
        expectedCurrentReportId,
      }),
    };
  }

  async function applyTransition({ jobId, event, budget, expectedEtag }) {
    const current = await readStored(storage, jobId, budget);
    if (!current) throw new BoardError('report_not_found');
    if (expectedEtag !== undefined && current.etag !== expectedEtag)
      return { status: 'conflict', ...current };
    const candidate = transitionJob(current.value, event);
    let write;
    try {
      write = await storage.write(
        keyFor(jobId),
        candidate,
        { onlyIfMatch: current.etag },
        { budget },
      );
      if (write?.modified === true)
        return {
          status: 'updated',
          value: candidate,
          etag: write.etag,
        };
    } catch {
      // Resolve one uncertain conditional write without replaying the event.
    }
    const observed = await readStored(storage, jobId, budget);
    if (!observed) throw unavailable();
    return same(observed.value, candidate)
      ? { status: 'recovered', ...observed }
      : { status: 'conflict', ...observed };
  }

  async function safeJob({ jobId, ownerId, budget }) {
    const result = await readStored(storage, jobId, budget);
    if (!result || result.value.ownerId !== ownerId)
      throw new BoardError('report_not_found');
    return projectSafeJob(result.value);
  }

  async function authorizeDispatch({ jobId, capability, budget }) {
    const result = await readStored(storage, jobId, budget);
    if (
      !result ||
      result.value.state !== 'dispatchable' ||
      !matchesDispatchCapability(
        result.value.dispatchCapabilityHash,
        capability,
      )
    )
      throw new BoardError('forbidden');
    return result;
  }

  return Object.freeze({
    readJob,
    createOrReadJob,
    applyTransition,
    safeJob,
    authorizeDispatch,
  });
}
