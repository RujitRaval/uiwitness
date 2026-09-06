import { describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  defineConfig,
  parseConfig,
  type UIWitnessConfig,
} from "../src/index.js";

function validConfig(): UIWitnessConfig {
  return {
    baseURL: "http://localhost:3000",
    failOn: {
      consoleError: false,
      failedRequest: false,
      pageError: true,
    },
    routes: [
      {
        id: "dashboard",
        path: "/dashboard",
        states: [
          {
            id: "success",
            setup: "./uiwitness/scenarios/dashboard/success.ts",
          },
          {
            id: "payment-declined",
            setup: "./uiwitness/scenarios/dashboard/payment-declined.ts",
          },
        ],
      },
    ],
    themes: ["light", "high-contrast"],
    viewports: {
      desktop: { height: 1000, width: 1440 },
      mobile: { height: 844, width: 390 },
    },
  };
}

function captureValidationError(input: unknown): ConfigValidationError {
  try {
    parseConfig(input);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return error as ConfigValidationError;
  }
  throw new Error("Expected config validation to fail.");
}

function credentialedURL(value: string): string {
  const url = new URL(value);
  url.username = "test-user";
  url.password = "test-password";
  return url.href;
}

describe("defineConfig", () => {
  it("provides typing without cloning or changing the config", () => {
    const config = validConfig();

    expect(defineConfig(config)).toBe(config);
  });
});

