export function isLocalEnvironment(
  nodeEnvironment: string | undefined,
): boolean {
  const normalized = nodeEnvironment?.trim().toLowerCase();
  return normalized === 'development' || normalized === 'test';
}

export function parseBooleanEnvironmentVariable(
  name: string,
  value: string | undefined,
): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(
    `${name} must be a boolean value (true/false, 1/0, yes/no, or on/off).`,
  );
}
