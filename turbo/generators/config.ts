import type { PlopTypes } from "@turbo/gen";
import * as fs from "node:fs";
import * as path from "node:path";

type PackageJson = {
  name: string;
  exports: Record<string, string | { types: string; import: string }>;
};

export default function generator(plop: PlopTypes.NodePlopAPI): void {
  plop.setGenerator("package", {
    description: "Scaffold a new package in packages/<name> (lib or ui)",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Package name (kebab-case, becomes @tix/<name>):",
        validate: (input: string) =>
          /^[a-z][a-z0-9-]*$/.test(input) || "Must be kebab-case starting with a letter",
      },
      {
        type: "list",
        name: "flavor",
        message: "Package flavor:",
        choices: ["lib", "ui"],
        default: "lib",
      },
    ],
    actions: (answers) => {
      const flavor = (answers?.["flavor"] as string | undefined) ?? "lib";
      const ext = flavor === "ui" ? "tsx" : "ts";
      const base = "packages/{{name}}";

      const actions: PlopTypes.ActionType[] = [
        {
          type: "add",
          path: `${base}/package.json`,
          templateFile: `templates/${flavor}/package.json.hbs`,
        },
        {
          type: "add",
          path: `${base}/tsconfig.json`,
          templateFile: `templates/${flavor}/tsconfig.json.hbs`,
        },
        {
          type: "add",
          path: `${base}/tsdown.config.ts`,
          templateFile: `templates/${flavor}/tsdown.config.ts.hbs`,
        },
        {
          type: "add",
          path: `${base}/vitest.config.ts`,
          templateFile: `templates/${flavor}/vitest.config.ts.hbs`,
        },
        {
          type: "add",
          path: `${base}/src/{{name}}.${ext}`,
          templateFile: `templates/${flavor}/starter.hbs`,
        },
        {
          type: "add",
          path: `${base}/src/{{name}}.test.${ext}`,
          templateFile: `templates/${flavor}/starter.test.hbs`,
        },
        {
          type: "add",
          path: `${base}/.gitignore`,
          templateFile: "templates/.gitignore.hbs",
        },
      ];

      if (flavor === "ui") {
        actions.push({
          type: "add",
          path: `${base}/src/styles.css`,
          templateFile: "templates/ui/styles.css.hbs",
        });
      }

      return actions;
    },
  });

  plop.setGenerator("export", {
    description: "Append a duck-file entry to a package's exports map",
    prompts: [
      {
        type: "input",
        name: "pkg",
        message: "Package directory under packages/ (e.g., contracts):",
        validate: (input: string) =>
          fs.existsSync(path.join("packages", input, "package.json")) ||
          `packages/${input}/package.json not found`,
      },
      {
        type: "input",
        name: "duck",
        message: "Duck filename (without extension, e.g., 'subjects'):",
        validate: (input: string) =>
          /^[a-z][a-z0-9-]*$/.test(input) || "Must be kebab-case starting with a letter",
      },
    ],
    actions: [
      (answers) => {
        const pkg = answers?.["pkg"] as string;
        const duck = answers?.["duck"] as string;
        const pkgPath = path.join("packages", pkg, "package.json");
        const json = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;
        json.exports[`./${duck}`] = {
          types: `./dist/${duck}.d.ts`,
          import: `./dist/${duck}.js`,
        };
        fs.writeFileSync(pkgPath, `${JSON.stringify(json, null, 2)}\n`);
        return `Added "./${duck}" to ${pkgPath}`;
      },
    ],
  });
}
