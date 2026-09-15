import { describe, expect, it } from 'vitest';

import { summarizeBoard } from '../../src/domain/board.js';

describe('summarizeBoard', () => {
  it('excludes blocked and unclear issues from the ready count', () => {
    expect(
      summarizeBoard([
        { blocked: false, needsClarification: false },
        { blocked: true, needsClarification: false },
        { blocked: false, needsClarification: true },
      ]),
    ).toEqual({
      blocked: 1,
      needsClarification: 1,
      open: 3,
      ready: 1,
    });
  });
});
