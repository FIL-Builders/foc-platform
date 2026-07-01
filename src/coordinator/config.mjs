import { getAddress, isAddress, keccak256, stringToHex } from "viem";

export const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

export const DEFAULT_COORDINATOR_ENV = Object.freeze({
  mode: "local-dev",
  network: "local-simulated",
  runner: "simulated-synapse",
});

export class CoordinatorConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CoordinatorConfigError";
    this.code = code;
    this.details = details;
  }
}

export function loadCoordinatorConfig(env = process.env) {
  const config = {
    mode: stringValue(env.FOC_COORDINATOR_MODE, DEFAULT_COORDINATOR_ENV.mode),
    network: stringValue(env.FOC_COORDINATOR_NETWORK, DEFAULT_COORDINATOR_ENV.network),
    runner: stringValue(env.FOC_COORDINATOR_RUNNER, DEFAULT_COORDINATOR_ENV.runner),
    registryAddress: optionalAddress(env.FOC_PLATFORM_REGISTRY_ADDRESS, "registryAddress"),
    coordinatorAddress: optionalAddress(env.FOC_COORDINATOR_ADDRESS, "coordinatorAddress"),
    rootAddress: optionalAddress(env.FOC_ROOT_ADDRESS, "rootAddress"),
    sessionKeyAddress: optionalAddress(env.FOC_SESSION_KEY_ADDRESS, "sessionKeyAddress"),
    sessionKeyExpiresAt: optionalUint(env.FOC_SESSION_KEY_EXPIRES_AT, "sessionKeyExpiresAt"),
    permissionsHash: normalizeBytes32(
      env.FOC_SESSION_KEY_PERMISSIONS_HASH,
      "permissionsHash",
      ZERO_BYTES32,
    ),
    maxBytes: optionalUint(env.FOC_COORDINATOR_MAX_BYTES, "maxBytes"),
    defaultRequestedCopies: optionalUint8(
      env.FOC_COORDINATOR_DEFAULT_REQUESTED_COPIES,
      "defaultRequestedCopies",
    ) ?? 2,
  };

  assertNoSecretMaterial(config, env);
  if (!Number.isInteger(config.defaultRequestedCopies) || config.defaultRequestedCopies < 1) {
    throw new CoordinatorConfigError(
      "invalid_default_requested_copies",
      "default requested copy count must be a positive integer",
    );
  }
  return Object.freeze(config);
}

export function createCoordinatorSessionKey({
  address,
  rootAddress,
  expiresAt = 0n,
  permissionsHash = ZERO_BYTES32,
  signer,
} = {}) {
  if (signer && typeof signer !== "object" && typeof signer !== "function") {
    throw new CoordinatorConfigError("invalid_session_signer", "session signer must be an adapter");
  }

  return Object.freeze({
    address: requiredAddress(address, "sessionKeyAddress"),
    rootAddress: requiredAddress(rootAddress, "rootAddress"),
    expiresAt: normalizeUint(expiresAt, "sessionKeyExpiresAt"),
    permissionsHash: normalizeBytes32(permissionsHash, "permissionsHash", ZERO_BYTES32),
    signer,
  });
}

