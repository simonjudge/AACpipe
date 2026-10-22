import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const metadataSchema = z.object({
  version: z.string(),
  author: z.string(),
  license: z.string(),
});
const root = process.env['AACPIPE_APP_ROOT'] ?? process.cwd();

export const appInfo = metadataSchema.parse(
  JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as unknown,
);