describe("parseConfig", () => {
  it("parses the documented configuration shape", () => {
    const config = validConfig();

    expect(parseConfig(config)).toEqual(config);
  });

  it("normalizes evidence defaults and accepts the selector length boundary", () => {
    const config = parseConfig({
      ...validConfig(),
      evidence: {
        masks: [{ id: "private", selector: "x".repeat(1_024) }],
      },
    });

    expect(config.evidence).toEqual({
      masks: [{
        id: "private",
        required: true,
        selector: "x".repeat(1_024),
      }],
      retention: "all",
    });
  });

  it.each([
    ["overlong selector", { id: "private", selector: "x".repeat(1_025) }, "$.evidence.masks[0].selector"],
    ["fractional count", { count: 1.5, id: "private", selector: "main" }, "$.evidence.masks[0].count"],
    ["non-boolean required", { id: "private", required: "yes", selector: "main" }, "$.evidence.masks[0].required"],
    ["duplicate route scope", { id: "private", routeIds: ["dashboard", "dashboard"], selector: "main" }, "$.evidence.masks[0].routeIds[1]"],
    ["unknown state", { id: "private", selector: "main", stateIds: ["missing"] }, "$.evidence.masks[0].stateIds[0]"],
    ["unknown property", { id: "private", selector: "main", telemetry: true }, "$.evidence.masks[0]"],
  ])("rejects evidence mask %s", (_label, mask, expectedPath) => {
    const error = captureValidationError({
      ...validConfig(),
      evidence: { masks: [mask] },
    });

    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expectedPath }),
    ]));
  });

  it("rejects a known state outside the mask's scoped routes", () => {
    const config = validConfig();
    const error = captureValidationError({
      ...config,
      evidence: {
        masks: [{
          id: "private",
          routeIds: ["dashboard"],
          selector: "main",
          stateIds: ["settings"],
        }],
      },
      routes: [
        ...config.routes,
        {
          id: "settings",
          path: "/settings",
          states: [{ id: "settings", setup: "./settings.mjs" }],
        },
      ],
    });

    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.evidence.masks[0].stateIds[0]" }),
    ]));
  });

  it("normalizes strict shared-read-only authentication origins", () => {
    const config = parseConfig({
      ...validConfig(),
      baseURL: "https://app.example.com",
      authentication: {
        additionalOrigins: ["https://id.example.com"],
        cookieScopes: [{
          domain: ".example.com",
          partitionKeys: ["https://app.example.com:443"],
          pathPrefix: "/account",
          secure: "required",
        }],
        setup: "./uiwitness/auth.mjs",
      },
    });

    expect(config.authentication).toEqual({
      additionalOrigins: ["https://id.example.com:443"],
      cookieScopes: [{
        domain: ".example.com",
        partitionKeys: ["https://app.example.com:443"],
        pathPrefix: "/account",
        secure: "required",
      }],
      mode: "shared-readonly",
      setup: "./uiwitness/auth.mjs",
    });
  });

  it.each([
    {
      label: "non-object input",
      mutate: (): unknown => null,
      expected: { code: "invalid_type", path: "$" },
    },
    {
      label: "non-HTTP base URL",
      mutate: (): unknown => ({ ...validConfig(), baseURL: "file:///tmp/app" }),
      expected: { code: "invalid_value", path: "$.baseURL" },
    },
    {
      label: "malformed base URL",
      mutate: (): unknown => ({ ...validConfig(), baseURL: "not a URL" }),
      expected: { code: "invalid_value", path: "$.baseURL" },
    },
    {
      label: "authenticated base URL credentials",
      mutate: (): unknown => ({
        ...validConfig(),
        authentication: { setup: "./uiwitness/auth.mjs" },
        baseURL: credentialedURL("https://app.example.com"),
      }),
      expected: { code: "invalid_value", path: "$.baseURL" },
    },
    {
      label: "unknown authentication mode",
      mutate: (): unknown => ({
        ...validConfig(),
        authentication: {
          mode: "per-cell",
          setup: "./uiwitness/auth.mjs",
        },
      }),
      expected: { code: "invalid_value", path: "$.authentication.mode" },
    },
    {
      label: "authentication origin with a path",
      mutate: (): unknown => ({
        ...validConfig(),
        authentication: {
          additionalOrigins: ["https://id.example.com/login"],
          setup: "./uiwitness/auth.mjs",
        },
      }),
      expected: {
        code: "invalid_value",
        path: "$.authentication.additionalOrigins[0]",
      },
    },
    {
      label: "public-suffix cookie scope",
      mutate: (): unknown => ({
        ...validConfig(),
        authentication: {
          cookieScopes: [{
            domain: ".github.io",
            pathPrefix: "/",
            secure: "required",
          }],
          setup: "./uiwitness/auth.mjs",
        },
      }),
      expected: {
        code: "invalid_value",
        path: "$.authentication.cookieScopes[0].domain",
      },
    },
    {
      label: "default-rule public-suffix cookie scope",
      mutate: (): unknown => ({
        ...validConfig(),
        baseURL: "https://app.unknown-suffix",
        authentication: {
          cookieScopes: [{
            domain: ".unknown-suffix",
            pathPrefix: "/",
            secure: "required",
          }],
          setup: "./uiwitness/auth.mjs",
        },
      }),
      expected: {
        code: "invalid_value",
        path: "$.authentication.cookieScopes[0].domain",
      },
    },
    {
      label: "invalid route ID",
      mutate: (): unknown => ({
        ...validConfig(),
        routes: [{ ...validConfig().routes[0], id: "Dashboard Route" }],
      }),
      expected: { code: "invalid_value", path: "$.routes[0].id" },
    },
    {
      label: "route path without a leading slash",
      mutate: (): unknown => ({
        ...validConfig(),
        routes: [{ ...validConfig().routes[0], path: "dashboard" }],
      }),
      expected: { code: "invalid_value", path: "$.routes[0].path" },
    },
    {
      label: "protocol-relative route path",
      mutate: (): unknown => ({
        ...validConfig(),
        routes: [{ ...validConfig().routes[0], path: "//other.example/dashboard" }],
      }),
      expected: { code: "invalid_value", path: "$.routes[0].path" },
    },
    {
      label: "backslash authority route path",
      mutate: (): unknown => ({
        ...validConfig(),
        routes: [{ ...validConfig().routes[0], path: "/\\evil.example/dashboard" }],
      }),
      expected: { code: "invalid_value", path: "$.routes[0].path" },
    },
    {
      label: "empty scenario setup path",
      mutate: (): unknown => ({
        ...validConfig(),
        routes: [
          {
            ...validConfig().routes[0],
            states: [{ id: "success", setup: "  " }],
          },
        ],
      }),
      expected: { code: "invalid_value", path: "$.routes[0].states[0].setup" },
    },
    {
      label: "fractional viewport dimension",
      mutate: (): unknown => ({
        ...validConfig(),
        viewports: { mobile: { height: 844, width: 390.5 } },
      }),
      expected: { code: "invalid_type", path: "$.viewports.mobile.width" },
    },
    {
      label: "unknown root property",
      mutate: (): unknown => ({ ...validConfig(), telemetry: true }),
      expected: { code: "unrecognized_key", path: "$" },
    },
  ])("rejects $label with a stable issue", ({ mutate, expected }) => {
    const error = captureValidationError(mutate());

    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toBe("Invalid UIWitness configuration.");
    expect(error.issues).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
  });

  it.each([
    ["routes", { routes: [] }, "$.routes"],
    ["themes", { themes: [] }, "$.themes"],
    ["viewports", { viewports: {} }, "$.viewports"],
    [
      "route states",
      { routes: [{ id: "dashboard", path: "/dashboard", states: [] }] },
      "$.routes[0].states",
    ],
  ])("requires non-empty %s", (_label, replacement, expectedPath) => {
    const error = captureValidationError({ ...validConfig(), ...replacement });

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_value", path: expectedPath }),
      ]),
    );
  });

  it("reports duplicate route, state, and theme IDs at deterministic paths", () => {
    const firstRoute = validConfig().routes[0];
    if (firstRoute === undefined) {
      throw new Error("Fixture route is missing.");
    }
    const duplicatedRoute = {
      ...firstRoute,
      states: [firstRoute.states[0], firstRoute.states[0]],
    };
    const error = captureValidationError({
      ...validConfig(),
      baseURL: "https://app.example.com",
      routes: [duplicatedRoute, duplicatedRoute],
      themes: ["light", "light"],
    });

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate", path: "$.routes[0].states[1].id" }),
        expect.objectContaining({ code: "duplicate", path: "$.routes[1].id" }),
        expect.objectContaining({ code: "duplicate", path: "$.themes[1]" }),
      ]),
    );
  });

  it("reports duplicate normalized authentication boundaries", () => {
    const error = captureValidationError({
      ...validConfig(),
      baseURL: "https://app.example.com",
      authentication: {
        additionalOrigins: [
          "https://id.example.com",
          "https://id.example.com:443",
        ],
        cookieScopes: [
          { domain: ".example.com", pathPrefix: "/", secure: "required" },
          { domain: ".example.com", pathPrefix: "/", secure: "permitted" },
        ],
        setup: "./uiwitness/auth.mjs",
      },
    });

    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "duplicate",
        path: "$.authentication.additionalOrigins[1]",
      }),
      expect.objectContaining({
        code: "duplicate",
        path: "$.authentication.cookieScopes[1]",
      }),
    ]));
  });

  it("reports duplicate normalized partition origins", () => {
    const error = captureValidationError({
      ...validConfig(),
      authentication: {
        cookieScopes: [{
          domain: "localhost",
          partitionKeys: ["http://localhost", "http://localhost:80"],
          pathPrefix: "/",
          secure: "permitted",
        }],
        setup: "./uiwitness/auth.mjs",
      },
    });

    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "duplicate",
        path: "$.authentication.cookieScopes[0].partitionKeys[1]",
      }),
    ]));
  });

  it("rejects cookie scopes unrelated to every authenticated origin", () => {
    const error = captureValidationError({
      ...validConfig(),
      authentication: {
        cookieScopes: [{
          domain: "unrelated.example",
          pathPrefix: "/",
          secure: "required",
        }],
        setup: "./uiwitness/auth.mjs",
      },
    });

    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "invalid_value",
        path: "$.authentication.cookieScopes[0].domain",
      }),
    ]));
  });

  it.each(["   ", `./${"a".repeat(1_023)}`])(
    "rejects an unusable authentication setup path %j",
    (setup) => {
      const error = captureValidationError({
        ...validConfig(),
        authentication: { setup },
      });

      expect(error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_value",
          path: "$.authentication.setup",
        }),
      ]));
    },
  );

  it.each([
    ["additional origins", { additionalOrigins: [] }],
    ["cookie scopes", { cookieScopes: [] }],
    [
      "partition origins",
      {
        cookieScopes: [{
          domain: "localhost",
          partitionKeys: [],
          pathPrefix: "/",
          secure: "permitted",
        }],
      },
    ],
  ])("rejects empty authentication %s", (_label, authenticationValue) => {
    const error = captureValidationError({
      ...validConfig(),
      authentication: {
        ...authenticationValue,
        setup: "./uiwitness/auth.mjs",
      },
    });

    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_value" }),
    ]));
  });

  it("keeps every accepted route on the configured origin", () => {
    const config = parseConfig(validConfig());

    for (const route of config.routes) {
      expect(new URL(route.path, config.baseURL).origin).toBe(
        new URL(config.baseURL).origin,
      );
    }
  });

  it("freezes its public issue collection", () => {
    const error = captureValidationError(null);

    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(Object.isFrozen(error.issues[0])).toBe(true);
  });
});
