import * as pulumi from "@pulumi/pulumi";

// Shared test scaffolding for the component specs. Importing this module
// installs Pulumi's in-process mocks (vitest isolates module state per test
// file, so each spec gets its own registration) and exposes `promiseOf` for
// awaiting a resource Output. Keeps the identical setup out of every *.test.ts.
pulumi.runtime.setMocks({
  newResource: (args: pulumi.runtime.MockResourceArgs) => ({
    id: `${args.name}-id`,
    state: args.inputs,
  }),
  call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
});

export function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply(resolve));
}
