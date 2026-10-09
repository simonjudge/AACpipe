import { readFileSync } from 'node:fs';

import { materializeFixtureValue } from '@aacpipe/test-vectors';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ipcRequestSchema, ipcResponseSchema } from './index.js';

const fixtureCaseSchema = z.object({
  name: z.string().min(1),
  input: z.unknown(),
  expected: z.unknown().optional(),
});

const fixtureSchema = z.object({
  fixtureVersion: z.literal(1),
  validRequests: z.array(fixtureCaseSchema),
  invalidRequests: z.array(fixtureCaseSchema),
  validResponses: z.array(fixtureCaseSchema),
  invalidResponses: z.array(fixtureCaseSchema),
});

const fixturePath = new URL('../../test-vectors/fixtures/ipc-v1.json', import.meta.url);
const fixture = fixtureSchema.parse(JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown);

describe('shared IPC contract fixtures', () => {
  for (const testCase of fixture.validRequests) {
    it(`accepts request: ${testCase.name}`, () => {
      const result = ipcRequestSchema.safeParse(materializeFixtureValue(testCase.input));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(materializeFixtureValue(testCase.expected ?? testCase.input));
      }
    });
  }

  for (const testCase of fixture.invalidRequests) {
    it(`rejects request: ${testCase.name}`, () => {
      expect(ipcRequestSchema.safeParse(materializeFixtureValue(testCase.input)).success).toBe(
        false,
      );
    });
  }

  for (const testCase of fixture.validResponses) {
    it(`accepts response: ${testCase.name}`, () => {
      const result = ipcResponseSchema.safeParse(materializeFixtureValue(testCase.input));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(materializeFixtureValue(testCase.expected ?? testCase.input));
      }
    });
  }

  for (const testCase of fixture.invalidResponses) {
    it(`rejects response: ${testCase.name}`, () => {
      expect(ipcResponseSchema.safeParse(materializeFixtureValue(testCase.input)).success).toBe(
        false,
      );
    });
  }
});
