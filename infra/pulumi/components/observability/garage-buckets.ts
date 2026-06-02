import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// The Garage server image is a shell-less scratch image, so the bootstrap can't
// run the `garage` CLI in a script there. Instead this Job drives Garage's
// admin API (HTTP) with curl — `curlimages/curl` ships a busybox shell.
export const CURL_IMAGE = "curlimages/curl:8.20.0";

// Fixed k8s name for the bootstrap Job (and its script ConfigMap). The kind
// smoke gates on `job/garage-buckets` by this exact name, so it must not inherit
// the parent stack's component-name prefix (`tix-garage-buckets`) — this mirrors
// how the sibling backends fix their metadata names independent of the Pulumi
// resource name (e.g. `otel-collector`).
const JOB_NAME = "garage-buckets";

// The buckets Tempo/Loki/Pyroscope store into. A closed set so a typo is a
// compile error and a backend can only ask for a bucket this Job actually
// creates. (C4 wires the `pyroscope` bucket's actual creation + grant into the
// bootstrap Job; the type is widened here so PyroscopeBackend can name it.)
export type GarageBucketName = "tempo" | "loki" | "pyroscope";

export type GarageBucketsArgs = {
  namespace: pulumi.Input<string>;
  // Base URL of the Garage admin API, e.g. `http://garage:3903`.
  adminEndpoint: string;
  // Secret carrying GARAGE_ADMIN_TOKEN (bearer) + the S3 access key / secret to import.
  credentialsSecretName: pulumi.Input<string>;
  // Non-empty: the Job always has at least one bucket to create + grant.
  buckets: readonly [GarageBucketName, ...GarageBucketName[]];
  keyName: string;
};

// Provisions Garage buckets and the S3 access key Tempo/Loki use, idempotently
// on every `pulumi up`. The Garage analogue of `StreamBootstrap`/`PostgresRoles`:
// a one-shot Job that waits for the node to report healthy, creates each bucket,
// imports the predetermined access key, and grants it read/write/owner via the
// admin API. Tempo and Loki `dependsOn` this so their buckets and credentials
// exist before they boot.
export class GarageBuckets extends pulumi.ComponentResource {
  readonly configMap: k8s.core.v1.ConfigMap;
  readonly job: k8s.batch.v1.Job;

  constructor(name: string, args: GarageBucketsArgs, opts?: pulumi.ComponentResourceOptions) {
    super("tix:infra:GarageBuckets", name, args, opts);

    const childOpts: pulumi.ResourceOptions = { parent: this };

    this.configMap = new k8s.core.v1.ConfigMap(
      `${name}-script`,
      {
        metadata: { name: `${JOB_NAME}-script`, namespace: args.namespace },
        data: {
          "garage-init.sh": renderInitScript(args.adminEndpoint, args.buckets, args.keyName),
        },
      },
      childOpts,
    );

    this.job = new k8s.batch.v1.Job(
      `${name}-job`,
      {
        metadata: { name: JOB_NAME, namespace: args.namespace },
        spec: {
          backoffLimit: 5,
          ttlSecondsAfterFinished: 600,
          template: {
            metadata: {
              labels: {
                "app.kubernetes.io/name": JOB_NAME,
                "app.kubernetes.io/component": "bootstrap",
              },
            },
            spec: {
              restartPolicy: "OnFailure",
              containers: [
                {
                  name: "garage-init",
                  image: CURL_IMAGE,
                  command: ["sh", "/script/garage-init.sh"],
                  envFrom: [{ secretRef: { name: args.credentialsSecretName } }],
                  volumeMounts: [{ name: "script", mountPath: "/script" }],
                },
              ],
              volumes: [{ name: "script", configMap: { name: this.configMap.metadata.name } }],
            },
          },
        },
      },
      childOpts,
    );

    this.registerOutputs({ configMap: this.configMap, job: this.job });
  }
}

