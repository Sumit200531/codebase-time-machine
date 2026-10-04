import { describe, expect, it } from "vitest";
import { extractImports, resolveImport } from "../src/index.ts";

describe("extractImports", () => {
  it("finds JS/TS import forms and ignores commented-out ones", () => {
    const source = `
      import a from "./a";
      import type { B } from '../b.js';
      import * as c from "pkg-c";
      export { d } from "./d";
      import "./side-effect";
      const e = require("@scope/e/sub");
      const f = await import("./lazy");
      // import nope from "./commented";
      /* import alsoNope from "./block"; */
      const url = "https://example.com"; import g from "./after-url";
    `;
    expect(extractImports("src/x.ts", source).sort()).toEqual(
      ["../b.js", "./a", "./after-url", "./d", "./lazy", "./side-effect", "@scope/e/sub", "pkg-c"].sort(),
    );
  });

  it("finds Python imports", () => {
    const source = "import os, json\nfrom .models import User\nfrom ..core.db import session\n# import commented\n";
    expect(extractImports("app/api/views.py", source).sort()).toEqual(["..core.db", ".models", "json", "os"]);
  });

  it("ignores languages without import support", () => {
    expect(extractImports("README.md", "import x from 'y'")).toEqual([]);
  });
});

describe("resolveImport", () => {
  const files = new Set(["src/a.ts", "src/b/index.ts", "src/c.ts", "app/models.py", "app/core/__init__.py"]);
  const exists = (path: string) => files.has(path);

  it("resolves relative JS specifiers with extension and index fallbacks", () => {
    expect(resolveImport("src/main.ts", "./a", exists)).toEqual({ kind: "internal", path: "src/a.ts" });
    expect(resolveImport("src/main.ts", "./b", exists)).toEqual({ kind: "internal", path: "src/b/index.ts" });
    expect(resolveImport("src/main.ts", "./c.js", exists)).toEqual({ kind: "internal", path: "src/c.ts" });
    expect(resolveImport("src/main.ts", "./missing", exists)).toBeNull();
    expect(resolveImport("main.ts", "../../escape", exists)).toBeNull();
  });

  it("classifies packages and skips Node built-ins", () => {
    expect(resolveImport("src/main.ts", "@scope/pkg/deep", exists)).toEqual({ kind: "external", name: "@scope/pkg" });
    expect(resolveImport("src/main.ts", "lodash/fp", exists)).toEqual({ kind: "external", name: "lodash" });
    expect(resolveImport("src/main.ts", "node:fs", exists)).toBeNull();
    expect(resolveImport("src/main.ts", "path", exists)).toBeNull();
  });

  it("resolves Python relative and package imports", () => {
    expect(resolveImport("app/views.py", ".models", exists)).toEqual({ kind: "internal", path: "app/models.py" });
    expect(resolveImport("app/views.py", "app.core", exists)).toEqual({ kind: "internal", path: "app/core/__init__.py" });
    expect(resolveImport("app/views.py", "requests", exists)).toEqual({ kind: "external", name: "requests" });
  });
});
