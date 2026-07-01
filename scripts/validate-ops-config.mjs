import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_LIMITS = Object.freeze({
  FOC_PLATFORM_API_RATE_LIMIT_RPM: 60,
  FOC_PLATFORM_API_TIMEOUT_MS: 10_000,
  FOC_COORDINATOR_UPLOAD_TIMEOUT_MS: 120_000,
  FOC_COORDINATOR_PROVIDER_TIMEOUT_MS: 120_000,
  FOC_COORDINATOR_MAX_RETRIES: 3,
  FOC_COORDINATOR_RETRY_BACKOFF_MS: 1_000,
  FOC_RECONCILIATION_INTERVAL_SECONDS: 300,
});

const SCOPED_SECRET_ENV_PATTERN =
  /^(?:PRIVATE_KEY|MNEMONIC|SEED|PLATFORM_ROOT_(?:PRIVATE_KEY|MNEMONIC|SEED|SECRET)|COORDINATOR_(?:PRIVATE_KEY|MNEMONIC|SEED|SECRET)|FOC_.*(?:PRIVATE_KEY|MNEMONIC|SEED|SECRET))$/;
const GENERIC_SECRET_ENV_PATTERN = /(?:PRIVATE_KEY|MNEMONIC|SEED|SECRET)$/;
const RAW_HEX_SECRET_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TRACKED_SECRET_PATTERN =
  /(?:\b[A-Z0-9_]*(?:PRIVATE_KEY|MNEMONIC|SEED|SECRET)[A-Z0-9_]*\b|["']?(?:privateKey|mnemonic|seed|secret)["']?)\s*[:=]\s*["']?0x[0-9a-fA-F]{64}\b/g;

export class OpsConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OpsConfigError";
    this.code = code;
    this.details = details;
  }
}

export async function validateOpsConfig({
  env = process.env,
  args = process.argv.slice(2),
  workspaceRoot = process.cwd(),
  scanFiles = true,
} = {}) {
  const profile = resolveProfile(env, args);
  const limits = resolveLimits(env);
  const checks = {
    profile,
    limits,
    productionReady: false,
    docs: await validateRunbook(workspaceRoot),
  };

  if (scanFiles) {
    checks.secretScan = await scanTrackedFilesForSecrets(workspaceRoot);
  }

  if (profile === "production") {
    rejectRawSecretEnv(env);
    checks.kms = validateProductionKms(env);
  } else {
    checks.kms = {
      required: false,
      rootConfigured: Boolean(env.FOC_PLATFORM_ROOT_KMS_KEY_REF),
      coordinatorConfigured: Boolean(env.FOC_COORDINATOR_KMS_KEY_REF),
    };
  }

  return {
    ok: true,
    profile,
    productionReady: false,
    checks,
  };
}

function resolveProfile(env, args) {
  const argProfile = optionValue(args, "--profile");
  const profile = String(argProfile ?? env.FOC_PLATFORM_OPS_PROFILE ?? "demo").toLowerCase();
  if (profile === "prod") return "production";
  if (profile === "demo" || profile === "development" || profile === "production") {
    return profile;
  }
  throw new OpsConfigError("invalid_profile", "operations profile must be demo, development, or production", {
    profile,
  });
}

function resolveLimits(env) {
  return Object.fromEntries(
    Object.entries(DEFAULT_LIMITS).map(([name, fallback]) => [
      name,
      positiveInteger(env[name], name, fallback),
    ]),
  );
}

function positiveInteger(value, name, fallback) {
  const raw = value === undefined || value === null || value === "" ? fallback : value;
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    throw new OpsConfigError("invalid_limit", `${name} must be a positive integer`, {
      name,
      value: String(raw),
    });
  }
  return number;
}

function rejectRawSecretEnv(env) {
  const keys = Object.keys(env)
    .filter((key) => env[key] !== undefined && env[key] !== null && String(env[key]) !== "")
    .filter(
      (key) =>
        SCOPED_SECRET_ENV_PATTERN.test(key) ||
        (GENERIC_SECRET_ENV_PATTERN.test(key) && RAW_HEX_SECRET_PATTERN.test(String(env[key]))),
    );
  if (keys.length > 0) {
    throw new OpsConfigError(
      "raw_secret_env",
      "production profile must use KMS/signer refs instead of raw secret env values",
      { keys },
    );
  }
}

function validateProductionKms(env) {
  const required = [
    "FOC_PLATFORM_ROOT_KMS_KEY_REF",
    "FOC_COORDINATOR_KMS_KEY_REF",
    "FOC_PLATFORM_ADMIN_AUTH_AUDIENCE",
  ];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new OpsConfigError("missing_production_config", "production profile is missing required config", {
      missing,
    });
  }
  for (const key of ["FOC_PLATFORM_ROOT_KMS_KEY_REF", "FOC_COORDINATOR_KMS_KEY_REF"]) {
    if (RAW_HEX_SECRET_PATTERN.test(String(env[key]))) {
      throw new OpsConfigError("raw_secret_env", `${key} must be a KMS/signer reference, not a raw key`, {
        keys: [key],
      });
    }
  }
  return {
    required: true,
    rootConfigured: true,
    coordinatorConfigured: true,
    adminAudienceConfigured: true,
  };
}

async function validateRunbook(workspaceRoot) {
  const pkg = JSON.parse(await readFile(resolve(workspaceRoot, "package.json"), "utf8"));
  for (const script of ["ops:validate", "ops:smoke", "test:ops"]) {
    if (!pkg.scripts?.[script]) {
      throw new OpsConfigError("missing_package_script", `package.json is missing ${script}`, {
        script,
      });
    }
  }

  const runbook = await readFile(
    resolve(workspaceRoot, "docs/production-hardening-runbook.md"),
    "utf8",
  );
  for (const phrase of [
    "Threat Model",
    "Secret Management",
    "Rate Limits And Timeouts",
    "Reconciliation Runbook",
    "Remaining Production Gates",
    "productionReady",
    "foc-platform/issues/6",
    "foc-platform/issues/11",
  ]) {
    if (!runbook.includes(phrase)) {
      throw new OpsConfigError("runbook_missing_evidence", "production runbook is missing required evidence", {
        phrase,
      });
    }
  }

  return {
    runbook: "docs/production-hardening-runbook.md",
    packageScripts: ["ops:validate", "ops:smoke", "test:ops"],
  };
}

async function scanTrackedFilesForSecrets(workspaceRoot) {
  const { stdout } = await execFileAsync("git", ["ls-files"], {
    cwd: workspaceRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  const files = stdout.split(/\r?\n/).filter(Boolean);
  const findings = [];

  for (const file of files) {
    let text;
    try {
      text = await readFile(resolve(workspaceRoot, file), "utf8");
    } catch {
      continue;
    }
    TRACKED_SECRET_PATTERN.lastIndex = 0;
    const matches = [...text.matchAll(TRACKED_SECRET_PATTERN)];
    for (const match of matches) {
      findings.push({
        file,
        offset: match.index,
      });
    }
  }

  if (findings.length > 0) {
    throw new OpsConfigError("tracked_secret_material", "tracked files contain concrete secret material", {
      findings,
    });
  }

  return {
    trackedFiles: files.length,
    findings: 0,
  };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateOpsConfig()
    .then((result) => {
      console.log(JSON.stringify(result, jsonReplacer, 2));
    })
    .catch((error) => {
      const payload = {
        ok: false,
        code: error.code ?? "ops_validation_failed",
        message: error.message,
        details: error.details ?? {},
      };
      console.error(JSON.stringify(payload, jsonReplacer, 2));
      process.exitCode = 1;
    });
}