// Generated bootstrap script, run by curl against the Garage admin API. Idempotent:
// CreateBucket falls back to GetBucketInfo for the bucket id, and ImportKey
// tolerates an already-imported key — but only after confirming the key is in
// fact present, so a real failure (bad token, schema drift) still aborts rather
// than being swallowed. Each grant is read back to confirm it stuck. Auth is the
// GARAGE_ADMIN_TOKEN bearer; the S3 key comes from GARAGE_S3_ACCESS_KEY /
// GARAGE_S3_SECRET_KEY.
function renderInitScript(
  adminEndpoint: string,
  buckets: readonly GarageBucketName[],
  keyName: string,
): string {
  const perBucket = buckets
    .map(
      (b) => `
bucket_id="$(create_or_get_bucket ${b})"
if [ -z "$bucket_id" ]; then
  echo "garage-buckets: could not resolve id for bucket ${b}" >&2
  exit 1
fi
api AllowBucketKey "{\\"bucketId\\":\\"$bucket_id\\",\\"accessKeyId\\":\\"$GARAGE_S3_ACCESS_KEY\\",\\"permissions\\":{\\"read\\":true,\\"write\\":true,\\"owner\\":true}}" >/dev/null
# Read the grant back: a 2xx that didn't actually attach the key would otherwise
# surface only later as opaque S3 AccessDenied errors in Tempo/Loki.
if ! curl -fsS "$ADMIN/v2/GetBucketInfo?globalAlias=${b}" -H "$AUTH" 2>/dev/null | grep -q "$GARAGE_S3_ACCESS_KEY"; then
  echo "garage-buckets: grant for $GARAGE_S3_ACCESS_KEY on ${b} did not stick" >&2
  exit 1
fi
echo "garage-buckets: granted ${keyName} on ${b} ($bucket_id)"`,
    )
    .join("\n");

  return `#!/bin/sh
# Generated by tix:infra:GarageBuckets. Idempotent. Drives the Garage admin API.
set -eu

ADMIN="${adminEndpoint}"
AUTH="Authorization: Bearer $GARAGE_ADMIN_TOKEN"

# POST helper: api <Endpoint> <json-body>
api() {
  curl -fsS -X POST "$ADMIN/v2/$1" -H "$AUTH" -H "Content-Type: application/json" -d "$2"
}

# Extract the first "id" field from a Garage JSON response. Garage pretty-prints
# JSON with whitespace after the colon, so the patterns tolerate it.
extract_id() {
  grep -oE '"id":[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]+)"$/\\1/'
}

# Wait until the node reports healthy (single-node layout auto-applies on boot).
i=0
until curl -fsS "$ADMIN/v2/GetClusterHealth" -H "$AUTH" 2>/dev/null | grep -qE '"status":[[:space:]]*"healthy"'; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "garage-buckets: Garage not healthy after 60s" >&2
    exit 1
  fi
  sleep 1
done

# Import the predetermined S3 key. ImportKey is not cleanly idempotent — on a
# rerun where the key already exists it errors — so tolerate failure only when
# the key is in fact already present; anything else (bad admin token, API schema
# drift) must abort instead of being masked by a blanket "|| true".
import_key() {
  if api ImportKey "{\\"accessKeyId\\":\\"$GARAGE_S3_ACCESS_KEY\\",\\"secretAccessKey\\":\\"$GARAGE_S3_SECRET_KEY\\",\\"name\\":\\"${keyName}\\"}" >/dev/null 2>&1; then
    return 0
  fi
  if curl -fsS "$ADMIN/v2/GetKeyInfo?id=$GARAGE_S3_ACCESS_KEY" -H "$AUTH" >/dev/null 2>&1; then
    return 0
  fi
  echo "garage-buckets: ImportKey failed and key $GARAGE_S3_ACCESS_KEY is absent" >&2
  return 1
}
import_key
echo "garage-buckets: key ${keyName} present"

# Create the bucket if absent, else look it up; echo its id.
create_or_get_bucket() {
  id="$(api CreateBucket "{\\"globalAlias\\":\\"$1\\"}" 2>/dev/null | extract_id)"
  if [ -z "$id" ]; then
    id="$(curl -fsS "$ADMIN/v2/GetBucketInfo?globalAlias=$1" -H "$AUTH" 2>/dev/null | extract_id)"
  fi
  echo "$id"
}
${perBucket}

echo "garage-buckets: ok"
`;
}
