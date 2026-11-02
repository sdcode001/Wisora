import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  {
    // Architecture guard: production code must never construct a storage
    // backend directly — it would silently bypass the configured backend
    // (MongoDB on serverless, files locally). Route/lib code goes through
    // getMemoryStore(); only the factory and tests may construct backends.
    files: ["app/**/*.ts", "lib/**/*.ts", "instrumentation.ts"],
    ignores: [
      "**/*.test.ts",
      "lib/memory/get-store.ts",
      "app/api/memory/test-helpers.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "NewExpression[callee.name='FileMemoryStore'], NewExpression[callee.name='MongoMemoryStore'], NewExpression[callee.name='MongoClient']",
          message:
            "Constructing a storage backend directly bypasses the configured backend. Use getMemoryStore() from lib/memory/get-store instead.",
        },
      ],
    },
  },
]);

export default eslintConfig;