export function assertActiveSessionKey(sessionKey, {
  now = currentUnixTime(),
  requiredPermissionsHash = ZERO_BYTES32,
  requiredSessionKeyAddress,
  requiredSessionKeyExpiresAt,
  requiredRootAddress,
} = {}) {
  if (!sessionKey) {
    throw new CoordinatorConfigError("missing_session_key", "coordinator session key is required");
  }
  const expectedSessionKeyAddress = optionalAddress(
    requiredSessionKeyAddress,
    "requiredSessionKeyAddress",
  );
  if (
    expectedSessionKeyAddress &&
    optionalAddress(sessionKey.address, "sessionKeyAddress") !== expectedSessionKeyAddress
  ) {
    throw new CoordinatorConfigError(
      "session_key_address_mismatch",
      "coordinator session key address does not match config",
      {
        expected: expectedSessionKeyAddress,
        actual: sessionKey.address,
      },
    );
  }
  const expectedRootAddress = optionalAddress(requiredRootAddress, "requiredRootAddress");
  if (
    expectedRootAddress &&
    optionalAddress(sessionKey.rootAddress, "rootAddress") !== expectedRootAddress
  ) {
    throw new CoordinatorConfigError(
      "session_key_root_mismatch",
      "coordinator session key root address does not match config",
      {
        expected: expectedRootAddress,
        actual: sessionKey.rootAddress,
      },
    );
  }
  if (sessionKey.expiresAt !== 0n && BigInt(now) > sessionKey.expiresAt) {
    throw new CoordinatorConfigError("expired_session_key", "coordinator session key is expired", {
      sessionKeyAddress: sessionKey.address,
      expiresAt: sessionKey.expiresAt.toString(),
      now: BigInt(now).toString(),
    });
  }
  if (requiredSessionKeyExpiresAt !== undefined && requiredSessionKeyExpiresAt !== null) {
    const expectedExpiresAt = normalizeUint(requiredSessionKeyExpiresAt, "requiredSessionKeyExpiresAt");
    if (expectedExpiresAt !== 0n && BigInt(now) > expectedExpiresAt) {
      throw new CoordinatorConfigError(
        "expired_session_key",
        "configured coordinator session key is expired",
        {
          sessionKeyAddress: sessionKey.address,
          expiresAt: expectedExpiresAt.toString(),
          now: BigInt(now).toString(),
        },
      );
    }
    if (
      expectedExpiresAt !== 0n &&
      (sessionKey.expiresAt === 0n || sessionKey.expiresAt > expectedExpiresAt)
    ) {
      throw new CoordinatorConfigError(
        "session_key_expiry_mismatch",
        "coordinator session key expiry exceeds config",
        {
          maximum: expectedExpiresAt.toString(),
          actual: sessionKey.expiresAt.toString(),
        },
      );
    }
  }

  const expected = normalizeBytes32(requiredPermissionsHash, "requiredPermissionsHash", ZERO_BYTES32);
  if (
    expected !== ZERO_BYTES32 &&
    normalizeBytes32(sessionKey.permissionsHash, "permissionsHash", ZERO_BYTES32) !== expected
  ) {
    throw new CoordinatorConfigError(
      "permissions_hash_mismatch",
      "coordinator session key permissions do not match config",
      {
        expected,
        actual: sessionKey.permissionsHash,
      },
    );
  }
  return true;
}

export function derivePermissionsHash(permissions) {
  return keccak256(stringToHex(JSON.stringify(stableJson(permissions))));
}

export function publicCoordinatorConfig(config) {
  return Object.freeze({
    mode: config.mode,
    network: config.network,
    runner: config.runner,
    registryAddress: config.registryAddress,
    coordinatorAddress: config.coordinatorAddress,
    rootAddress: config.rootAddress,
    sessionKeyAddress: config.sessionKeyAddress,
    sessionKeyExpiresAt: config.sessionKeyExpiresAt?.toString(),
    permissionsHash: config.permissionsHash,
    maxBytes: config.maxBytes?.toString(),
    defaultRequestedCopies: config.defaultRequestedCopies,
  });
}

function assertNoSecretMaterial(config, env) {
  const secretKeys = Object.keys(env).filter((key) =>
    /(^FOC_.*PRIVATE_KEY$|^FOC_.*MNEMONIC$|^FOC_.*SEED$|^FOC_.*SECRET$)/.test(key),
  );
  if (secretKeys.length > 0) {
    throw new CoordinatorConfigError(
      "secret_material_in_config",
      "coordinator config must receive signer adapters, not raw private key environment values",
      { keys: secretKeys },
    );
  }
  return config;
}

function requiredAddress(value, label) {
  const address = optionalAddress(value, label);
  if (!address) throw new CoordinatorConfigError(`missing_${label}`, `${label} is required`);
  return address;
}

function optionalAddress(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isAddress(value)) {
    throw new CoordinatorConfigError(`invalid_${label}`, `${label} must be an EVM address`);
  }
  return getAddress(value);
}

function optionalUint(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  return normalizeUint(value, label);
}

function optionalUint8(value, label) {
  const bigint = optionalUint(value, label);
  if (bigint === undefined) return undefined;
  if (bigint > 255n) {
    throw new CoordinatorConfigError(`invalid_${label}`, `${label} must fit uint8`);
  }
  return Number(bigint);
}

function normalizeUint(value, label) {
  let bigint;
  try {
    bigint = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new CoordinatorConfigError(`invalid_${label}`, `${label} must be an unsigned integer`);
  }
  if (bigint < 0n) {
    throw new CoordinatorConfigError(`invalid_${label}`, `${label} must be an unsigned integer`);
  }
  return bigint;
}

function normalizeBytes32(value, label, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new CoordinatorConfigError(`invalid_${label}`, `${label} must be bytes32`);
  }
  return value.toLowerCase();
}

function stringValue(value, fallback) {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function currentUnixTime() {
  return BigInt(Math.floor(Date.now() / 1000));
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableJson(item)]),
    );
  }
  return value;
}
