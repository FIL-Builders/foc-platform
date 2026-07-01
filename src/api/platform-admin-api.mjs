import { PlatformApiError } from "./platform-api.mjs";
import { buildAdminSurfaces } from "../admin/reconciliation.mjs";

export const PLATFORM_ADMIN_API_ROUTES = Object.freeze({
  dashboard: "GET /admin/storage/dashboard",
  objects: "GET /admin/storage/objects",
  object: "GET /admin/storage/objects/:objectId",
  usage: "GET /admin/storage/usage",
  datasets: "GET /admin/storage/datasets",
  coordinators: "GET /admin/storage/coordinators",
  reconciliation: "GET /admin/storage/reconciliation",
});

export function createStaticAdminAuthorizer({
  token,
  headerName = "x-platform-admin-token",
} = {}) {
  if (!token) {
    throw new Error("createStaticAdminAuthorizer requires a token");
  }
  const normalizedHeader = headerName.toLowerCase();

  return ({ headers }) => {
    const supplied = headers[normalizedHeader];
    if (!supplied) {
      throw new PlatformApiError(
        401,
        "missing_admin_auth",
        `${normalizedHeader} header is required`,
      );
    }
    if (supplied !== token) {
      throw new PlatformApiError(403, "invalid_admin_auth", "invalid admin credentials");
    }
    return { admin: true, method: "static-token" };
  };
}

export function createPlatformAdminApi({
  admin,
  model,
  events,
  authorizeAdmin,
  options = {},
} = {}) {
  if (!authorizeAdmin) {
    throw new Error("createPlatformAdminApi requires an explicit authorizeAdmin hook");
  }
  if (!admin && !model && !events) {
    throw new Error("createPlatformAdminApi requires an admin adapter, model, or events");
  }

  return {
    async handle(request) {
      try {
        const normalized = normalizeRequest(request);
        const route = matchRoute(normalized.method, normalized.pathname);
        await authorizeAdmin({
          request,
          method: normalized.method,
          pathname: normalized.pathname,
          headers: normalized.headers,
        });

        const surfaces = await readSurfaces({ admin, model, events, options, route });

        switch (route.name) {
          case "dashboard":
            return ok({
              summary: surfaces.summary,
              sourceOfTruth: surfaces.sourceOfTruth,
              routes: PLATFORM_ADMIN_API_ROUTES,
            });
          case "objects":
            return ok({
              summary: surfaces.summary,
              objects: surfaces.objects,
            });
          case "object":
            return ok({
              object: findObjectDetail(surfaces, route.params.objectId),
            });
          case "usage":
            return ok({
              usage: surfaces.usage,
              summary: surfaces.summary,
            });
          case "datasets":
            return ok({
              datasets: surfaces.datasets,
              providers: surfaces.providers,
            });
          case "coordinators":
            return ok({
              coordinators: surfaces.coordinators,
              relayers: surfaces.relayers,
            });
          case "reconciliation":
            return ok({
              reconciliation: surfaces.reconciliation,
              sourceOfTruth: surfaces.sourceOfTruth,
            });
          default:
            throw new PlatformApiError(404, "not_found", "route not found");
        }
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

async function readSurfaces({ admin, model, events, options, route }) {
  if (typeof admin === "function") {
    return await admin({ route });
  }
  if (admin?.readAdminSurfaces) {
    return await admin.readAdminSurfaces({ route });
  }
  if (admin?.readSurfaces) {
    return await admin.readSurfaces({ route });
  }
  return buildAdminSurfaces({ model, events }, withDefaultNow(options));
}

function withDefaultNow(options) {
  if (options.now !== undefined && options.now !== null) return options;
  return {
    ...options,
    now: Math.floor(Date.now() / 1000),
  };
}

function findObjectDetail(surfaces, objectId) {
  const detail = surfaces.objectDetails.find((object) => object.objectId === objectId);
  if (!detail) {
    throw new PlatformApiError(404, "admin_object_not_found", "admin object not found", {
      objectId,
    });
  }
  return detail;
}

function normalizeRequest(request = {}) {
  const method = String(request.method ?? "").toUpperCase();
  const url = new URL(request.path ?? request.url ?? "/", "http://foc-platform.local");
  return {
    method,
    pathname: url.pathname.replace(/\/+$/, "") || "/",
    headers: normalizeHeaders(request.headers ?? {}),
  };
}

function normalizeHeaders(headers) {
  const normalized = {};
  if (headers && typeof headers.entries === "function") {
    for (const [key, value] of headers.entries()) {
      normalized[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    return normalized;
  }
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return normalized;
}

function matchRoute(method, pathname) {
  if (method === "GET" && pathname === "/admin/storage/dashboard") {
    return { name: "dashboard", params: {} };
  }
  if (method === "GET" && pathname === "/admin/storage/objects") {
    return { name: "objects", params: {} };
  }
  const object = pathname.match(/^\/admin\/storage\/objects\/([0-9]+)$/);
  if (method === "GET" && object) {
    return { name: "object", params: { objectId: object[1] } };
  }
  if (method === "GET" && pathname === "/admin/storage/usage") {
    return { name: "usage", params: {} };
  }
  if (method === "GET" && pathname === "/admin/storage/datasets") {
    return { name: "datasets", params: {} };
  }
  if (method === "GET" && pathname === "/admin/storage/coordinators") {
    return { name: "coordinators", params: {} };
  }
  if (method === "GET" && pathname === "/admin/storage/reconciliation") {
    return { name: "reconciliation", params: {} };
  }
  throw new PlatformApiError(404, "not_found", "route not found");
}

function ok(body) {
  return { status: 200, body: jsonSafe(body) };
}

function errorResponse(error) {
  if (error instanceof PlatformApiError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...jsonSafe(error.details),
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: error?.message ?? "internal error",
      },
    },
  };
}

function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}
