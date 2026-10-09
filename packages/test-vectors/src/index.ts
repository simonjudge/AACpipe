export const ipcFixtureRelativePath = '../fixtures/ipc-v1.json' as const;

interface RepeatValue {
  readonly $repeat: string;
  readonly count: number;
}

function isRepeatValue(value: object): value is RepeatValue {
  const candidate = value as Partial<RepeatValue>;
  return (
    Object.keys(value).length === 2 &&
    typeof candidate.$repeat === 'string' &&
    Number.isSafeInteger(candidate.count) &&
    candidate.count !== undefined &&
    candidate.count >= 0 &&
    candidate.count <= 100_000
  );
}

export function materializeFixtureValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => materializeFixtureValue(entry));
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  if (isRepeatValue(value)) {
    return value.$repeat.repeat(value.count);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, materializeFixtureValue(entry)]),
  );
}
