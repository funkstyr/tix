
# version_settings() enforces a minimum Tilt version
# https://docs.tilt.dev/api.html#api.version_settings
version_settings(constraint='>=0.33.11')
load('ext://helm_resource', 'helm_resource', 'helm_repo')

# nginx
k8s_yaml('./tooling/k8s/nginx-ingress.yaml')

k8s_resource(
    'ingress-nginx-controller',
    labels=['ingress']
)

k8s_resource(
    'ingress-nginx-admission-create',
    labels=['ingress']
)

k8s_resource(
    'ingress-nginx-admission-patch',
    labels=['ingress']
)

# supabase
k8s_yaml('./tooling/supabase/k8s/secrets.yaml')

k8s_yaml(helm(
    './tooling/supabase/charts',
    values=['./tooling/supabase/charts/values.example.yaml']
))

k8s_resource(
    'chart-supabase-auth',
    labels=['supabase']
)

k8s_resource(
    'chart-supabase-db',
    labels=['supabase']
)

k8s_resource(
    'chart-supabase-kong',
    labels=['supabase']
)

k8s_resource(
    'chart-supabase-meta',
    labels=['supabase']
)

k8s_resource(
    'chart-supabase-realtime',
    labels=['supabase']
)

k8s_resource(
    'chart-supabase-rest',
    labels=['supabase']
)

k8s_resource(
    'chart-supabase-storage',
    labels=['supabase']
)

k8s_resource(
    'chart-supabase-studio',
    labels=['supabase']
)

# live_update syncs changed source code files to the correct place
# https://docs.tilt.dev/api.html#api.docker_build
# https://docs.tilt.dev/live_update_reference.html
docker_build(
    'tix/auth-api',
    context='.',
    dockerfile='./tooling/docker/Dockerfile.hono.dev',
    build_args={
        'APP_NAME': 'auth-api',
    },
    live_update=[
        sync('./apps/auth-api/', '/app/apps/auth-api'),
    ]
)

# k8s_yaml automatically creates resources in Tilt for the entities
# and will inject any images referenced in the Tiltfile when deploying
# https://docs.tilt.dev/api.html#api.k8s_yaml
k8s_yaml('./apps/auth-api/infra/k8s/auth-api.yaml')

# k8s_resource allows customization where necessary such as adding port forwards and labels
# https://docs.tilt.dev/api.html#api.k8s_resource
k8s_resource(
    'auth-api-depl',
    port_forwards='4010:8787',
    labels=['api']
)

# config.main_path is the absolute path to the Tiltfile being run
# there are many Tilt-specific built-ins for manipulating paths, environment variables, parsing JSON/YAML, and more!
# https://docs.tilt.dev/api.html#api.config.main_path
tiltfile_path = config.main_path

# print writes messages to the (Tiltfile) log in the Tilt UI
# the Tiltfile language is Starlark, a simplified Python dialect, which includes many useful built-ins
# config.tilt_subcommand makes it possible to only run logic during `tilt up` or `tilt down`
# https://github.com/bazelbuild/starlark/blob/master/spec.md#print
# https://docs.tilt.dev/api.html#api.config.tilt_subcommand
if config.tilt_subcommand == 'up':
    print("""
    \033[32m\033[32mTix Dev k8s\033[0m

    using `{tiltfile}`
    """.format(tiltfile=tiltfile_path))